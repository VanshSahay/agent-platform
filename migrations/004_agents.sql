-- Several agents per person, each trained separately and deployable to different chats. Memory belongs to an agent
-- (its training follows it wherever it is deployed) or to a room (what was said there).
create table if not exists agents (
  id text primary key,
  owner_id text references users(id),
  name text not null,
  purpose text,
  auto_tools jsonb not null default '[]',
  created_at bigint not null
);
create index if not exists agents_owner on agents (owner_id);
alter table users add column if not exists default_agent_id text;
alter table rooms add column if not exists agent_id text;

-- Backfill: every existing person gets one agent carrying their old name, trust list and private memories.
insert into agents (id, owner_id, name, auto_tools, created_at)
  select 'agt_' || substr(md5(id), 1, 12), id, coalesce(agent_name, 'Assistant'), coalesce(auto_tools, '[]'::jsonb), created_at from users
  on conflict do nothing;
update users u set default_agent_id = a.id from agents a where a.owner_id = u.id and u.default_agent_id is null;
update rooms r set agent_id = u.default_agent_id from users u where r.owner_id = u.id and r.agent_id is null;
update memories m set scope_type = 'agent', scope_id = u.default_agent_id from users u where m.scope_type = 'private' and m.scope_id = u.id;
alter table memories drop constraint if exists memories_scope_type_check;
alter table memories add constraint memories_scope_type_check check (scope_type in ('agent', 'room'));
alter table users drop column if exists agent_name;
alter table users drop column if exists auto_tools;
