import { Database } from "bun:sqlite";

/**
 * One SQLite file holds everything. The schema is append-only in spirit:
 * run events are never updated, memories are superseded rather than edited.
 */
export function openDb(path = ":memory:"): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
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
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL, data TEXT NOT NULL, last_activity_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, room_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  status TEXT NOT NULL, dedup_key TEXT, started_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS runs_dedup ON runs(dedup_key) WHERE dedup_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS run_events (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, run_id TEXT NOT NULL, type TEXT NOT NULL,
  at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_run ON tool_calls(run_id, started_at);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, room_id TEXT NOT NULL, role TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, at);
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
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, room_id TEXT NOT NULL, paused INTEGER NOT NULL, next_run_at INTEGER, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS staged (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, deliver_after INTEGER NOT NULL, delivered_at INTEGER, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL, next_nudge_at INTEGER, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY, v TEXT NOT NULL
);
`;

function migrate(db: Database) {
  db.exec(SCHEMA);
}
