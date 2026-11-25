-- Calls happen only when someone asks the phone agent to make them: next_calls just answers "who's next?".
-- Once a bar has answered (a completed call), it isn't offered again for recall_after_days (default 180, about 6 months).
-- Unanswered attempts (voicemail, no answer, busy) can be retried after retry_after_days (default 2).
-- Change either in Supabase's SQL editor, e.g.: update private.settings set value = '365' where key = 'recall_after_days';
insert into private.settings (key, value) values ('recall_after_days', '180'), ('retry_after_days', '2')
on conflict (key) do nothing;

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
  where not exists (select 1 from calls c where c.establishment_id = q.id and c.outcome = 'completed'
                    and c.called_at > now() - recall * interval '1 day')
    and not exists (select 1 from calls c where c.establishment_id = q.id
                    and c.called_at > now() - retry * interval '1 day')
  limit least(greatest(coalesce(how_many, 10), 1), 100);
end $$;
revoke all on function public.next_calls(text, int) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.next_calls(text, int) to anon, authenticated';
  end if;
end $$;
