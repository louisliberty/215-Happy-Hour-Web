-- Fixes from the call agent's first batch, and two ongoing helpers.

-- Not happy hour places (checked by the call agent): a retail-only distillery and a bottle shop
update establishments set call_eligible = false where call_eligible is null and name in ('Espanola Spirits Ltd', 'Rybrew');

-- Company names staff won't recognize -> the names the places use (the company name stays in legal_name)
update establishments set legal_name = coalesce(legal_name, name), name = 'Southwark & Ambra' where name = 'Ambra Restaurant Group';
update establishments set legal_name = coalesce(legal_name, name), name = 'Talula''s Garden', website = null where name = 'Washington Square Restaurant Partners';
update establishments set legal_name = coalesce(legal_name, name), name = 'Harp & Crown' where name = 'Harp & Crown Restaurant Group';
update establishments set legal_name = coalesce(legal_name, name), name = 'Cavanaugh''s Headhouse' where name = 'Pnk Head House';

-- The Marriott's address had Hard Rock Cafe's address (1113-31 Market St) attached
update establishments set address = '1201 Market St', addr_key = '1201-market' where name = 'Philadelphia Marriott' and address like '1201 Market St &%';

-- What to ask for when calling. Hotels: the bar or restaurant inside, not the front desk.
alter table establishments add column if not exists ask_for text;

drop function if exists public.next_calls(text, int);
create function public.next_calls(token text, how_many int default 10)
returns table (establishment_id uuid, bar_name text, address text, neighborhood text, phone text, call_type text,
               listed_info text, ask_for text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  recall int := coalesce((select value::int from private.settings where key = 'recall_after_days'), 180);
  retry int := coalesce((select value::int from private.settings where key = 'retry_after_days'), 2);
begin
  perform private.check_token(token);
  return query
  select q.id, q.name, q.address, q.neighborhood, q.phone, q.call_type, listed_summary(q.id),
         coalesce(e.ask_for, case when lower(e.type) = 'hotel bar'
                                  then 'This is a hotel: ask for the hotel''s bar or restaurant, and report its name as public_name' end)
  from call_queue q join establishments e on e.id = q.id
  where not exists (select 1 from calls c where c.establishment_id = q.id and c.info_complete
                    and c.called_at > now() - recall * interval '1 day')
    and not exists (select 1 from calls c where c.establishment_id = q.id
                    and c.called_at > now() - retry * interval '1 day')
  limit least(greatest(coalesce(how_many, 10), 1), 100);
end $$;

-- record_call: optional "public_name" = the name the place actually goes by.
--   Our name is a company name ("... Restaurant Group", "Partners", "Holdings", "LLC"...) -> replaced right away.
--   Otherwise (including hotels) -> the call goes to the weekly review with the suggested name.
create or replace function public.record_call(token text, result jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  res jsonb;
  cid uuid;
  eid uuid;
  cur_name text;
  pub text := nullif(trim(coalesce(result->>'public_name', '')), '');
  has_deals bool := jsonb_typeof(result->'deals') = 'array'
                    and exists (select 1 from jsonb_array_elements(result->'deals') x where coalesce(x->>'item', '') <> '');
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
  return res || jsonb_build_object('complete', (select info_complete from calls where id = cid));
end $$;

revoke all on function public.next_calls(text, int) from public;
revoke all on function public.record_call(text, jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.next_calls(text, int) to anon, authenticated';
    execute 'grant execute on function public.record_call(text, jsonb) to anon, authenticated';
  end if;
end $$;
