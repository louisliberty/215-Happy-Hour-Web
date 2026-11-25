-- Some day-of-the-week specials run only during happy hour (Tiffany on the Blvd's "Happy Hour Daily Specials").
-- They show inside the happy hour section; the rest stay under "Weekly specials".
alter table daily_specials add column if not exists during_happy_hour boolean not null default false;
