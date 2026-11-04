"""
Visit each bar's website and collect what it says about happy hour.

    python tools/scan_happy_hours.py tools/confirmed-websites.csv happy-hour-scan.jsonl

For each site: the home page plus up to 6 same-site pages whose link looks like
happy hour, specials, drinks, menu or bar. Saves text around every "happy hour"
mention, and lists any PDF menus it links to.
"""
import csv
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

IN, OUT = sys.argv[1], sys.argv[2]
UA = {'User-Agent': 'Mozilla/5.0 (compatible; 215HappyHourBot/1.0; +https://215happyhour.com)'}
LINK_HINT = re.compile(r'happy|hh\b|special|drink|cocktail|menu|bar\b|beverage|deal|late.?night', re.I)
HH = re.compile(r'happy\s*-?\s*hours?|\bhh\b|half[- ]?price|\$\d', re.I)
HAPPY = re.compile(r'happy\s*-?\s*hours?', re.I)


def get(url):
    try:
        r = requests.get(url, headers=UA, timeout=15, allow_redirects=True)
        ctype = r.headers.get('content-type', '')
        if r.status_code >= 400 or 'html' not in ctype:
            return None, r.url, ctype
        return r.text, r.url, ctype
    except Exception as e:  # network errors, bad certs, timeouts
        return None, url, f'error: {type(e).__name__}'


def text_of(html):
    soup = BeautifulSoup(html, 'html.parser')
    for t in soup(['script', 'style', 'noscript', 'svg']):
        t.decompose()
    txt = soup.get_text(' ', strip=True)
    return re.sub(r'\s+', ' ', txt), soup


def windows(txt, n=4, width=450):
    out, last = [], -10**9
    for m in HAPPY.finditer(txt):
        if m.start() - last < width:
            continue
        last = m.start()
        out.append(txt[max(0, m.start() - 150): m.start() + width])
        if len(out) >= n:
            break
    return out


def scan(row):
    try:
        return _scan(row)
    except Exception as e:  # never let one odd site stop the whole run
        return {'row': row['row'], 'name': row['name'], 'website': row['website'], 'ok': False,
                'pages': [], 'snippets': [], 'pdfs': [], 'error': f'error: {type(e).__name__}'}


def _scan(row):
    url = row['website'].strip()
    if not url.startswith('http'):
        url = 'http://' + url
    rec = {'row': row['row'], 'name': row['name'], 'website': url, 'ok': False,
           'pages': [], 'snippets': [], 'pdfs': [], 'error': ''}
    html, final, info = get(url)
    if not html:
        rec['error'] = info
        return rec
    rec['ok'] = True
    host = urlparse(final).netloc.replace('www.', '')
    txt, soup = text_of(html)
    rec['pages'].append(final)
    rec['snippets'] += [{'page': final, 'text': s} for s in windows(txt)]
    links = []
    for a in soup.find_all('a', href=True):
        try:
            href = urljoin(final, a['href'])
            p = urlparse(href)
        except ValueError:
            continue
        label = (a.get_text(' ', strip=True) or '') + ' ' + href
        if href.lower().split('?')[0].endswith('.pdf') and (LINK_HINT.search(label) or HAPPY.search(label)):
            if href not in rec['pdfs']:
                rec['pdfs'].append(href)
            continue
        if p.netloc.replace('www.', '') != host or not LINK_HINT.search(label):
            continue
        href = href.split('#')[0]
        if href not in links and href != final:
            links.append(href)
    links.sort(key=lambda h: 0 if HAPPY.search(h) or 'special' in h.lower() else 1)
    for href in links[:6]:
        h2, f2, _ = get(href)
        if not h2:
            continue
        t2, _ = text_of(h2)
        rec['pages'].append(f2)
        rec['snippets'] += [{'page': f2, 'text': s} for s in windows(t2)]
        if len(rec['snippets']) >= 6:
            break
    rec['snippets'] = rec['snippets'][:6]
    return rec


rows = list(csv.DictReader(open(IN, encoding='utf-8')))
with ThreadPoolExecutor(max_workers=16) as pool, open(OUT, 'w', encoding='utf-8') as f:
    for rec in pool.map(scan, rows):
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')

recs = [json.loads(l) for l in open(OUT, encoding='utf-8')]
print(f'Sites: {len(recs)}  reachable: {sum(r["ok"] for r in recs)}  '
      f'mention happy hour: {sum(bool(r["snippets"]) for r in recs)}  '
      f'with PDF menus: {sum(bool(r["pdfs"]) for r in recs)}')
