"""
Turn the weekly review's decisions into SQL for Supabase.

    python tools/db_apply_decisions.py data/review-decisions.csv decisions.sql
    psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f decisions.sql

data/review-decisions.csv columns: kind,id,decision,note,date
  kind = happy_hour (a held happy hour window from a call) or call (a call that needed a look), id from review.csv.

  happy_hour decisions
    approve   goes live; replaces what the site listed for that bar from its website or from earlier calls
    reject    not published (wrong, illegal, or the website is right)
  call decisions
    dismiss        nothing to change
    closed         the bar is permanently closed: its listing comes off the site
    no_happy_hour  the bar confirmed it has no happy hour: any listing comes off the site
    match:<establishment id>   the call was for this bar (when it couldn't be matched automatically)

Runs on every push that changes the file. Applying the same decision twice changes nothing.
"""
import csv
import re
import sys

IN, OUT = sys.argv[1], sys.argv[2]
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


def q(v):
    return "'" + str(v or '').replace("'", "''") + "'"


sql, bad = ['begin;'], []
for row in csv.DictReader(open(IN, encoding='utf-8-sig')):
    kind, rid, dec = (row.get('kind') or '').strip(), (row.get('id') or '').strip(), (row.get('decision') or '').strip().lower()
    note = (row.get('note') or '').strip()
    stamp = f"Weekly review {row.get('date') or ''}: {dec}" + (f' ({note})' if note else '')
    if not UUID.match(rid):
        bad.append(f'{kind} {rid}: not an id')
        continue
    if kind == 'happy_hour' and dec == 'approve':
        sql += [
            f"""update happy_hours x set review_status = 'retired', review_note = {q('Replaced by call (weekly review)')}
from happy_hours h where h.id = {q(rid)} and h.review_status = 'needs_review' and x.establishment_id = h.establishment_id
  and x.review_status = 'live' and (x.source = 'website' or (x.source = 'call' and x.call_id is distinct from h.call_id));""",
            f"update happy_hours set review_status = 'live', review_note = {q(stamp)} where id = {q(rid)} and review_status = 'needs_review';",
            f"""update establishments e set status = 'listed' from happy_hours h
where h.id = {q(rid)} and h.review_status = 'live' and e.id = h.establishment_id and e.status not in ('closed', 'private', 'inactive');""",
        ]
    elif kind == 'happy_hour' and dec == 'reject':
        sql.append(f"update happy_hours set review_status = 'rejected', review_note = {q(stamp)} where id = {q(rid)} and review_status = 'needs_review';")
    elif kind == 'call' and dec in ('dismiss', 'closed', 'no_happy_hour') or (kind == 'call' and dec.startswith('match:')):
        if dec == 'closed':
            sql.append(f"update establishments e set status = 'closed' from calls c where c.id = {q(rid)} and e.id = c.establishment_id;")
        elif dec == 'no_happy_hour':
            sql += [f"update establishments e set status = 'no_happy_hour' from calls c where c.id = {q(rid)} and e.id = c.establishment_id and e.status <> 'closed';",
                    f"update happy_hours h set review_status = 'retired', review_note = {q(stamp)} from calls c where c.id = {q(rid)} and h.establishment_id = c.establishment_id and h.review_status = 'live';"]
        elif dec.startswith('match:'):
            eid = dec.split(':', 1)[1].strip()
            if not UUID.match(eid):
                bad.append(f'call {rid}: bad establishment id in {dec}')
                continue
            sql.append(f"update calls set establishment_id = {q(eid)} where id = {q(rid)} and establishment_id is null;")
        sql.append(f"update calls set processed = true, review_note = {q(stamp)} where id = {q(rid)};")
        continue
    else:
        bad.append(f'{kind} {rid}: unknown decision "{dec}"')
        continue
    # a call is done once none of its windows are waiting any more
    sql.append(f"""update calls c set processed = true from happy_hours h
where h.id = {q(rid)} and c.id = h.call_id and not exists (select 1 from happy_hours x where x.call_id = c.id and x.review_status = 'needs_review');""")
sql += ["""update establishments e set status = 'to_research'
where e.status = 'listed' and not exists (select 1 from happy_hours h where h.establishment_id = e.id and h.review_status = 'live');""",
        'commit;',
        "select 'Waiting for review now: ' || count(*) || ' happy hours' from happy_hours where review_status = 'needs_review';"]
open(OUT, 'w', encoding='utf-8').write('\n'.join(sql) + '\n')
print(f'{len(sql) - 4} statements -> {OUT}')
for b in bad:
    print('  skipped: ' + b)
