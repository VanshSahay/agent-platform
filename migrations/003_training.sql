-- Training in the web before deploying to iMessage: a web chat room per person, typed memories, a trust dial.
alter table rooms add column if not exists channel text not null default 'imessage';   -- imessage | web
alter table memories add column if not exists kind text not null default 'fact';       -- fact | preference | person | schedule | store | inventory | decision
alter table users add column if not exists auto_tools jsonb not null default '[]';     -- write tools the person lets the agent run without asking
