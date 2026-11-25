"""
Write the SQL that loads everything into Supabase: the Google Sheet's establishments,
the happy hours found on bar websites, map coordinates, bar descriptions and review notes.

    python tools/db_import.py sheet.csv import.sql          # full load (sheet + website happy hours)
    python tools/db_import.py --website-only import.sql     # only the repo's website happy hours, coordinates, descriptions
    psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f import.sql

--website-only runs on every push that changes those data files (e.g. the Monday check). It never
changes establishment details edited in Supabase; it only adds bars it doesn't know yet, fills in
missing coordinates, applies descriptions, and replaces happy hours whose source is 'website'.
To protect a website happy hour you corrected by hand in Supabase, set its source to 'manual'.

Safe to re-run. Establishments are matched by PLCB license number (or name + address
when there is none) and existing values are kept when the sheet cell is blank.
Happy hours from websites and from the sheet are replaced each run; ones entered
by hand in Supabase, from calls, or from owners are never touched.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from common import addr_key, read_csv, sheet_rows  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
WEBSITE_ONLY = sys.argv[1] == '--website-only'
SHEET, OUT = (None, sys.argv[2]) if WEBSITE_ONLY else (sys.argv[1], sys.argv[2])


def parse_days(s):
    s = (s or '').strip()
    if re.fullmatch(r'(?i)daily|every ?day|all', s):
        return DAYS[:]
    out = []
    for part in re.split(r'[,;/]+', s):
        ab = [x.strip()[:3].title() for x in re.split(r'[-–]', part)]
        if ab[0] not in DAYS:
            continue
        i = DAYS.index(ab[0])
        j = DAYS.index(ab[1]) if len(ab) > 1 and ab[1] in DAYS else i
        k = i
        while True:
            if DAYS[k] not in out:
                out.append(DAYS[k])
            if k == j:
                break
            k = (k + 1) % 7
    return sorted(out, key=DAYS.index)


def mins(t):
    m = re.fullmatch(r'(\d{1,2}):(\d{2})', (t or '').strip())
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def status_for(r):
    t, st, hh = (r.get('type') or '').lower(), (r.get('status') or '').lower(), (r.get('happy_hour') or '').lower()
    if 'closed' in st:
        return 'closed'
    if t == 'private club':
        return 'private'
    if t.startswith('deli'):
        return 'inactive'
    if hh in ('no', 'none', 'no hh'):
        return 'no_happy_hour'
    return 'to_research'


def q(v):
    """SQL literal."""
    if v is None:
        return 'null'
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, list):
        return 'array[' + ','.join(q(x) for x in v) + ']::text[]' if v else "'{}'::text[]"
    v = str(v).strip()
    return "'" + v.replace("'", "''") + "'" if v else 'null'


sheet = [] if WEBSITE_ONLY else sheet_rows(SHEET)
website_rows = read_csv(os.path.join(DATA, 'website-happy-hours.csv'))
coords = {addr_key(r['address']): r for r in read_csv(os.path.join(DATA, 'coords.csv'))}
notes = {addr_key(r['address']): r for r in read_csv(os.path.join(DATA, 'bar-notes.csv'))}
reviews = {addr_key(r['address']): r for r in read_csv(os.path.join(DATA, 'review-notes.csv'))}

est, hh, skipped, keys = [], [], [], set()


def add_est(r, status=None):
    k = addr_key(r.get('address'))
    c, n, rv = coords.get(k, {}), notes.get(k, {}), reviews.get(k)
    note = ' | '.join(x for x in [r.get('note'), r.get('notes'),
                                  rv and f"{rv['reason']}: {rv['note']} ({rv['date']})"] if x and x.strip())
    est.append([r.get('license_no'), r['name'], r.get('legal_name'), r.get('address'), k, r.get('zip'), r.get('neighborhood'),
                float(c['lat']) if c.get('lat') else None, float(c['lng']) if c.get('lng') else None,
                r.get('phone'), r.get('website') or r.get('suggested website'), r.get('instagram'), r.get('type'),
                r.get('license_type'), status or status_for(r), n.get('about'), note])
    keys.add(k)


def add_hh(k, name, days, start, end, deals, tags, source, url, verified):
    end = '23:59' if end in ('24:00', '00:00') else end
    s, e = mins(start), mins(end)
    if not days or s is None or e is None or e <= s or e - s > 240:
        skipped.append(f'{name} ({",".join(days)} {start}-{end})')
        return
    hh.append([k, name, days, start, end, deals, tags, source, url, verified])


for r in sheet:
    if (r.get('name') or '').strip():
        add_est(r)
for r in website_rows:
    k = addr_key(r['address'])
    if k not in keys:   # a bar the sheet doesn't have under that address
        add_est({'name': r['name'], 'address': r['address'], 'neighborhood': r['neighborhood'], 'website': r['source_url']}, 'listed')
    add_hh(k, r['name'], parse_days(r['days']), r['start'], r['end'],
           [d.strip() for d in r['deals'].split('|') if d.strip()],
           [t.strip() for t in re.split(r'[,|]', r['tags']) if t.strip()], 'website', r['source_url'], r['verified'])
for r in sheet:
    days = parse_days(r.get('days'))
    if days and r.get('start') and r.get('end'):
        add_hh(addr_key(r['address']), r['name'], days, r['start'], r['end'],
               [d.strip() for d in (r.get('deals') or '').split('|') if d.strip()], [], 'sheet', None, r.get('last_checked'))

E_COLS = ['license_no', 'name', 'legal_name', 'address', 'addr_key', 'zip', 'neighborhood', 'lat', 'lng', 'phone', 'website',
          'instagram', 'type', 'license_type', 'status', 'about', 'notes']
KEEP = [c for c in E_COLS if c not in ('license_no', 'status')]   # blank sheet cell keeps the current value
sql = ['begin;',
       'create temp table s_est (' + ', '.join(f'{c} {"double precision" if c in ("lat", "lng") else "text"}' for c in E_COLS) + ') on commit drop;',
       'create temp table s_hh (k text, name text, days text[], start_time time, end_time time, deals text[], tags text[], '
       'source text, source_url text, verified_on date) on commit drop;']
for i in range(0, len(est), 500):
    sql.append(f'insert into s_est values\n' + ',\n'.join('(' + ','.join(q(v) for v in row) + ')' for row in est[i:i + 500]) + ';')
if hh:
    sql.append('insert into s_hh values\n' + ',\n'.join('(' + ','.join(q(v) for v in row) + ')' for row in hh) + ';')
cols = ', '.join(E_COLS)
upd = ', '.join(f'{c} = coalesce(excluded.{c}, establishments.{c})' for c in KEEP)
full = [
    f"""insert into establishments ({cols}) select distinct on (license_no) {cols} from s_est where license_no is not null
on conflict (license_no) do update set {upd},
  status = case when establishments.status in ('listed', 'to_call', 'do_not_call', 'no_happy_hour') and excluded.status = 'to_research'
                then establishments.status else excluded.status end;""",
    f"""update establishments e set {', '.join(f'{c} = coalesce(s.{c}, e.{c})' for c in KEEP)}
from s_est s where s.license_no is null and e.license_no is null and e.name = s.name and coalesce(e.address, '') = coalesce(s.address, '');""",
    f"""insert into establishments ({cols}) select {cols} from s_est s where s.license_no is null
and not exists (select 1 from establishments e where e.license_no is null and e.name = s.name and coalesce(e.address, '') = coalesce(s.address, ''));""",
    "delete from happy_hours where source in ('website', 'sheet');"]
website_only = [
    f"""insert into establishments ({cols}) select distinct on (s.addr_key) {cols} from s_est s
where not exists (select 1 from establishments e where e.addr_key = s.addr_key);""",
    "delete from happy_hours where source = 'website';"]
geo = [(k, float(c['lat']), float(c['lng'])) for k, c in coords.items() if c.get('lat')]
about = [(k, n['about']) for k, n in notes.items() if (n.get('about') or '').strip()]
fill = []
if geo:
    fill.append('update establishments e set lat = g.lat, lng = g.lng from (values ' + ', '.join(f'({q(k)}, {la}, {ln})' for k, la, ln in geo)
                + ') as g(k, lat, lng) where e.addr_key = g.k and e.lat is null;')
if about:
    fill.append('update establishments e set about = a.about from (values ' + ', '.join(f'({q(k)}, {q(t)})' for k, t in about)
                + ') as a(k, about) where e.addr_key = a.k;')
sql += (website_only if WEBSITE_ONLY else full) + fill + [
    """with m as (
  select s.*, (select e.id from establishments e where e.addr_key = s.k
               order by (e.name = s.name) desc, (e.license_no is null), e.created_at limit 1) as eid
  from s_hh s),
ins as (
  insert into happy_hours (establishment_id, days, start_time, end_time, deals, tags, source, source_url, verified_on, review_status)
  select eid, days, start_time, end_time, deals, tags, source, source_url, verified_on,
         -- what the bar told us (call, owner, hand entry) beats what its website says
         case when exists (select 1 from happy_hours x where x.establishment_id = m.eid and x.review_status = 'live'
                           and x.source in ('call', 'owner', 'manual')) then 'retired' else 'live' end
  from m where eid is not null)
-- the name the bar uses on its own website wins over the license-list name
update establishments e set name = m.name from m where e.id = m.eid and m.source = 'website' and e.name <> m.name;""",
    """update establishments e set status = 'listed'
where exists (select 1 from happy_hours h where h.establishment_id = e.id and h.review_status = 'live')
  and e.status not in ('closed', 'do_not_call');""",
    """update establishments e set status = 'to_research'
where e.status = 'listed' and not exists (select 1 from happy_hours h where h.establishment_id = e.id and h.review_status = 'live');""",
    'commit;',
    "select status, count(*) as establishments from establishments group by 1 order by 2 desc;",
    "select count(*) as happy_hour_windows, count(distinct establishment_id) as listed_establishments from happy_hours where review_status = 'live';",
]
open(OUT, 'w', encoding='utf-8').write('\n'.join(sql) + '\n')
print(f'{len(est)} establishments and {len(hh)} happy hour windows -> {OUT}')
if skipped:
    print('Skipped (no usable days/times, or longer than PA allows): ' + '; '.join(skipped))
