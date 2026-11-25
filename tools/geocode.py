"""
Look up map coordinates for every listed bar (for "nearby happy hours").

    python tools/geocode.py venues.csv data/coords.csv

venues.csv has name,address (build.js writes it when LIST_VENUES is set).
Uses the free US Census geocoder. Addresses already in data/coords.csv are kept
and not looked up again. Output columns: address,lat,lng,match.
"""
import csv
import io
import os
import re
import sys

import requests

sys.path.insert(0, os.path.dirname(__file__))
from common import addr_key, read_csv, write_csv  # noqa: E402

IN, OUT = sys.argv[1], sys.argv[2]
URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch'

have = {addr_key(r['address']): r for r in read_csv(OUT)} if os.path.exists(OUT) else {}
todo = {}
for r in read_csv(IN):
    k = addr_key(r['address'])
    if k and k not in have and k not in todo:
        todo[k] = r['address']


def clean(a):
    a = a.split(',')[0]
    a = re.sub(r'^(\d+)[a-z]?\s*-\s*\d+[a-z]?\b', r'\1', a.strip(), flags=re.I)   # 14-18 N Front St -> 14 N Front St
    a = re.sub(r'\s(ste|suite|unit|fl|floor|space|#)\b.*$', '', a, flags=re.I)
    return a


print(f'{len(have)} already located, {len(todo)} to look up')
keys = list(todo)
for i in range(0, len(keys), 1000):
    chunk = keys[i:i + 1000]
    buf = io.StringIO()
    w = csv.writer(buf)
    for n, k in enumerate(chunk):
        w.writerow([n, clean(todo[k]), 'Philadelphia', 'PA', ''])
    resp = requests.post(URL, files={'addressFile': ('a.csv', buf.getvalue())},
                         data={'benchmark': 'Public_AR_Current'}, timeout=300)
    resp.raise_for_status()
    for row in csv.reader(io.StringIO(resp.text)):
        if len(row) < 6 or row[2] != 'Match':
            continue
        k = chunk[int(row[0])]
        lng, lat = row[5].split(',')
        have[k] = {'address': todo[k], 'lat': f'{float(lat):.6f}', 'lng': f'{float(lng):.6f}', 'match': row[3].lower()}

write_csv(OUT, sorted(have.values(), key=lambda r: r['address']), ['address', 'lat', 'lng', 'match'])
missing = [todo[k] for k in keys if k not in have]
print(f'Located {len(have)} addresses; not found: {len(missing)}')
for a in missing:
    print('  - ' + a)
