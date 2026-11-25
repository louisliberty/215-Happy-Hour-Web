-- Weekly specials: day-of-the-week deals that aren't happy hour (Taco Tuesday, $1 wings...).
create table if not exists daily_specials (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments (id) on delete cascade,
  days text[] not null check (cardinality(days) > 0 and days <@ array['Mon','Tue','Wed','Thu','Fri','Sat','Sun']),
  start_time time,                              -- optional: many run all day
  end_time time,
  special text not null,                        -- "$4 tacos & $7 margaritas"
  source text not null check (source in ('website', 'call', 'owner', 'manual')),
  source_url text,
  call_id uuid,
  verified_on date,
  review_status text not null default 'live' check (review_status in ('live', 'needs_review', 'rejected', 'retired')),
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists daily_specials_est_idx on daily_specials (establishment_id);
alter table daily_specials enable row level security;
drop trigger if exists daily_specials_updated on daily_specials;
create trigger daily_specials_updated before update on daily_specials for each row execute function set_updated_at();

-- record_call: optional "weekly_specials": [{"days":["Tue"],"special":"$4 tacos & $7 margaritas","start":"","end":""}]
--   high confidence -> live, replacing the bar's earlier website or call specials (the bar beats its website)
--   otherwise      -> held for the weekly review
create or replace function public.record_call(token text, result jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  res jsonb;
  cid uuid;
  eid uuid;
  cur_name text;
  conf text := lower(coalesce(result->>'confidence', 'low'));
  pub text := nullif(trim(coalesce(result->>'public_name', '')), '');
  has_deals bool := jsonb_typeof(result->'deals') = 'array'
                    and exists (select 1 from jsonb_array_elements(result->'deals') x where coalesce(x->>'item', '') <> '');
  item jsonb; d text[]; st time; en time; n_ws int := 0;
begin
  res := private.record_call_inner(token, result);
  cid := (res->>'call_id')::uuid;
  update calls set review_note = res->>'review',
                   info_complete = case res->>'action'
                     when 'verified' then true
                     when 'no_happy_hour' then res->>'review' is null
                     when 'published' then has_deals
                     else false end
  where id = cid returning establishment_id into eid;

  if pub is not null and eid is not null then
    select name into cur_name from establishments where id = eid;
    if lower(pub) <> lower(cur_name) then
      if cur_name ~* '\m(restaurant group|hospitality|partners|holdings?|associates|management|enterprises?|investments?|group|llc|inc|corp|ltd|limited|lp)\M' then
        update establishments set legal_name = coalesce(legal_name, name), name = pub where id = eid;
        res := res || jsonb_build_object('renamed', pub);
      else
        update calls set processed = false,
                         review_note = concat_ws('; ', review_note, 'Goes by "' || pub || '" (we have "' || cur_name || '")')
        where id = cid;
        res := res || jsonb_build_object('review', concat_ws('; ', res->>'review', 'Goes by "' || pub || '"'));
      end if;
    end if;
  end if;

  if eid is not null and jsonb_typeof(result->'weekly_specials') = 'array' and jsonb_array_length(result->'weekly_specials') > 0 then
    if conf = 'high' then
      update daily_specials set review_status = 'retired', review_note = 'Replaced by call'
      where establishment_id = eid and review_status = 'live' and source in ('website', 'call');
    end if;
    for item in select * from jsonb_array_elements(result->'weekly_specials') loop
      begin
        select array_agg(initcap(left(v, 3)) order by array_position(array['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], initcap(left(v, 3))))
          into d from jsonb_array_elements_text(item->'days') v;
        st := nullif(item->>'start', '')::time; en := nullif(item->>'end', '')::time;
      exception when others then continue;
      end;
      continue when d is null or not (d <@ array['Mon','Tue','Wed','Thu','Fri','Sat','Sun']) or coalesce(trim(item->>'special'), '') = '';
      insert into daily_specials (establishment_id, days, start_time, end_time, special, source, call_id, verified_on, review_status, review_note)
      values (eid, d, st, en, trim(item->>'special'), 'call', cid, current_date,
              case when conf = 'high' then 'live' else 'needs_review' end,
              case when conf = 'high' then null else 'Confidence ' || conf end);
      n_ws := n_ws + 1;
    end loop;
    res := res || jsonb_build_object('weekly_specials', n_ws);
  end if;

  return res || jsonb_build_object('complete', (select info_complete from calls where id = cid));
end $$;
revoke all on function public.record_call(text, jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.record_call(text, jsonb) to anon, authenticated';
  end if;
end $$;
