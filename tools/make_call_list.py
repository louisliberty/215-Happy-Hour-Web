"""
Build the Call Agent workbook.

    python tools/make_call_list.py sheet.csv happy-hour-scan.jsonl OUT.xlsx

Tabs:
  How to use     what the list is and how to fill it in
  To call        licensed bars that are NOT listed (no happy hour online), with the reason
  Verify listed  bars that ARE listed, with what we show, so the agent can confirm it
Private clubs and take-out beer delis are left out.
"""
import datetime
import os
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

sys.path.insert(0, os.path.dirname(__file__))
from common import HAPPY, SKIP_TYPES, addr_key, read_csv, read_scan, sheet_rows, sheet_website, site_key  # noqa: E402

SHEET, SCAN, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
today = datetime.date.today().isoformat()
DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

sheet = sheet_rows(SHEET)
scan = read_scan(SCAN)
by_site = {site_key(r['website']): r for r in scan}
listed = read_csv(os.path.join(DATA, 'website-happy-hours.csv'))
notes = {addr_key(r['address']): r for r in read_csv(os.path.join(DATA, 'review-notes.csv'))}
specials = {addr_key(r['address']) for r in read_csv(os.path.join(DATA, 'daily-specials.csv'))}
phone_by_addr = {addr_key(r['address']): r.get('phone', '') for r in sheet if r.get('phone')}
row_by_addr = {}
for r in sheet:
    row_by_addr.setdefault(addr_key(r['address']), r)


def clock(t):
    h, m = (int(x) for x in t.split(':'))
    if h == 23 and m == 59:
        return 'midnight'
    ap = 'am' if h < 12 else 'pm'
    h12 = (h + 11) % 12 + 1
    return f'{h12}{":%02d" % m if m else ""}{ap}'


# ---------- Verify listed ----------
verify = {}
for r in listed:
    k = (r['name'], addr_key(r['address']))
    v = verify.setdefault(k, {'name': r['name'], 'neighborhood': r['neighborhood'], 'address': r['address'],
                              'phone': phone_by_addr.get(addr_key(r['address']), ''), 'where we found it': r['source_url'],
                              'hh': [], 'last_verified': r['verified']})
    v['hh'].append(f"{r['days']} {clock(r['start'])}-{clock(r['end'])}: {r['deals'].replace('|', '; ')}")
    v['last_verified'] = max(v['last_verified'], r['verified'])
for r in sheet:  # happy hours entered in the sheet (for example from earlier calls)
    if r.get('days') and r.get('start') and r.get('end'):
        k = (r['name'], addr_key(r['address']))
        v = verify.setdefault(k, {'name': r['name'], 'neighborhood': r['neighborhood'], 'address': r['address'],
                                  'phone': r.get('phone', ''), 'where we found it': 'Google Sheet', 'hh': [],
                                  'last_verified': r.get('last_checked', '')})
        v['hh'].append(f"{r['days']} {r['start']}-{r['end']}: {r.get('deals', '').replace('|', '; ')}")
verify_rows = []
for v in sorted(verify.values(), key=lambda x: (x['neighborhood'], x['name'])):
    verify_rows.append({**{k: v[k] for k in ('name', 'neighborhood', 'address', 'phone', 'where we found it')},
                        'what the site shows': '\n'.join(v['hh']), 'last_verified': v['last_verified']})
listed_keys = {addr_key(v['address']) for v in verify.values()} | {v['name'].lower() for v in verify.values()}

# ---------- To call ----------
to_call = []
for r in sheet:
    if r.get('type') in SKIP_TYPES or (r.get('status') or '').lower() in ('closed', 'no hh'):
        continue
    ak = addr_key(r['address'])
    if ak in listed_keys or r['name'].lower() in listed_keys:
        continue
    url = sheet_website(r)
    note = notes.get(ak)
    if note:
        reason, detail = note['reason'], note['note']
    elif not url:
        reason, detail = 'No website found', ''
    else:
        s = by_site.get(site_key(url))
        if not s:
            reason, detail = 'Website not checked', ''
        elif not s['ok']:
            reason, detail = 'Website would not load', s.get('error', '')
        elif any(HAPPY.search(x['text']) for x in s['snippets']):
            reason, detail = 'Website mentions happy hour, but not when', ''
        else:
            reason, detail = 'Website has no happy hour info', ''
    flags = []
    if 'name on the sign' in (r.get('notes') or ''):
        flags.append("Name on file is a company name; ask for the bar's name")
    if (r.get('result') or '').startswith('Different') and r.get('suggested name'):
        flags.append(f'Maps lists "{r["suggested name"]}" at this address')
    if 'CLOSED' in (r.get('note') or ''):
        flags.append('Maps says permanently closed; confirm first')
    if ak in specials:
        flags.append('Posts daily specials online, but no happy hour times')
    to_call.append({'priority': int(r.get('priority') or 3), 'name': r['name'], 'neighborhood': r['neighborhood'],
                    'address': r['address'], 'zip': r.get('zip', ''), 'phone': r.get('phone', ''), 'website': url,
                    'why they are not listed': reason, 'detail': detail, 'flags': '; '.join(flags),
                    'manager on license': r.get('contact_name', ''), 'license_no': r.get('license_no', ''),
                    'sheet_row': int(r['sheet_row'])})
for r in read_csv(os.path.join(ROOT, 'tools', 'extra-websites.csv')):
    ak = addr_key(r['address'])
    if ak in listed_keys or r['name'].lower() in listed_keys or ak in row_by_addr:
        continue
    s = by_site.get(site_key(r['website']))
    reason = ("Website would not load" if s and not s['ok'] else
              'Website mentions happy hour, but not when' if s and any(HAPPY.search(x['text']) for x in s['snippets']) else
              'Website has no happy hour info')
    note = notes.get(ak)
    to_call.append({'priority': 1, 'name': r['name'], 'neighborhood': 'Fishtown', 'address': r['address'], 'zip': '19125',
                    'phone': '', 'website': r['website'], 'why they are not listed': note['reason'] if note else reason,
                    'detail': note['note'] if note else '', 'flags': 'Not in the PLCB sheet under this name',
                    'manager on license': '', 'license_no': '', 'sheet_row': ''})
to_call.sort(key=lambda x: (x['priority'], x['neighborhood'], x['name']))

# ---------- workbook ----------
F = 'Arial'
HEAD = PatternFill('solid', fgColor='4F6B34')
INHEAD = PatternFill('solid', fgColor='B86E0E')
INPUT = PatternFill('solid', fgColor='FFF7D6')


def sheet_tab(wb, title, rows, cols, widths, inputs, choices):
    ws = wb.create_sheet(title)
    allc = cols + inputs
    ws.append(allc)
    for r in rows:
        ws.append([r.get(c, '') for c in cols] + [''] * len(inputs))
    for i, c in enumerate(allc, 1):
        cell = ws.cell(1, i)
        cell.font = Font(name=F, bold=True, color='FFFFFF')
        cell.fill = INHEAD if c in inputs else HEAD
        ws.column_dimensions[get_column_letter(i)].width = widths.get(c, 14)
    n = len(rows) + 1
    for row in ws.iter_rows(min_row=2, max_row=n):
        for c in row:
            c.font = Font(name=F, size=10)
            c.alignment = Alignment(vertical='top', wrap_text=allc[c.column - 1] == 'what the site shows')
            if allc[c.column - 1] in inputs:
                c.fill = INPUT
    for c, opts in choices.items():
        col = get_column_letter(allc.index(c) + 1)
        dv = DataValidation(type='list', formula1='"' + ','.join(opts) + '"', allow_blank=True)
        ws.add_data_validation(dv)
        dv.add(f'{col}2:{col}{n + 500}')
    ws.freeze_panes = 'C2'
    ws.auto_filter.ref = f'A1:{get_column_letter(len(allc))}{n}'
    return ws


wb = Workbook()
guide = wb.active
guide.title = 'How to use'
call_cols = ['priority', 'name', 'neighborhood', 'address', 'zip', 'phone', 'website', 'why they are not listed', 'detail',
             'flags', 'manager on license', 'license_no', 'sheet_row']
call_inputs = ['call_result', 'happy_hour_days', 'start', 'end', 'specials', 'ok_to_list', 'called_on']
sheet_tab(wb, 'To call', to_call, call_cols,
          {'priority': 8, 'name': 32, 'neighborhood': 24, 'address': 30, 'zip': 7, 'phone': 15, 'website': 34,
           'why they are not listed': 38, 'detail': 40, 'flags': 44, 'manager on license': 22, 'license_no': 11,
           'sheet_row': 9, 'call_result': 18, 'happy_hour_days': 16, 'start': 8, 'end': 8, 'specials': 40,
           'ok_to_list': 10, 'called_on': 12},
          call_inputs,
          {'call_result': ['has happy hour', 'no happy hour', 'call back', 'no answer', 'wrong number', 'closed', 'declined'],
           'ok_to_list': ['yes', 'no']})
ver_cols = ['name', 'neighborhood', 'address', 'phone', 'what the site shows', 'last_verified', 'where we found it']
ver_inputs = ['verify_result', 'correct_days', 'correct_start', 'correct_end', 'correct_specials', 'called_on']
sheet_tab(wb, 'Verify listed', verify_rows, ver_cols,
          {'name': 30, 'neighborhood': 24, 'address': 28, 'phone': 15, 'what the site shows': 70, 'last_verified': 12,
           'where we found it': 40, 'verify_result': 18, 'correct_days': 14, 'correct_start': 10, 'correct_end': 10,
           'correct_specials': 40, 'called_on': 12},
          ver_inputs,
          {'verify_result': ['correct', 'changed', 'no longer offered', 'closed', 'call back', 'no answer']})

reasons = {}
for r in to_call:
    reasons[r['why they are not listed']] = reasons.get(r['why they are not listed'], 0) + 1
with_phone = sum(1 for r in to_call if r['phone'])
ver_phone = sum(1 for r in verify_rows if r['phone'])
lines = [
    ('215 Happy Hour: Call Agent list', ''),
    ('Built', f'{today}, from the Google Sheet and a scan of every known bar website in Philadelphia County.'),
    ('To call tab', f'{len(to_call):,} licensed bars and restaurants that are NOT on 215happyhour.com because their happy hour is not published online. {with_phone:,} have a phone number on file.'),
    ('Verify listed tab', f'{len(verify_rows):,} bars that ARE listed. "What the site shows" is exactly what visitors see. Call to confirm it is still right. {ver_phone:,} have a phone number on file.'),
    ('Left off', 'Private clubs and take-out beer delis.'),
    ('Yellow columns', 'Fill these in on each call. Times are 24-hour (16:00). Separate specials with |.'),
    ('Example (To call)', 'has happy hour | Mon-Fri | 16:00 | 18:00 | $5 drafts|$7 house wine|half-price wings | yes | 2026-11-24'),
    ('Example (Verify listed)', 'changed | Mon-Fri | 16:00 | 19:00 | $5 drafts|$6 wine | 2026-11-24'),
    ('Getting answers on the site', 'Copy days, start, end and specials into that bar\'s row in the Google Sheet (sheet_row). Rows with times in the sheet go live within the hour and override what we found online. For "no longer offered" or "closed", set the sheet status to "no HH" or "closed".'),
    ('Priority', '1 = launch neighborhoods (Center City, Rittenhouse, Old City, Midtown, Fishtown, NoLibs, University City, Queen Village/Passyunk). 2 = next ring. 3 = rest of the city.'),
    ('Call script points', "Confirm the bar's name. Do you run a happy hour? Which days and times? What are the specials and prices? May we list it on 215happyhour.com? Tip: post it as text on your website and we'll keep it current automatically each week."),
    ('', ''),
    ('Why they are not listed', 'Bars'),
] + sorted(reasons.items(), key=lambda x: -x[1])
for a, b in lines:
    guide.append([a, b])
guide.column_dimensions['A'].width = 30
guide.column_dimensions['B'].width = 100
for row in guide.iter_rows():
    for c in row:
        c.font = Font(name=F, size=10, bold=c.column == 1)
        c.alignment = Alignment(wrap_text=True, vertical='top')
guide['A1'].font = Font(name=F, bold=True, size=14, color='4F6B34')
wb.save(OUT)
print(f'Call list: {len(to_call)} to call ({with_phone} with phone), {len(verify_rows)} to verify ({ver_phone} with phone) -> {OUT}')
