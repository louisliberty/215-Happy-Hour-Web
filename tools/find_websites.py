"""
Match 215 Happy Hour's bar list against Overture Maps places to find websites,
phones and social links.

    python tools/find_websites.py places.parquet tools/bars-input.csv websites-found.csv

places.parquet comes from:
    overturemaps download --bbox=-75.2803,39.8670,-74.9558,40.1379 -f geoparquet --type=place -o places.parquet
"""
import re
import sys
from difflib import SequenceMatcher

import numpy as np
import pandas as pd

PLACES, BARS, OUT = sys.argv[1], sys.argv[2], sys.argv[3]

SUFFIX = r'\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|pl|place|ct|court|pike|sq|square|way|ter|terrace|hwy|pkwy|parkway)\b'
DIRS = r'\b(n|s|e|w|north|south|east|west)\b'
NOISE = r'\b(the|and|restaurant|bar|grill|grille|tavern|pub|cafe|philadelphia|philly|llc|inc|co|company|kitchen|lounge|group|associates|partners|hospitality)\b'


def as_list(v):
    if v is None:
        return []
    if isinstance(v, float) and np.isnan(v):
        return []
    if isinstance(v, (list, tuple, np.ndarray)):
        return list(v)
    return [v]


def first(v):
    lst = as_list(v)
    return lst[0] if lst else None


def norm_name(s):
    s = (s or '').lower().replace('&', ' and ').replace("'", '').replace('’', '')
    s = re.sub(r'[^a-z0-9 ]', ' ', s)
    core = re.sub(NOISE, ' ', s)
    core = re.sub(r'\s+', ' ', core).strip()
    return core or re.sub(r'\s+', ' ', s).strip()


def parse_addr(a):
    """'1514-16 Sansom St 2nd Fl' -> ({1514, 1515, 1516}, 'sansom')"""
    a = (a or '').lower().split(',')[0]
    m = re.match(r'\s*(\d+)(?:\s*-\s*(\d+))?\s*[a-z]?\s+(.*)', a)
    if not m:
        return set(), ''
    lo = int(m.group(1))
    hi = lo
    if m.group(2):
        tail = m.group(2)
        hi = int(m.group(1)[: len(m.group(1)) - len(tail)] + tail) if len(tail) < len(m.group(1)) else int(tail)
        if hi < lo or hi - lo > 40:
            hi = lo
    street = m.group(3)
    street = re.sub(r'\b(\d+(st|nd|rd|th)|first|second|third|ground|lower|upper)\s+(fl|floor|level)\b.*', '', street)
    street = re.split(r'\b(ste|suite|unit|fl|floor|space|rear|apt|#)\b', street)[0]
    street = re.sub(DIRS, ' ', street)
    street = re.sub(SUFFIX, ' ', street)
    street = re.sub(r'[^a-z0-9 ]', ' ', street)
    street = re.sub(r'\b(\d+)(st|nd|rd|th)\b', r'\1', street)
    street = re.sub(r'\s+', ' ', street).strip()
    return set(range(lo, hi + 1)), street


def sim(a, b):
    a, b = norm_name(a), norm_name(b)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return max(0.85, SequenceMatcher(None, a, b).ratio())
    return SequenceMatcher(None, a, b).ratio()


# ---- load Overture places ----
df = pd.read_pickle(PLACES) if PLACES.endswith('.pkl') else pd.read_parquet(PLACES)
print(f'Overture places in Philadelphia box: {len(df):,}')
rows = []
for r in df.itertuples(index=False):
    d = r._asdict()
    names = d.get('names') or {}
    name = names.get('primary') if isinstance(names, dict) else None
    if not name:
        continue
    addr = first(d.get('addresses')) or {}
    freeform = addr.get('freeform') if isinstance(addr, dict) else ''
    postcode = (addr.get('postcode') or '')[:5] if isinstance(addr, dict) else ''
    cats = d.get('categories') or {}
    socials = [str(s) for s in as_list(d.get('socials'))]
    nums, street = parse_addr(freeform)
    rows.append({
        'p_name': name,
        'p_address': freeform or '',
        'p_zip': postcode,
        'p_nums': nums,
        'p_street': street,
        'category': cats.get('primary') if isinstance(cats, dict) else '',
        'website': first(d.get('websites')) or '',
        'phone': first(d.get('phones')) or '',
        'instagram': next((s for s in socials if 'instagram.com' in s), ''),
        'facebook': next((s for s in socials if 'facebook.com' in s), ''),
        'status': d.get('operating_status') or '',
        'confidence': round(float(d.get('confidence') or 0), 2),
    })
places = pd.DataFrame(rows)
by_street = {}
for i, s in enumerate(places.p_street):
    by_street.setdefault(s, []).append(i)
FOODISH = re.compile(r'bar|pub|restaurant|brew|wine|cocktail|lounge|tavern|food|pizza|cafe|grill|diner|hotel|night|club|distill|steak|sushi|taco|eatery|bistro', re.I)

# ---- match ----
bars = pd.read_csv(BARS, dtype=str).fillna('')
out = []
for b in bars.itertuples(index=False):
    nums, street = parse_addr(b.address)
    cands = []
    for i in by_street.get(street, []):
        pn = places.p_nums.iat[i]
        if nums and pn and (nums & pn or min(abs(x - y) for x in nums for y in pn) <= 2):
            cands.append(i)
    best, how = None, ''
    if cands:
        scored = sorted(((max(sim(b.name, places.p_name.iat[i]), sim(b.legal_name, places.p_name.iat[i])), places.confidence.iat[i], i) for i in cands), reverse=True)
        s, _, i = scored[0]
        if s >= 0.55:
            best, how = i, 'found'
        else:
            # same address, different name: often the real name on the sign
            food = [(sc, c, j) for sc, c, j in scored if FOODISH.search(str(places.category.iat[j]) + ' ' + places.p_name.iat[j])]
            if food:
                best, how = food[0][2], 'check: same address, different name'
    if best is None and b.zip:
        pool = places.index[places.p_zip == b.zip]
        scored = sorted(((sim(b.name, places.p_name.iat[i]), places.confidence.iat[i], i) for i in pool), reverse=True)[:1]
        if scored and scored[0][0] >= 0.9:
            best, how = scored[0][2], 'check: name matches, address differs'
    rec = {'row': b.row, 'name': b.name, 'address': b.address, 'match': how or 'not found'}
    if best is not None:
        p = places.iloc[best]
        rec.update({
            'name_on_map': p.p_name, 'website': p.website, 'instagram': p.instagram, 'facebook': p.facebook,
            'phone': p.phone, 'map_address': p.p_address, 'category': p.category,
            'operating_status': p.status, 'confidence': p.confidence,
        })
    out.append(rec)

res = pd.DataFrame(out)
res.to_csv(OUT, index=False)
print(res.match.value_counts().to_string())
print('with website:', (res.get('website', pd.Series(dtype=str)).fillna('') != '').sum())
