-- 215 Happy Hour database: one place for every establishment, its happy hours,
-- every phone call and every website check. Safe to run more than once.

create extension if not exists pgcrypto;

-- Every licensed establishment in Philadelphia County (from the PLCB list), listed or not.
create table if not exists establishments (
  id uuid primary key default gen_random_uuid(),
  license_no text unique,                       -- PLCB license number: the permanent key
  name text not null,
  legal_name text,
  address text,
  addr_key text,                                -- normalized address used to match website and call data
  zip text,
  neighborhood text,
  lat double precision,
  lng double precision,
  phone text,
  website text,
  instagram text,
  type text,                                    -- bar / restaurant, hotel bar, brewery ...
  license_type text,
  status text not null default 'to_research' check (status in
    ('to_research', 'listed', 'to_call', 'no_happy_hour', 'closed', 'private', 'do_not_call', 'inactive')),
  about text,                                   -- short description shown on the bar page
  specials_change_frequency text check (specials_change_frequency in
    ('never', 'seasonal', 'monthly', 'weekly', 'daily', 'varies', 'unknown')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists establishments_status_idx on establishments (status);
create index if not exists establishments_addr_key_idx on establishments (addr_key);

-- One row per happy hour window (e.g. Mon-Fri 4-7 pm). A bar can have several.
create table if not exists happy_hours (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments (id) on delete cascade,
  days text[] not null check (cardinality(days) > 0 and days <@ array['Mon','Tue','Wed','Thu','Fri','Sat','Sun']),
  start_time time not null,
  end_time time not null,
  deals text[] not null default '{}',
  tags text[] not null default '{}',            -- beer, wine, cocktails, food, oysters ...
  source text not null check (source in ('website', 'call', 'owner', 'sheet', 'manual')),  -- manual = typed into Supabase by hand
  source_url text,
  call_id uuid,
  verified_on date,
  confidence text check (confidence in ('high', 'medium', 'low')),
  review_status text not null default 'live' check (review_status in ('live', 'needs_review', 'rejected', 'retired')),
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Pennsylvania: at most 4 hours in a day, over by midnight
  check (end_time > start_time and end_time - start_time <= interval '4 hours')
);
create index if not exists happy_hours_est_idx on happy_hours (establishment_id);
create index if not exists happy_hours_review_idx on happy_hours (review_status);

-- Every phone call, exactly as the call agent reported it.
create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid references establishments (id) on delete set null,
  called_at timestamptz not null default now(),
  call_type text check (call_type in ('new', 'verify')),
  outcome text,                                 -- completed, voicemail, no_answer, refused ...
  has_happy_hour text,
  spoke_with text,
  callback_time text,
  do_not_call boolean not null default false,
  confidence text,
  transcript_url text,
  payload jsonb not null,                       -- the full result, untouched
  processed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists calls_est_idx on calls (establishment_id);

-- Weekly website scan results.
create table if not exists website_checks (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments (id) on delete cascade,
  checked_on date not null default current_date,
  result text not null,                         -- seen, missed, site_did_not_load, new_mention
  misses_in_a_row int not null default 0,
  details jsonb,
  created_at timestamptz not null default now()
);
create index if not exists website_checks_est_idx on website_checks (establishment_id, checked_on desc);

-- keep updated_at current
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists establishments_updated on establishments;
create trigger establishments_updated before update on establishments for each row execute function set_updated_at();
drop trigger if exists happy_hours_updated on happy_hours;
create trigger happy_hours_updated before update on happy_hours for each row execute function set_updated_at();

-- Who the call agent should call next: never reached first, then stale listings,
-- sooner for bars whose specials change often.
create or replace view call_queue as
select e.id, e.name, e.address, e.neighborhood, e.phone,
       case when exists (select 1 from happy_hours h where h.establishment_id = e.id and h.review_status = 'live') then 'verify' else 'new' end as call_type,
       (select max(c.called_at) from calls c where c.establishment_id = e.id) as last_called,
       (select max(h.verified_on) from happy_hours h where h.establishment_id = e.id and h.review_status = 'live') as last_verified,
       e.specials_change_frequency
from establishments e
where e.phone is not null and e.phone <> ''
  and e.status not in ('closed', 'private', 'do_not_call', 'inactive')
order by
  (select max(c.called_at) from calls c where c.establishment_id = e.id) nulls first,
  (select max(h.verified_on) from happy_hours h where h.establishment_id = e.id and h.review_status = 'live') nulls first;

-- Locked down by default: only server-side keys (GitHub Actions, Claude, the call-results function) can read or write.
alter table establishments enable row level security;
alter table happy_hours enable row level security;
alter table calls enable row level security;
alter table website_checks enable row level security;
