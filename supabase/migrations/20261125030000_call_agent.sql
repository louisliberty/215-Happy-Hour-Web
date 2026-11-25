-- Call agent API: two functions the phone agent calls over HTTPS through Supabase's REST API.
--   POST /rest/v1/rpc/next_calls   {"token": "...", "how_many": 10}      -> who to call next, with what we list now
--   POST /rest/v1/rpc/record_call  {"token": "...", "result": {...}}     -> store a call; publish it or flag it for review
-- The token lives in private.settings (never in this public repo). Read it in Supabase's SQL editor:
--   select value from private.settings where key = 'call_agent_token';

create schema if not exists private;
revoke all on schema private from public;
create table if not exists private.settings (key text primary key, value text not null);
insert into private.settings (key, value) values ('call_agent_token', encode(gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema private from anon, authenticated'; end if;
end $$;

-- "do not call" only keeps a bar out of the call queue; its listing stays on the site
alter table establishments add column if not exists do_not_call boolean not null default false;
update establishments set do_not_call = true, status = 'to_research' where status = 'do_not_call';
create or replace view call_queue as
select e.id, e.name, e.address, e.neighborhood, e.phone,
       case when exists (select 1 from happy_hours h where h.establishment_id = e.id and h.review_status = 'live') then 'verify' else 'new' end as call_type,
       (select max(c.called_at) from calls c where c.establishment_id = e.id) as last_called,
       (select max(h.verified_on) from happy_hours h where h.establishment_id = e.id and h.review_status = 'live') as last_verified,
       e.specials_change_frequency
from establishments e
where e.phone is not null and e.phone <> '' and not e.do_not_call
  and e.status not in ('closed', 'private', 'inactive')
order by
  (select max(c.called_at) from calls c where c.establishment_id = e.id) nulls first,
  (select max(h.verified_on) from happy_hours h where h.establishment_id = e.id and h.review_status = 'live') nulls first;
alter view call_queue set (security_invoker = true);
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on call_queue from anon, authenticated'; end if;
end $$;

create or replace function private.check_token(t text) returns void language plpgsql security definer set search_path = private, pg_temp as $$
begin
  if t is null or t <> (select value from private.settings where key = 'call_agent_token') then
    raise exception 'invalid token' using errcode = '28000';
  end if;
end $$;

-- Readable summary of what the site lists for a bar, for verify calls ("Tue-Fri 4:30-6 pm: $8 wine, $5 Peroni")
create or replace function public.listed_summary(eid uuid) returns text language sql stable set search_path = public, pg_temp as $$
  select string_agg(
    array_to_string(h.days, ',') || ' ' || to_char(h.start_time, 'HH24:MI') || '-' || to_char(h.end_time, 'HH24:MI')
      || case when cardinality(h.deals) > 0 then ': ' || array_to_string(h.deals[1:4], ', ') else '' end,
    '; ' order by h.start_time)
  from happy_hours h where h.establishment_id = eid and h.review_status = 'live';
$$;

-- Who to call next. Never-called bars first, then the stalest. Bars are called again sooner when their
-- specials change often: weekly 7 days, monthly 30, seasonal 90, never 180, otherwise 60.
create or replace function public.next_calls(token text, how_many int default 10)
returns table (establishment_id uuid, bar_name text, address text, neighborhood text, phone text, call_type text, listed_info text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.check_token(token);
  return query
  select q.id, q.name, q.address, q.neighborhood, q.phone, q.call_type, listed_summary(q.id)
  from call_queue q
  where q.last_called is null
     or q.last_called < now() - (case q.specials_change_frequency
          when 'weekly' then 7 when 'daily' then 7 when 'monthly' then 30 when 'seasonal' then 90 when 'never' then 180 else 60 end) * interval '1 day'
  limit least(greatest(coalesce(how_many, 10), 1), 100);
end $$;

-- Store one call result and act on it.
--   * Always saved to calls, untouched.
--   * New happy hour, high confidence, passes PA rules, nothing on file -> published.
--   * Confirms what we list -> verified date refreshed.
--   * Differs from what the bar's website says, low confidence, or breaks a rule -> saved as needs_review.
--   * Bar asks not to be called -> removed from the call queue (listing stays).
-- Returns {"ok": true, "action": "...", "review": "..."}.
create or replace function public.record_call(token text, result jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r jsonb := coalesce(result, '{}'::jsonb);
  eid uuid;
  call_id uuid;
  outcome text := lower(coalesce(r->>'outcome', ''));
  has_hh text := lower(coalesce(r->>'has_happy_hour', 'unknown'));
  conf text := lower(coalesce(r->>'confidence', 'low'));
  listed_ok text := lower(coalesce(r->>'listed_info_correct', 'n/a'));
  freq text := lower(r->>'specials_change_frequency');
  deals text[];
  item jsonb;
  d text[];
  st time; en time;
  week_minutes int := 0;
  problems text[] := '{}';
  windows jsonb := '[]'::jsonb;
  has_live bool; has_live_site bool;
  action text; review text;
  status_now text;
begin
  perform private.check_token(token);

  -- which bar: the id from next_calls, else the phone number
  begin eid := nullif(r->>'establishment_id', '')::uuid; exception when others then eid := null; end;
  if eid is null and coalesce(r->>'phone', '') <> '' then
    select e.id into eid from establishments e
    where regexp_replace(e.phone, '\D', '', 'g') = right(regexp_replace(r->>'phone', '\D', '', 'g'), 10)
    order by (e.status = 'listed') desc limit 1;
  end if;

  insert into calls (establishment_id, called_at, call_type, outcome, has_happy_hour, spoke_with, callback_time, do_not_call,
                     confidence, transcript_url, payload)
  values (eid, coalesce(nullif(r->>'call_time', '')::timestamptz, now()), nullif(lower(r->>'call_type'), ''), outcome, has_hh,
          r->>'spoke_with', r->>'callback_time', coalesce((r->>'do_not_call')::boolean, false), conf, r->>'transcript_url', r)
  returning id into call_id;

  if eid is null then
    update calls set processed = false where id = call_id;
    return jsonb_build_object('ok', true, 'action', 'saved', 'review', 'Could not match this call to a bar (no establishment_id or known phone)');
  end if;

  select status into status_now from establishments where id = eid;
  if coalesce((r->>'do_not_call')::boolean, false) then
    update establishments set do_not_call = true,
                              notes = concat_ws(' | ', notes, 'Asked not to be called (' || current_date || ')') where id = eid;
  end if;
  if freq in ('never', 'seasonal', 'monthly', 'weekly', 'daily', 'varies', 'unknown') then
    update establishments set specials_change_frequency = freq where id = eid;
  end if;

  if outcome <> 'completed' then
    update calls set processed = true where id = call_id;
    if outcome = 'permanently_closed' then
      update calls set processed = false where id = call_id;
      return jsonb_build_object('ok', true, 'action', 'saved', 'review', 'Reported permanently closed: confirm before taking the listing down');
    end if;
    return jsonb_build_object('ok', true, 'action', 'saved', 'review', null);
  end if;

  select exists (select 1 from happy_hours where establishment_id = eid and review_status = 'live'),
         exists (select 1 from happy_hours where establishment_id = eid and review_status = 'live' and source in ('website', 'owner', 'manual'))
    into has_live, has_live_site;

  -- bar confirmed what we list
  if has_live and listed_ok = 'yes' then
    update happy_hours set verified_on = current_date where establishment_id = eid and review_status = 'live';
    update calls set processed = true where id = call_id;
    return jsonb_build_object('ok', true, 'action', 'verified', 'review', null);
  end if;

  if has_hh = 'no' then
    if has_live then
      update calls set processed = false where id = call_id;
      return jsonb_build_object('ok', true, 'action', 'saved', 'review', 'Bar says no happy hour, but one is listed: check before removing');
    end if;
    if conf = 'high' then update establishments set status = 'no_happy_hour' where id = eid and status not in ('closed'); end if;
    update calls set processed = conf = 'high' where id = call_id;
    return jsonb_build_object('ok', true, 'action', 'no_happy_hour', 'review', case when conf = 'high' then null else 'Low confidence "no happy hour"' end);
  end if;

  if has_hh <> 'yes' or jsonb_typeof(r->'schedule') <> 'array' or jsonb_array_length(r->'schedule') = 0 then
    update calls set processed = false where id = call_id;
    return jsonb_build_object('ok', true, 'action', 'saved', 'review', 'Happy hour unclear or no schedule given');
  end if;

  -- deals: [{"item":"draft beers","price":"$5","notes":"bar only"}] -> "$5 draft beers (bar only)"
  select coalesce(array_agg(trim(concat_ws(' ', nullif(x->>'price', ''), x->>'item')
                  || case when coalesce(x->>'notes', '') <> '' then ' (' || (x->>'notes') || ')' else '' end)), '{}')
    into deals from jsonb_array_elements(case when jsonb_typeof(r->'deals') = 'array' then r->'deals' else '[]'::jsonb end) x
    where coalesce(x->>'item', '') <> '';

  -- check every window against PA rules
  for item in select * from jsonb_array_elements(r->'schedule') loop
    begin
      select array_agg(initcap(left(v, 3)) order by array_position(array['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], initcap(left(v, 3))))
        into d from jsonb_array_elements_text(item->'days') v;
      st := (item->>'start')::time; en := (item->>'end')::time;
    exception when others then
      problems := problems || ('Unreadable window: ' || item::text); continue;
    end;
    if d is null or not (d <@ array['Mon','Tue','Wed','Thu','Fri','Sat','Sun']) then problems := problems || ('Bad days: ' || item::text); continue; end if;
    if en <= st then problems := problems || ('Ends before it starts or after midnight: ' || item::text); continue; end if;
    if en - st > interval '4 hours' then problems := problems || ('Longer than PA''s 4 hours a day: ' || item::text); continue; end if;
    week_minutes := week_minutes + (extract(epoch from en - st) / 60)::int * cardinality(d);
    windows := windows || jsonb_build_object('days', to_jsonb(d), 'start', st, 'end', en);
  end loop;
  if week_minutes > 24 * 60 then problems := problems || 'More than PA''s 24 hours a week'::text; end if;

  if jsonb_array_length(windows) > 0 and cardinality(problems) = 0 and conf = 'high' and not has_live_site then
    -- publish: replace earlier call-sourced windows
    update happy_hours set review_status = 'retired' where establishment_id = eid and review_status = 'live' and source = 'call';
    action := 'published';
  else
    action := 'needs_review';
    review := concat_ws('; ',
      case when cardinality(problems) > 0 then array_to_string(problems, '; ') end,
      case when conf <> 'high' then 'Confidence ' || conf end,
      case when has_live_site then 'Differs from what we list from the bar''s website: ' || coalesce(listed_summary(eid), '') end);
  end if;

  insert into happy_hours (establishment_id, days, start_time, end_time, deals, source, call_id, verified_on, confidence, review_status, review_note)
  select eid, array(select jsonb_array_elements_text(w->'days')), (w->>'start')::time, (w->>'end')::time, deals, 'call', call_id,
         current_date, conf, case when action = 'published' then 'live' else 'needs_review' end, review
  from jsonb_array_elements(windows) w;

  update calls set processed = (action = 'published') where id = call_id;
  if action = 'published' then
    update establishments set status = 'listed' where id = eid and status not in ('closed');
  end if;
  return jsonb_build_object('ok', true, 'action', action, 'review', review);
end $$;

-- Only these two entry points are open, and only with the token.
revoke all on function public.next_calls(text, int) from public;
revoke all on function public.record_call(text, jsonb) from public;
revoke all on function public.listed_summary(uuid) from public;
revoke all on function private.check_token(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.next_calls(text, int) to anon, authenticated';
    execute 'grant execute on function public.record_call(text, jsonb) to anon, authenticated';
  end if;
end $$;
