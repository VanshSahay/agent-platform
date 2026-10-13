-- Instinct's lesson: the agent reads memory; a background pass rewrites it (merge, date corrections, drop retractions)
-- and derives a short profile the agent sees first on every run.
alter table agents add column if not exists profile text;
alter table agents add column if not exists profile_at bigint;
alter table agents add column if not exists consolidated_at bigint;
