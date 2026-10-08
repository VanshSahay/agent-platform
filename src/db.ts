// Canonical product database: Postgres in production (DATABASE_URL), SQLite (bun:sqlite + FTS5) for local dev and tests.
// Both sit behind the same synchronous one/all/exec/tx API; SQL is written once (SQLite-flavoured) and translated in pg.ts.
import type { Database } from "bun:sqlite";
import * as pg from "./pg";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

export let db: Database;
export let dialect: "sqlite" | "pg" = "sqlite";

const SCHEMA = `
create table if not exists users (id text primary key, email text unique, name text not null, password_hash text, guest int default 0, created_at int);
create table if not exists sessions (token text primary key, user_id text not null, expires_at int);
create table if not exists workspaces (id text primary key, name text not null, kind text default 'personal', plan text default 'free', created_at int);
create table if not exists memberships (workspace_id text, user_id text, role text default 'member', title text, primary key (workspace_id, user_id));
create table if not exists invitations (token text primary key, workspace_id text, email text, role text, invited_by text, accepted_by text, created_at int);

create table if not exists agents (id text primary key, workspace_id text not null, name text not null, avatar text, job text, instructions text,
  skills text default '[]', permissions text default '{}', model_profile text default 'standard', template_id text, template_version text,
  onboarding text default '{}', status text default 'active', created_by text, created_at int);
create table if not exists channel_identities (id text primary key, agent_id text, platform text not null, address text, secret_enc text, config text default '{}', created_at int);

create table if not exists rooms (id text primary key, workspace_id text not null, name text not null, objective text, kind text default 'shared',
  participation text default 'mention_only', status text default 'active', created_at int);
create table if not exists room_members (room_id text, principal_id text, kind text, role text, primary key (room_id, principal_id));
create table if not exists room_endpoints (id text primary key, room_id text not null, platform text not null, external_conversation_id text not null,
  channel_identity_id text, is_group int default 0, last_active_at int, config text default '{}', unique (platform, channel_identity_id, external_conversation_id));

create table if not exists events (seq integer primary key autoincrement, id text unique, workspace_id text, room_id text, run_id text,
  type text not null, actor text, data text default '{}', ts int);
create index if not exists events_room on events (room_id, seq);
create index if not exists events_run on events (run_id, seq);

create table if not exists tasks (id text primary key, room_id text not null, title text not null, owner text, status text default 'open',
  agent_action text default 'allowed', subject text, due_at int, notes text, created_by text, created_at int, updated_at int);

create table if not exists runs (id text primary key, workspace_id text, room_id text, agent_id text, objective text, kind text, status text,
  requested_by text, parent_run_id text, trigger_event_id text, origin_endpoint_id text, budget text, spent text, tainted int default 0,
  error text, result text, created_at int, updated_at int, completed_at int);
create index if not exists runs_status on runs (status);
create table if not exists run_steps (id integer primary key autoincrement, run_id text not null, type text not null, data text, ts int);
create table if not exists waits (id text primary key, run_id text, room_id text, kind text not null, reason text, owner text, wake_key text,
  wake_at int, timeout_at int, on_timeout text default 'fail', status text default 'open', created_at int);

create table if not exists approvals (id text primary key, run_id text, room_id text, agent_id text, tool_id text, input text, fingerprint text,
  summary text, risk text, approvers text, strong int default 0, status text default 'pending', decided_by text, decided_at int,
  constraints text, created_at int);
create table if not exists grants (id text primary key, agent_id text, tool_id text, granted_by text, created_at int);

create table if not exists connections (id text primary key, workspace_id text not null, owner_id text not null, visibility text default 'private',
  provider text not null, label text, account text, scopes text, cred_enc text, status text default 'active', last_used_at int, created_at int);
create table if not exists connection_grants (connection_id text, agent_id text, primary key (connection_id, agent_id));
create table if not exists tool_executions (id text primary key, run_id text, tool_id text, fingerprint text unique, status text,
  input text, result text, connection_id text, created_at int, updated_at int);

create table if not exists memories (id text primary key, workspace_id text, scope_type text, scope_id text, kind text, text text,
  source_event_ids text default '[]', created_by text, confidence real default 0.8, sensitivity text default 'normal', expires_at int, created_at int);
create virtual table if not exists memories_fts using fts5 (id unindexed, text);

create table if not exists external_identities (platform text, external_user_id text, user_id text, verified int default 0, display_name text,
  primary key (platform, external_user_id));
create table if not exists link_codes (code text primary key, user_id text, expires_at int);

create table if not exists schedules (id text primary key, agent_id text, room_id text, kind text, spec text, objective text, next_at int,
  status text default 'active', created_by text, created_at int);

create table if not exists inbound_events (id text primary key, provider text, provider_event_id text, channel_identity_id text, raw text,
  status text default 'queued', error text, received_at int, unique (provider, provider_event_id));
create table if not exists outbox (id text primary key, endpoint_id text, room_id text, event_id text, payload text, status text default 'queued',
  external_id text, error text, attempts int default 0, created_at int);

create table if not exists custom_skills (id text primary key, agent_id text, workspace_id text, name text, procedure text, tools text, example text,
  signature text, created_by text, created_at int);
create table if not exists files (id text primary key, workspace_id text, room_id text, name text, mime text, size int, data blob, text text,
  uploaded_by text, created_at int);
create table if not exists agent_tasks (id text primary key, workspace_id text, room_id text, run_id text, requester_id text, revision int default 1, original_request text, goal text, status text, created_at int, updated_at int);
create index if not exists agent_tasks_run on agent_tasks (run_id);
create table if not exists task_actions (id text primary key, task_id text, revision int, n int, kind text, mode text, target text, text text, inputs text, constraints text, depends_on text, status text, approval_id text, tool_execution_id text, updated_at int);
create table if not exists action_evidence (id text primary key, action_id text, run_id text, tool_execution_id text, type text, provider_ref text, facts text, verdict text, note text, verifier_version int, observed_at int);
create table if not exists task_revisions (task_id text, revision int, message_event_id text, change text, created_at int, primary key (task_id, revision));
create table if not exists objectives (id text primary key, workspace_id text, room_id text, agent_id text, created_by text, title text, status text default 'open', created_at int);
create table if not exists objective_steps (id text primary key, objective_id text, n int, title text, owner text, status text default 'todo', due_at int, note text, nudged_at int, escalated_at int, updated_at int);
create table if not exists stories (id text primary key, workspace_id text, room_id text, told_by text, title text, text text, people text, when_text text, where_text text, file_id text, created_at int);
create table if not exists deploy_codes (code text primary key, agent_id text, user_id text, platform text, kind text, expires_at int, used_at int);
create table if not exists opt_outs (platform text, address text, ts int, primary key (platform, address));
create table if not exists standing_approvals (id text primary key, agent_id text, tool_id text, constraints text, max_uses int default 1, uses int default 0,
  expires_at int, granted_by text, approval_id text, ref text, status text default 'active', created_at int);
create table if not exists reservations (id text primary key, workspace_id text, user_id text, agent_id text, site text, venue_id text, venue text, date text, time text,
  party_size int, confirmation text, deposit real default 0, status text, sandbox int default 0, created_at int);
create table if not exists reservation_watches (id text primary key, workspace_id text, agent_id text, room_id text, user_id text, criteria text, release_at int, auto_book int default 0,
  status text default 'active', checks int default 0, last_checked_at int, next_check_at int, interval_ms int, pending_run_id text, booked_reservation_id text, created_at int);
create table if not exists site_watches (id text primary key, workspace_id text, agent_id text, room_id text, user_id text, what text, url text, site text, opens_at int, until int,
  every_min int, max_price real, quantity int default 1, action text default 'notify', status text default 'active', checks int default 0, last_result text, pending_run_id text, next_check_at int, created_at int);
create table if not exists group_orders (id text primary key, workspace_id text, room_id text, agent_id text, organizer_id text, title text, vendor text, items text, min_total_qty int,
  deadline_at int, payment_handle text, shipping_fee real default 0, status text default 'open', reminded int default 0, closed_at int, created_at int);
create table if not exists order_lines (id text primary key, order_id text, user_id text, item_id text, qty int, note text, paid int default 0, updated_at int);
create table if not exists polls (id text primary key, workspace_id text, room_id text, agent_id text, created_by text, question text, options text, multi int default 0,
  status text default 'open', closes_at int, created_at int);
create table if not exists poll_votes (poll_id text, user_id text, option_ids text, updated_at int, primary key (poll_id, user_id));
create table if not exists expenses (id text primary key, workspace_id text, room_id text, agent_id text, paid_by text, amount real, description text, split_among text, created_at int);
create table if not exists settlements (id text primary key, room_id text, from_user text, to_user text, amount real, created_at int);
create table if not exists lists (id text primary key, room_id text, name text, created_at int);
create table if not exists list_items (id text primary key, list_id text, text text, done int default 0, added_by text, created_at int);
create table if not exists usage (id integer primary key autoincrement, workspace_id text, agent_id text, run_id text, kind text, qty real,
  cost_usd real default 0, byok int default 0, ts int);
create table if not exists provider_keys (workspace_id text, provider text, key_enc text, primary key (workspace_id, provider));
create table if not exists model_profiles (name text primary key, primary_model text, fallback_model text, escalation_model text, max_cost real);

create table if not exists publishers (id text primary key, name text, owner_user_id text, verified int default 0);
create table if not exists templates (id text primary key, slug text unique, publisher_id text, name text, tagline text, status text default 'draft',
  featured int default 0, latest_version text, published_version text, forked_from text, created_at int);
create table if not exists template_versions (template_id text, version text, manifest text, review_notes text, status text, created_at int, primary key (template_id, version));
create table if not exists installs (id text primary key, template_id text, version text, workspace_id text, agent_id text, ts int);
create table if not exists reviews (id text primary key, template_id text, user_id text, rating int, text text, ts int);
create table if not exists oauth_states (state text primary key, provider text, workspace_id text, user_id text, verifier text, payload text, expires_at int, used_at int);
create table if not exists browser_sessions (id text primary key, connection_id text, workspace_id text, purpose text, session_id text, status text, replay_url text, run_id text, created_at int, ended_at int);
create table if not exists credit_ledger (id text primary key, workspace_id text, delta_usd real, reason text, ref text unique, ts int);
`;

const COLUMN_MIGRATIONS = [["room_endpoints", "config", "text default '{}'"], ["templates", "published_version", "text"], ["template_versions", "status", "text"],
    ["runs", "brief", "text"], ["runs", "signature", "text"], ["runs", "rev", "integer default 0"], ["room_endpoints", "agent_id", "text"], ["rooms", "mode", "text default 'live'"], ["rooms", "summary", "text"], ["rooms", "summary_seq", "int default 0"], ["agents", "email_alias", "text"], ["connections", "config", "text default '{}'"], ["reservation_watches", "tried", "text default '[]'"], ["runs", "brief_status", "text"], ["agents", "confirm_mode", "text default 'smart'"], ["agents", "spec", "text"],
    ["outbox", "claimed_at", "int"], ["room_endpoints", "reply_token", "text"], ["room_endpoints", "undeliverable", "int default 0"],
    ["workspaces", "ai_mode", "text default 'credits'"], ["workspaces", "ai_models", "text default '{}'"], ["workspaces", "credit_usd", "real default 0"], ["workspaces", "allowance_month", "text"], ["workspaces", "allowance_used", "real default 0"], ["users", "clerk_id", "text"], ["users", "tz", "text"], ["users", "sharing", "text"], ["deploy_codes", "target", "text"], ["deploy_codes", "conv", "text"]];

let pgReady = false;
/** Postgres: DATABASE_URL. Tests pass ":memory:" for a fresh database — on Postgres that truncates every table instead. */
function openPg(url: string, fresh: boolean) {
  dialect = "pg"; pg.connect(url);
  if (!pgReady) {
    pg.query(pg.translateDdl(SCHEMA));
    for (const [table, col, ddl] of COLUMN_MIGRATIONS) pg.query(`alter table ${table} add column if not exists ${col} ${pg.translateDdl(ddl).split("\n")[0]}`);
    pg.query("alter table channel_identities alter column agent_id drop not null");
    pgReady = true;
  }
  if (fresh) {
    const tables = pg.query("select tablename from pg_tables where schemaname=current_schema()").rows.map((r) => r.tablename);
    if (tables.length) pg.query(`truncate table ${tables.join(", ")} restart identity cascade`);
  }
  seedProfiles();
}

/** The current moment as a model should see it: weekday, date, local time, zone and UTC offset. Without this, models
 *  guess the year and can't resolve "Saturday" or "a week before Nov 3". Zone: DEFAULT_TZ, else the server's.
 *  ponytail: one zone for everyone; per-user zones when users span time zones. */
export const serverTz = () => process.env.DEFAULT_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
/** A person's time zone: what they told us (or their browser did), else the platform default. */
export function tzOf(userId?: string | null) { return (userId && one<any>("select tz from users where id=?", userId)?.tz) || serverTz(); }
const validTz = (tz: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };
export function setTz(userId: string, tz: string) { if (!validTz(tz)) return false; exec("update users set tz=? where id=?", tz, userId); return true; }
/** Wall-clock parts of an instant in a zone. */
export function zoned(t: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month - 1, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
/** The instant when it's y-mo-d h:mi on the wall clock in tz (DST-correct: re-checks the offset at the result). */
export function fromZoned(y: number, mo: number, d: number, h: number, mi: number, tz: string) {
  let t = Date.UTC(y, mo, d, h, mi);
  for (let i = 0; i < 2; i++) { const z = zoned(t, tz); t += Date.UTC(y, mo, d, h, mi) - Date.UTC(z.y, z.mo, z.d, z.h, z.mi); }
  return t;
}
export const fmtLocal = (t: number, tz: string) => new Date(t).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export function clockLine(t = now(), tzIn?: string) {
  const tz = tzIn ?? serverTz(), d = new Date(t);
  const local = d.toLocaleString("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  const off = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value.replace("GMT", "") || "+00:00";
  return `Now: ${local} (${tz}, UTC${off}). Write datetimes for tools as ISO 8601 with this offset, e.g. 2026-10-27T09:00:00${off}.`;
}
export function openDb(path = process.env.DB_PATH ?? "data.sqlite") {
  if (process.env.DATABASE_URL) return openPg(process.env.DATABASE_URL, path === ":memory:");
  dialect = "sqlite";
  const { Database } = require("bun:sqlite"); // only loaded for SQLite, so the Node (Temporal) worker never touches it
  db = new Database(path, { create: true });
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
  db.exec(SCHEMA);
  // Additive migrations for databases created by earlier versions.
  for (const [table, col, ddl] of COLUMN_MIGRATIONS) {
    if (!(db.query(`pragma table_info(${table})`).all() as any[]).some((c) => c.name === col)) db.exec(`alter table ${table} add column ${col} ${ddl}`);
  }
  // Shared platform lines have no owning agent: relax the old NOT NULL (SQLite needs a table rebuild).
  if ((db.query("pragma table_info(channel_identities)").all() as any[]).find((c) => c.name === "agent_id")?.notnull) db.exec(`
    create table channel_identities_new (id text primary key, agent_id text, platform text not null, address text, secret_enc text, config text default '{}', created_at int);
    insert into channel_identities_new select id, agent_id, platform, address, secret_enc, config, created_at from channel_identities;
    drop table channel_identities; alter table channel_identities_new rename to channel_identities;`);
  db.exec(`update templates set published_version=latest_version where published_version is null and status='published';
    update template_versions set status=coalesce((select case when t.published_version=template_versions.version then 'published' else t.status end from templates t where t.id=template_id), 'draft') where status is null;`);
  seedProfiles();
  return db;
}
export function seedProfiles() {
  if (one<any>("select count(*) n from model_profiles")!.n) { // already seeded: only add profiles introduced since
    if (!one("select 1 from model_profiles where name='judge'")) exec("insert into model_profiles values (?,?,?,?,?)", "judge", "anthropic:claude-sonnet-5-5", "openai:gpt-5", "anthropic:claude-opus-5-5", 0.5);
    return;
  }
  // Routing lives in the DB, not in agent definitions (plan §8.3). Edit rows to re-route.
  for (const r of [["fast", "anthropic:claude-haiku-4-5", "openai:gpt-5-mini", null, 0.05], ["standard", "anthropic:claude-sonnet-5-5", "openai:gpt-5", "anthropic:claude-opus-5-5", 0.8],
    ["research-standard", "anthropic:claude-sonnet-5-5", "openai:gpt-5", "anthropic:claude-opus-5-5", 1.5], ["escalation", "anthropic:claude-opus-5-5", "anthropic:claude-sonnet-5-5", null, 3],
    ["judge", "anthropic:claude-sonnet-5-5", "openai:gpt-5", "anthropic:claude-opus-5-5", 0.5]])
    exec("insert into model_profiles values (?,?,?,?,?)", ...r);
}

// ---- clock (injectable for durable-time tests) ----
let clockOffset = 0;
export const now = () => Date.now() + clockOffset;
export const advance = (ms: number) => { clockOffset += ms; };
export const resetClock = () => { clockOffset = 0; };

// ---- helpers ----
export const id = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;
export const all = <T = any>(sql: string, ...p: any[]): T[] => dialect === "pg" ? pg.query(pg.translate(sql), p).rows : db.query(sql).all(...p) as T[];
export const one = <T = any>(sql: string, ...p: any[]): T | undefined => dialect === "pg" ? pg.query(pg.translate(sql), p).rows[0] : (db.query(sql).get(...p) ?? undefined) as T | undefined;
export const exec = (sql: string, ...p: any[]): { changes: number } => dialect === "pg" ? { changes: pg.query(pg.translate(sql), p).count } : db.query(sql).run(...p);
export const J = (s: any, d: any = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };
export const S = (v: any) => JSON.stringify(v ?? null);
let depth = 0;
export const tx = <T>(fn: () => T): T => {
  if (dialect === "sqlite") return db.transaction(fn)();
  if (depth++) try { return fn(); } finally { depth--; } // nested: join the outer transaction
  pg.query("begin");
  try { const r = fn(); pg.query("commit"); return r; } catch (e) { pg.query("rollback"); throw e; } finally { depth--; }
};
/** Read-modify-write a JSON text column in app code, so no SQL dialect needs json_set/json_insert. */
export function patchJson(table: string, col: string, rowId: string, fn: (v: any) => any, fallback: any = {}) {
  const cur = one<any>(`select ${col} v from ${table} where id=?`, rowId);
  if (cur) exec(`update ${table} set ${col}=? where id=?`, S(fn(J(cur.v, fallback))), rowId);
}
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Append-only domain event (plan §24.1). Messages, run lifecycle, tool calls and approvals all land here; it doubles as the audit log. */
export function emit(type: string, f: { workspace_id?: string; room_id?: string; run_id?: string; actor?: string; data?: any }) {
  const eid = id("evt");
  exec("insert into events (id, workspace_id, room_id, run_id, type, actor, data, ts) values (?,?,?,?,?,?,?,?)",
    eid, f.workspace_id ?? null, f.room_id ?? null, f.run_id ?? null, type, f.actor ?? null, S(f.data ?? {}), now());
  return eid;
}

// ---- envelope encryption (plan §8.4, §21.3) ----
// Each secret gets its own data key; the data key is wrapped with the master key (KMS stand-in).
// ponytail: master key from env; swap wrapKey/unwrapKey for AWS KMS Encrypt/Decrypt in production.
function masterKey() {
  const k = process.env.MASTER_KEY;
  if (k) return Buffer.from(k, "base64");
  if (process.env.NODE_ENV === "production") throw new Error("MASTER_KEY required in production");
  return createHash("sha256").update("dev-only-master-key").digest();
}
function gcm(key: Buffer, data: Buffer) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
  const out = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), out]).toString("base64");
}
function ungcm(key: Buffer, b64: string) {
  const b = Buffer.from(b64, "base64"), d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}
export function seal(value: unknown): string {
  const dek = randomBytes(32);
  return S({ k: gcm(masterKey(), dek), d: gcm(dek, Buffer.from(S(value))) });
}
export function unseal<T = any>(sealed: string | null | undefined): T | null {
  if (!sealed) return null;
  const { k, d } = JSON.parse(sealed);
  return JSON.parse(ungcm(ungcm(masterKey(), k), d).toString());
}

/** Billing plugs in here (set by billing.ts) so metered non-model usage is priced and charged without an import cycle. */
export const usageHooks: { price?: (kind: string, qty: number) => number; charge?: (ws: string, usd: number) => void } = {};
export function recordUsage(u: { workspace_id: string; agent_id?: string; run_id?: string; kind: string; qty: number; cost_usd?: number; byok?: boolean }) {
  const cost = u.cost_usd ?? (usageHooks.price?.(u.kind, u.qty) ?? 0); // model calls arrive pre-priced and pre-charged
  if (u.cost_usd === undefined && cost > 0) usageHooks.charge?.(u.workspace_id, cost);
  exec("insert into usage (workspace_id, agent_id, run_id, kind, qty, cost_usd, byok, ts) values (?,?,?,?,?,?,?,?)",
    u.workspace_id, u.agent_id ?? null, u.run_id ?? null, u.kind, u.qty, cost, u.byok ? 1 : 0, now());
}
