"""Shared helpers for the weekly happy hour check."""
import csv
import json
import re
from urllib.parse import urlparse

HAPPY = re.compile(r'happy\s*-?\s*hours?', re.I)


def addr_key(a):
    """'1201-05 Frankford Ave 109 East Girard Ave' and '1201 Frankford Avenue' -> '1201-frankford' (same rule as build.js)."""
    t = str(a or '').lower().split(',')[0]
    m = re.match(r'^\s*(\d+)[a-z]?(?:\s*-\s*\d+[a-z]?)?\s+(.*?)\b(street|st|avenue|ave|boulevard|blvd|road|rd|place|pl|lane|ln|way|drive|dr|pike|square|sq)\b', t)
    if m:
        t = f'{m.group(1)} {m.group(2)}'
    else:
        t = re.sub(r'\s(ste|suite|unit|fl|floor|space|#).*$', '', t)
    t = re.sub(r'\b(north|south|east|west)\b', lambda d: d.group(0)[0], t)
    return re.sub(r'[^a-z0-9]+', '-', t).strip('-')


def site_key(u):
    u = u if u.startswith('http') else 'http://' + u
    try:
        p = urlparse(u)
        return p.netloc.lower().replace('www.', '') + p.path.rstrip('/').lower()
    except ValueError:
        return u


def read_csv(path):
    with open(path, encoding='utf-8-sig') as f:
        return list(csv.DictReader(f))


def write_csv(path, rows, fields):
    with open(path, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        w.writeheader()
        w.writerows(rows)


def read_scan(path):
    return [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]


def sheet_rows(path):
    rows = read_csv(path)
    for i, r in enumerate(rows):
        r['sheet_row'] = str(i + 2)
    return rows


SKIP_TYPES = {'private club', 'deli / take-out?'}


def sheet_website(r):
    """The sheet's website, or the suggested one when the map listed a different name at that address."""
    if r.get('website'):
        return r['website']
    if (r.get('result') or '').startswith('Different') and r.get('suggested website'):
        return r['suggested website']
    return ''
