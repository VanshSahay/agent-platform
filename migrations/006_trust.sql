-- The trust dial grows an amount: purchases under it run without asking; a pause switch stops all spending.
alter table agents add column if not exists max_usd_without_asking double precision;
alter table agents add column if not exists spending_paused boolean not null default false;
