"""
Build the list of every bar website to scan.

    python tools/make_website_list.py sheet.csv tools/all-websites.csv

Sources: the Google Sheet (website, or suggested website when the map shows a
different name), tools/extra-websites.csv (bars not in the sheet under a usable
name), and the source page of every listed happy hour. Private clubs and delis
are skipped. Each website appears once.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from common import SKIP_TYPES, read_csv, sheet_rows, sheet_website, site_key, write_csv  # noqa: E402

SHEET, OUT = sys.argv[1], sys.argv[2]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
seen, out = set(), []


def add(row, name, address, url):
    if not url:
        return
    k = site_key(url)
    if k in seen:
        return
    seen.add(k)
    out.append({'row': row, 'name': name, 'address': address, 'website': url})


for r in sheet_rows(SHEET):
    if r.get('type') in SKIP_TYPES or (r.get('status') or '').lower() == 'closed':
        continue
    name = r['suggested name'] if not r.get('website') and r.get('suggested name') else r['name']
    add(r['sheet_row'], name, r['address'], sheet_website(r))
for r in read_csv(os.path.join(ROOT, 'tools', 'extra-websites.csv')):
    add(r['row'], r['name'], r['address'], r['website'])
for i, r in enumerate(read_csv(os.path.join(ROOT, 'data', 'website-happy-hours.csv'))):
    add(f'L{i + 2}', r['name'], r['address'], r['source_url'])
write_csv(OUT, out, ['row', 'name', 'address', 'website'])
print(f'{len(out)} websites to scan -> {OUT}')
