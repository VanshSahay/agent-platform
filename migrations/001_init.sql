-- One general agent per person, living in iMessage. See docs/refactor-design.md.
create table if not exists users (
  id text primary key,
  phone text unique not null,
  name text,
  agent_name text,                         -- null until the person names it
  tz text not null default 'America/New_York',
  onboarded boolean not null default false,
  created_at bigint not null
);

create table if not exists rooms (
  id text primary key,
  kind text not null check (kind in ('private','group')),
  space_id text unique,                    -- Photon space (chat) id
  owner_id text references users(id),      -- private: the person; group: who brought the agent in
  name text,
  instructions text,                       -- what the owner asked the agent to do here
  last_join_at bigint,                     -- a new member appeared (replies pending before this are held)
  created_at bigint not null
);

create table if not exists room_members (
  room_id text references rooms(id),
  user_id text references users(id),
  joined_at bigint not null,
  consent_at bigint,                       -- this member allowed their accounts to be used in this group
  primary key (room_id, user_id)
);

create table if not exists messages (
  id text primary key,
  room_id text references rooms(id),
  sender_id text references users(id),     -- null when the agent speaks
  direction text not null check (direction in ('in','out')),
  text text not null,
  external_id text unique,                 -- provider message id (dedupe in, tapbacks out)
  run_id text,
  created_at bigint not null
);
create index if not exists messages_room on messages (room_id, created_at);

create table if not exists runs (
  id text primary key,
  room_id text references rooms(id),
  requester_id text references users(id),
  request text not null,
  status text not null,                    -- running | waiting_approval | waiting_consent | held | done | failed
  tier text not null default 'cheap',      -- cheap | smart, and why (tier_reason)
  tier_reason text,
  transcript jsonb not null default '[]',  -- model messages so a waiting run can resume
  reply text,
  cost_usd double precision not null default 0,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists runs_room on runs (room_id, created_at);

create table if not exists tool_executions (
  id text primary key,
  run_id text references runs(id),
  tool text not null,
  input jsonb not null,
  output jsonb,
  status text not null,                    -- started | succeeded | failed | unknown
  provider_ref text,                       -- what proves it: message id, event id, schedule id, replay url
  verified boolean not null default false,
  fingerprint text unique not null,
  created_at bigint not null
);

create table if not exists approvals (
  id text primary key,
  run_id text references runs(id),
  room_id text references rooms(id),
  user_id text references users(id),       -- the only person whose yes counts
  kind text not null check (kind in ('action','consent')),
  call jsonb,                              -- the tool call waiting (action)
  summary text not null,
  status text not null default 'pending',  -- pending | approved | rejected
  out_message_id text,                     -- the card we sent (tapbacks target it)
  created_at bigint not null,
  decided_at bigint
);

create table if not exists connections (
  id text primary key,
  user_id text references users(id),
  provider text not null,                  -- google | mcp
  label text,
  account text,
  cred_enc text,                           -- sealed with MASTER_KEY
  config jsonb not null default '{}',
  status text not null default 'active',   -- active | needs_reauth | revoked
  created_at bigint not null,
  last_used_at bigint
);
create index if not exists connections_user on connections (user_id, provider);

create table if not exists memories (
  id text primary key,
  scope_type text not null check (scope_type in ('private','room')),
  scope_id text not null,
  text text not null,
  created_by text,
  created_at bigint not null
);
create index if not exists memories_scope on memories (scope_type, scope_id);
create index if not exists memories_fts on memories using gin (to_tsvector('simple', text));

create table if not exists schedules (
  id text primary key,
  room_id text references rooms(id),
  user_id text references users(id),
  text text not null,
  kind text not null,                      -- message | task
  spec jsonb not null,                     -- {at} or {every, days, hour, minute, tz} plus optional unless_reply_from
  next_at bigint,
  status text not null default 'active',
  created_at bigint not null
);
create index if not exists schedules_due on schedules (status, next_at);

create table if not exists usage (
  id bigserial primary key,
  user_id text,
  run_id text,
  kind text not null,                      -- model | browser | media
  qty double precision not null,
  cost_usd double precision not null default 0,
  model text,
  ts bigint not null
);
create index if not exists usage_ts on usage (kind, ts);

create table if not exists links (                 -- magic links the agent texts (connect Google, add MCP, trace)
  token text primary key,
  user_id text references users(id),
  purpose text not null,
  state jsonb not null default '{}',
  expires_at bigint not null
);

create table if not exists files (
  id text primary key,
  room_id text,
  user_id text,
  name text,
  mime text,
  data bytea,
  text text,
  created_at bigint not null
);
