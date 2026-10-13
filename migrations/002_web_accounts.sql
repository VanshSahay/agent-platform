-- Web sign-in (Clerk). A web account links to the same person as their phone number.
alter table users add column if not exists clerk_id text unique;
alter table users add column if not exists email text;
alter table users alter column phone drop not null;   -- a web account exists before its phone is linked
