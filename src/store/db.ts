import { Database } from "bun:sqlite";

/**
 * One SQLite file holds everything. The schema is append-only in spirit:
 * run events are never updated, memories are superseded rather than edited.
 */
export function openDb(path = ":memory:"): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, handle TEXT NOT NULL UNIQUE, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, channel TEXT NOT NULL, external_id TEXT, data TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rooms_external ON rooms(channel, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS memberships (
  room_id TEXT NOT NULL, person_id TEXT NOT NULL, role TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (room_id, person_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'room', data TEXT NOT NULL, last_activity_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_room ON sessions(room_id, kind, last_activity_at);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, room_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  status TEXT NOT NULL, dedup_key TEXT, started_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id, started_at);
CREATE INDEX IF NOT EXISTS runs_room ON runs(room_id, started_at);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, started_at);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE UNIQUE INDEX IF NOT EXISTS runs_dedup ON runs(dedup_key) WHERE dedup_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS run_events (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, run_id TEXT NOT NULL, type TEXT NOT NULL,
  at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, seq);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_run ON tool_calls(run_id, started_at);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, room_id TEXT NOT NULL, role TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, at);
CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id, at);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL, type TEXT NOT NULL,
  stated_at INTEGER NOT NULL, retracted INTEGER NOT NULL DEFAULT 0, superseded INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_scope ON memories(agent_id, scope, scope_id, stated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, text, aliases, tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS profiles (
  agent_id TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL, text TEXT NOT NULL, derived_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, scope, scope_id)
);
CREATE TABLE IF NOT EXISTS attention (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, room_id TEXT NOT NULL, assignee_id TEXT NOT NULL, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attention_assignee ON attention(assignee_id, status, created_at);
CREATE INDEX IF NOT EXISTS attention_room ON attention(room_id, status, created_at);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, room_id TEXT NOT NULL, run_id TEXT NOT NULL, gate_key TEXT NOT NULL, decided_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_room ON approvals(room_id, gate_key, decided_at);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, room_id TEXT NOT NULL, paused INTEGER NOT NULL, next_run_at INTEGER, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(paused, next_run_at);
CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL, next_nudge_at INTEGER, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commitments_due ON commitments(status, next_nudge_at);
CREATE INDEX IF NOT EXISTS memberships_person ON memberships(person_id);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, room_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_room ON tasks(room_id, status, created_at);
CREATE TABLE IF NOT EXISTS credentials (
  person_id TEXT NOT NULL, service TEXT NOT NULL, ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (person_id, service)
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, room_id TEXT, kind TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_agent ON artifacts(agent_id, created_at);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY, v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, provider TEXT NOT NULL, usd REAL NOT NULL, units TEXT NOT NULL,
  run_id TEXT, session_id TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS spend_at ON spend(at);
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL
);
`;

/**
 * Versioned migrations. The base schema is idempotent (IF NOT EXISTS); each
 * numbered step alters existing databases that predate a change. Bump
 * `user_version` only here.
 */
const MIGRATIONS: ((db: Database) => void)[] = [
  // 1: sessions gained a kind column; task sessions must never be picked as the room session.
  (db) => {
    const cols = (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("kind")) db.run("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'room'");
    db.run("UPDATE sessions SET kind = 'task' WHERE json_extract(data, '$.taskId') IS NOT NULL");
  },
];

function migrate(db: Database) {
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version === 0) {
    // Fresh database (or one from before versioning): create the current schema, then apply steps that fix old rows.
    db.exec(SCHEMA);
  }
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      MIGRATIONS[i]!(db);
      db.run(`PRAGMA user_version = ${i + 1}`);
    })();
  }
  db.exec(SCHEMA); // new tables and indexes for databases migrated from an older version
}
