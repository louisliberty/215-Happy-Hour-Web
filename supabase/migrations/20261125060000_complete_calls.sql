-- A call starts the 6-month wait only when we got everything we need from it ("complete"):
--   * the bar confirmed what we list (verified), or
--   * the bar has a happy hour and gave days, times AND deals, and it went live (published, or approved in the weekly review), or
--   * the bar clearly said it has no happy hour (high confidence).
-- Anything else (voicemail, no answer, unclear, low confidence, no deals, held and rejected) can be retried after
-- retry_after_days (default 2).
alter table calls add column if not exists info_complete boolean not null default false;

create or replace function public.record_call(token text, result jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  res jsonb;
  has_deals bool := jsonb_typeof(result->'deals') = 'array'
                    and exists (select 1 from jsonb_array_elements(result->'deals') x where coalesce(x->>'item', '') <> '');
begin
  res := private.record_call_inner(token, result);
  update calls set review_note = res->>'review',
                   info_complete = case res->>'action'
                     when 'verified' then true
                     when 'no_happy_hour' then res->>'review' is null
                     when 'published' then has_deals
                     else false end
  where id = (res->>'call_id')::uuid;
  return res || jsonb_build_object('complete',
    (select info_complete from calls where id = (res->>'call_id')::uuid));
end $$;

create or replace function public.next_calls(token text, how_many int default 10)
returns table (establishment_id uuid, bar_name text, address text, neighborhood text, phone text, call_type text, listed_info text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  recall int := coalesce((select value::int from private.settings where key = 'recall_after_days'), 180);
  retry int := coalesce((select value::int from private.settings where key = 'retry_after_days'), 2);
begin
  perform private.check_token(token);
  return query
  select q.id, q.name, q.address, q.neighborhood, q.phone, q.call_type, listed_summary(q.id)
  from call_queue q
  where not exists (select 1 from calls c where c.establishment_id = q.id and c.info_complete
                    and c.called_at > now() - recall * interval '1 day')
    and not exists (select 1 from calls c where c.establishment_id = q.id
                    and c.called_at > now() - retry * interval '1 day')
  limit least(greatest(coalesce(how_many, 10), 1), 100);
end $$;

revoke all on function public.next_calls(text, int) from public;
revoke all on function public.record_call(text, jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.next_calls(text, int) to anon, authenticated';
    execute 'grant execute on function public.record_call(text, jsonb) to anon, authenticated';
  end if;
end $$;
