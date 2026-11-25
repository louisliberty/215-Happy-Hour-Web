-- Only places that could run a happy hour go in the call queue: bars, restaurants, hotel bars, breweries,
-- distilleries and winery tasting rooms. Grocery chains, markets, delis, bottle shops, convenience stores and gas
-- stations are left out. A "beer only" license (Eating Place Retail Dispenser, Malt) is mostly delis and bottle shops,
-- so those stay in only when the name looks like a bar or restaurant. Bars already listed on the site always stay in.
-- Override any single place with establishments.call_eligible (true = always call, false = never call, empty = automatic).
alter table establishments add column if not exists call_eligible boolean;

create or replace function public.auto_call_eligible(name text, type text) returns boolean language sql immutable as $$
  select case
    when lower(coalesce(type, '')) not in ('bar / restaurant', 'bar / restaurant (beer only)', 'hotel bar', 'brewery',
                                           'distillery', 'winery / tasting room') then false
    when coalesce(name, '') ~* '\m(market|mkt|deli|delicatessen|mart|grocery|groceries|foodery|bottle shop|bottles|beverages?|six ?pack|mini ?market|food store|supermarket|convenience|pharmacy|wawa|sheetz|acme|giant|shoprite|whole foods|trader joe|target|7-?eleven|food mart|newsstand|bodega|h mart|beer (store|stop|distributor|outlet|depot))\M'
         and coalesce(name, '') !~* '\m(bar|pub|tavern|taproom|tap room|taphouse|tap house|saloon|lounge|grill|grille|cafe|café|restaurant|kitchen|bistro|brasserie|cantina|trattoria|ristorante|osteria|beer garden|biergarten|brewing|brewery)\M'
      then false
    when lower(type) = 'bar / restaurant (beer only)' then
      coalesce(name, '') ~* '\m(bar|pub|tavern|taproom|tap room|taphouse|tap house|saloon|lounge|grill|grille|cafe|café|restaurant|kitchen|bistro|brasserie|inn|cantina|trattoria|ristorante|osteria|beer garden|biergarten|brewing|brewery|social)\M'
      and coalesce(name, '') !~* '\m(pizza|pizzeria|steaks?|hoagies?|gyros?|food co|food court)\M'
    else true end
$$;

create or replace view call_queue as
select e.id, e.name, e.address, e.neighborhood, e.phone,
       case when exists (select 1 from happy_hours h where h.establishment_id = e.id and h.review_status = 'live') then 'verify' else 'new' end as call_type,
       (select max(c.called_at) from calls c where c.establishment_id = e.id) as last_called,
       (select max(h.verified_on) from happy_hours h where h.establishment_id = e.id and h.review_status = 'live') as last_verified,
       e.specials_change_frequency
from establishments e
where e.phone is not null and e.phone <> '' and not e.do_not_call
  and e.status not in ('closed', 'private', 'inactive')
  and coalesce(e.call_eligible, e.status = 'listed' or public.auto_call_eligible(e.name, e.type))
order by
  (select max(c.called_at) from calls c where c.establishment_id = e.id) nulls first,
  (select max(h.verified_on) from happy_hours h where h.establishment_id = e.id and h.review_status = 'live') nulls first;
alter view call_queue set (security_invoker = true);
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on call_queue from anon, authenticated'; end if;
end $$;

-- the three the call agent flagged: never call (only if nobody has set them by hand)
update establishments set call_eligible = false
where call_eligible is null and name in ('T & J Susquehanna', 'Foodery', 'Mulberry Market');
