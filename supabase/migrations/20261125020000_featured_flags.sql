-- Badges on the site: paid "Featured" placement and "215 Classic" (was on the 2009-2012 site).
alter table establishments add column if not exists featured boolean not null default false;
alter table establishments add column if not exists classic boolean not null default false;
