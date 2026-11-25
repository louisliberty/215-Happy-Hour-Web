-- record_call: weekly_specials items may carry "during_happy_hour": true for specials served only during happy hour
-- (they then show inside the happy hour section, like Tiffany on the Blvd's daily specials).
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
      insert into daily_specials (establishment_id, days, start_time, end_time, special, source, call_id, verified_on, during_happy_hour, review_status, review_note)
      values (eid, d, st, en, trim(item->>'special'), 'call', cid, current_date,
              coalesce(lower(item->>'during_happy_hour') in ('true', 'yes', '1'), false),
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
