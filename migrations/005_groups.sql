-- Agents that serve other people: friends and family in a group who never signed up and don't know what an agent is.
alter table rooms add column if not exists welcomed_at bigint;                         -- the one-time introduction was sent
alter table rooms add column if not exists guest_accounts boolean not null default true; -- members may ask for things that use the owner's accounts (with the owner's OK)
alter table approvals add column if not exists requester_id text;                        -- who asked, when it isn't the approver (a guest in a group)
alter table runs add column if not exists steps jsonb;                                    -- named steps behind the reply, for the web view
