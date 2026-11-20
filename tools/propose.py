"""Suggest days, times and deals from the text around a happy hour mention (a person reviews every suggestion)."""
import re
DAYN = {'mon':0,'tue':1,'wed':2,'thu':3,'fri':4,'sat':5,'sun':6}
DAYW = r'(mon(?:day)?s?|tue(?:s(?:day)?)?s?|wed(?:nesday)?s?|thu(?:r(?:s(?:day)?)?)?s?|fri(?:day)?s?|sat(?:urday)?s?|sun(?:day)?s?)'
SEP = r'\s*(?:-|–|—|to|thru|through|until|till)\s*'
T = r'(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?'
TR = re.compile(T + SEP + T, re.I)
DR = re.compile(r'\b' + DAYW + SEP + DAYW + r'\b', re.I)
D1 = re.compile(r'\b' + DAYW + r'\b', re.I)
def dnum(w): return DAYN[w.lower()[:3]]
def tmin(h, m, ap, other_ap=None):
    h = int(h); m = int(m or 0)
    ap = (ap or other_ap or '').lower().replace('.', '')
    if ap.startswith('p') and h < 12: h += 12
    if ap.startswith('a') and h == 12: h = 0
    if not ap and h <= 11: h += 12   # bare "4-6" in a happy hour context means pm
    return h * 60 + m
def days_in(s):
    s2 = s.lower()
    if re.search(r'\b(daily|every ?day|7 days|seven days|all week)\b', s2): return list(range(7))
    out = set()
    if re.search(r'\bweekdays?\b|\bm\s*-\s*f\b|\bmon\s*-\s*fri\b', s2): out |= {0,1,2,3,4}
    for a, b in DR.findall(s):
        i, j = dnum(a), dnum(b); k = i
        while True:
            out.add(k)
            if k == j: break
            k = (k + 1) % 7
    if not out:
        for w in D1.findall(s): out.add(dnum(w))
    return sorted(out)
def fmt(m): return f'{m//60:02d}:{m%60:02d}' if m < 1440 else '23:59'
def label(ds):
    names = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
    if len(ds) == 7: return 'Daily'
    if not ds: return ''
    s = set(ds); starts = [d for d in ds if (d - 1) % 7 not in s]
    if len(starts) == 1:
        a = starts[0]; b = a
        while (b + 1) % 7 in s and (b + 1) % 7 != a: b = (b + 1) % 7
        return names[a] if a == b else f'{names[a]}-{names[b]}'
    return ','.join(names[d] for d in ds)
DEAL = re.compile(r'(\$\s?\d+(?:\.\d{1,2})?\s*(?:off\s+)?[A-Za-z][A-Za-z&\'’\- ]{2,40}|half[- ]?(?:price|off)\s+[A-Za-z][A-Za-z&\'’\- ]{2,30}|\d{1,2}% off\s+[A-Za-z][A-Za-z\- ]{2,30}|\$?\d+¢\s+[A-Za-z][A-Za-z\- ]{2,30})', re.I)
HAPPY = re.compile(r'happy\s*-?\s*hours?', re.I)
def propose(rec):
    best = None
    for sn in rec['snippets']:
        t = sn['text']
        for m in HAPPY.finditer(t):
            win = t[max(0, m.start() - 120): m.end() + 260]
            tr = TR.search(win)
            if not tr: continue
            h1, m1, a1, h2, m2, a2 = tr.groups()
            st = tmin(h1, m1, a1, a2); en = tmin(h2, m2, a2, a1)
            if en <= st or en - st > 300 or st < 11*60: continue
            ds = days_in(win)
            score = (2 if ds else 0) + (1 if a1 or a2 else 0)
            if not best or score > best[0]:
                deals = []
                for d in DEAL.findall(t[m.start(): m.start() + 700]):
                    d = re.sub(r'\s+', ' ', d).strip(' -')
                    if d.lower() not in [x.lower() for x in deals]: deals.append(d)
                best = (score, label(ds), fmt(st), fmt(en), deals[:8], sn['page'], win)
    return best
