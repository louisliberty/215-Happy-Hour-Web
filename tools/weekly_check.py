"""
Compare a fresh website scan with what the site lists.

    python tools/weekly_check.py happy-hour-scan.jsonl sheet.csv OUTDIR

Writes:
  OUTDIR/review.txt         bars whose website mentions happy hour but aren't listed yet,
                            with a suggested days/times/deals line and the text it came from
  OUTDIR/listed-check.csv   every listed bar: seen this week, missed, or site didn't load
Updates data/scan-misses.csv (consecutive weeks a listed bar's site loaded but showed no
happy hour) and prints the bars that have missed 2 weeks in a row.
"""
import datetime
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from common import HAPPY, addr_key, read_csv, read_scan, sheet_rows, site_key, write_csv  # noqa: E402
from propose import propose  # noqa: E402

SCAN, SHEET, OUTDIR = sys.argv[1], sys.argv[2], sys.argv[3]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
os.makedirs(OUTDIR, exist_ok=True)
today = datetime.date.today().isoformat()

scan = read_scan(SCAN)
sheet = sheet_rows(SHEET)
row_addr = {r['sheet_row']: r['address'] for r in sheet}
row_hood = {r['sheet_row']: r['neighborhood'] for r in sheet}
for r in read_csv(os.path.join(ROOT, 'tools', 'extra-websites.csv')):
    row_addr[r['row']] = r['address']
listed = read_csv(os.path.join(DATA, 'website-happy-hours.csv'))
for i, r in enumerate(listed):
    row_addr[f'L{i + 2}'] = r['address']
sheet_timed = {addr_key(r['address']) for r in sheet if r.get('days') and r.get('start')}
notes = {addr_key(r['address']): r for r in read_csv(os.path.join(DATA, 'review-notes.csv'))}

by_addr = {}
for rec in scan:
    by_addr.setdefault(addr_key(row_addr.get(rec['row'], '')), []).append(rec)
by_site = {site_key(rec['website']): rec for rec in scan}

# 1) listed bars: still showing a happy hour?
bars = {}
for r in listed:
    bars.setdefault((r['name'], addr_key(r['address'])), r)
misses_path = os.path.join(DATA, 'scan-misses.csv')
misses = {(m['name'], addr_key(m['address'])): m for m in read_csv(misses_path)} if os.path.exists(misses_path) else {}
check = []
for (name, ak), r in bars.items():
    recs = list(by_addr.get(ak, []))
    s = by_site.get(site_key(r['source_url']))
    if s and s not in recs:
        recs.append(s)
    if not recs:
        status = 'not scanned'
    elif any(any(HAPPY.search(x['text']) for x in rec['snippets']) for rec in recs):
        status = 'seen'
    elif any(rec['ok'] and not rec.get('thin') for rec in recs):
        status = 'missed'
    else:
        status = "site didn't load"
    m = misses.get((name, ak), {'name': name, 'address': r['address'], 'misses': '0', 'last_seen': r.get('verified', '')})
    if status == 'seen':
        m['misses'], m['last_seen'] = '0', today
    elif status == 'missed':
        m['misses'] = str(int(m.get('misses') or 0) + 1)
    misses[(name, ak)] = m
    check.append({'name': name, 'address': r['address'], 'status': status, 'misses_in_a_row': m['misses'],
                  'last_seen': m['last_seen'], 'source_url': r['source_url']})
write_csv(misses_path, list(misses.values()), ['name', 'address', 'misses', 'last_seen'])
write_csv(os.path.join(OUTDIR, 'listed-check.csv'), check,
          ['name', 'address', 'status', 'misses_in_a_row', 'last_seen', 'source_url'])

# 2) not listed yet, but the website mentions happy hour
listed_keys = {k for _, k in bars} | sheet_timed
lines, n_new = [], 0
for rec in scan:
    if not rec['snippets'] or rec['row'].startswith('L'):
        continue
    ak = addr_key(row_addr.get(rec['row'], ''))
    if ak in listed_keys:
        continue
    p = propose(rec)
    note = notes.get(ak)
    if note and not (p and p[1]):
        continue  # reviewed before and still no days/times: skip
    n_new += 1
    ev = re.sub(r'\s+', ' ', p[6] if p else rec['snippets'][0]['text'])[:380]
    lines.append(f"[{rec['row']}] {rec['name']} | {row_addr.get(rec['row'], '')} | {row_hood.get(rec['row'], '')}\n"
                 f"  SITE: {p[5] if p else rec['snippets'][0]['page']}\n"
                 f"  SUGGESTED: {(p[1] + ' ' + p[2] + '-' + p[3]) if p else '(no times found)'} | {'; '.join(p[4][:6]) if p else ''}\n"
                 + (f"  EARLIER NOTE: {note['reason']} - {note['note']}\n" if note else '')
                 + f"  TEXT: {ev}\n")
open(os.path.join(OUTDIR, 'review.txt'), 'w', encoding='utf-8').write('\n'.join(lines))

counts = {}
for c in check:
    counts[c['status']] = counts.get(c['status'], 0) + 1
print(f'Listed bars: {len(check)} | ' + ', '.join(f'{k}: {v}' for k, v in sorted(counts.items())))
print(f'Not listed but mention happy hour (to review): {n_new} -> {OUTDIR}/review.txt')
drop = [c for c in check if int(c['misses_in_a_row']) >= 2]
print('Missed 2+ weeks in a row (remove from the site, add to the call list):')
for c in drop:
    print(f"  - {c['name']} | {c['address']} | last seen {c['last_seen']}")
if not drop:
    print('  (none)')
print('\nBefore editing data/website-happy-hours.csv: change days/times only when the source states them exactly '
      '(never round), prefer a dedicated happy hour page as source_url, and fill in deals when the page lists them. See README.')
