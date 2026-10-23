import type { Database } from "bun:sqlite";
import type {
  AgentSpec,
  Artifact,
  AttentionItem,
  AttentionStatus,
  Commitment,
  Membership,
  Memory,
  MemoryScope,
  Message,
  Person,
  Plan,
  Profile,
  Task,
  Approval,
  Room,
  Run,
  RunEvent,
  RunStatus,
  Schedule,
  Session,
  ToolCallRecord,
} from "../core/types.ts";

type Row = Record<string, unknown>;
const parse = <T>(row: Row | null | undefined): T | undefined => (row ? (JSON.parse(row.data as string) as T) : undefined);
const parseAll = <T>(rows: Row[]): T[] => rows.map((r) => JSON.parse(r.data as string) as T);

/** Thin repositories over the JSON-column tables. Indexed columns are duplicated from the JSON on write. */
export class Store {
  constructor(public readonly db: Database) {}

  // ----- persons -----
  putPerson(p: Person) {
    this.db.run("INSERT OR REPLACE INTO persons(id, data, created_at) VALUES (?, ?, ?)", [p.id, JSON.stringify(p), p.createdAt]);
  }
  getPerson(id: string) {
    return parse<Person>(this.db.query("SELECT data FROM persons WHERE id = ?").get(id) as Row | null);
  }
  /** Every reference to one person id, moved to another, in one transaction (identity merge). */
  reassignPerson(from: string, to: string) {
    this.db.transaction(() => {
      const json = (table: string, field: string, col?: string) =>
        this.db.run(
          `UPDATE ${table} SET ${col ? `${col} = ?, ` : ""}data = json_set(data, '$.${field}', ?) WHERE json_extract(data, '$.${field}') = ?`,
          col ? [to, to, from] : [to, from],
        );
      json("attention", "assigneeId", "assignee_id");
      json("attention", "requesterId");
      json("attention", "answeredBy");
      json("commitments", "ownerId", "owner_id");
      json("commitments", "beneficiaryId");
      json("runs", "requesterId");
      json("tasks", "requesterId");
      json("approvals", "decidedBy");
      json("agents", "ownerId", "owner_id");
      // The kept person's own connection wins when both connected the same service.
      this.db.run("UPDATE OR IGNORE credentials SET person_id = ? WHERE person_id = ?", [to, from]);
      this.db.run("DELETE FROM credentials WHERE person_id = ?", [from]);
    })();
  }

  findPersonByPhone(phone: string) {
    // ponytail: a json_extract scan; add a phone column and index if the people table ever gets big
    const p = parse<Person>(this.db.query("SELECT data FROM persons WHERE json_extract(data, '$.phoneE164') = ?").get(phone) as Row | null);
    // A merged record is an alias for history: the human lives at the record it points to.
    return p?.mergedInto ? this.getPerson(p.mergedInto) : p;
  }

  // ----- agents -----
  putAgent(a: AgentSpec) {
    // REPLACE would resolve a handle clash by deleting the other agent; refuse instead.
    const clash = this.db.query("SELECT id FROM agents WHERE handle = ? AND id != ?").get(a.handle, a.id);
    if (clash) throw new Error(`handle "${a.handle}" is taken by another agent`);
    this.db.run("INSERT OR REPLACE INTO agents(id, owner_id, handle, data) VALUES (?, ?, ?, ?)", [a.id, a.ownerId, a.handle, JSON.stringify(a)]);
  }
  getAgent(id: string) {
    return parse<AgentSpec>(this.db.query("SELECT data FROM agents WHERE id = ?").get(id) as Row | null);
  }
  /** A handle no other agent has: the name's, or the name's with a number. */
  freeHandle(base: string) {
    const root = base || "agent";
    for (let i = 1; ; i++) {
      const h = i === 1 ? root : `${root}-${i}`;
      if (!this.db.query("SELECT 1 FROM agents WHERE handle = ?").get(h)) return h;
    }
  }
  listAgents(ownerId?: string) {
    // Oldest first, stably: INSERT OR REPLACE gives an edited agent a new rowid, so rowid order would move it to the end.
    const order = "ORDER BY json_extract(data, '$.createdAt'), id";
    const rows = ownerId
      ? (this.db.query(`SELECT data FROM agents WHERE owner_id = ? ${order}`).all(ownerId) as Row[])
      : (this.db.query(`SELECT data FROM agents ${order}`).all() as Row[]);
    return parseAll<AgentSpec>(rows);
  }

  // ----- rooms and memberships -----
  putRoom(r: Room) {
    this.db.run("INSERT OR REPLACE INTO rooms(id, agent_id, channel, external_id, data) VALUES (?, ?, ?, ?, ?)", [
      r.id,
      r.agentId,
      r.channel,
      r.externalId ?? null,
      JSON.stringify(r),
    ]);
  }
  getRoom(id: string) {
    return parse<Room>(this.db.query("SELECT data FROM rooms WHERE id = ?").get(id) as Row | null);
  }
  findRoomByExternal(channel: string, externalId: string) {
    return parse<Room>(this.db.query("SELECT data FROM rooms WHERE channel = ? AND external_id = ?").get(channel, externalId) as Row | null);
  }
  listRooms(agentId?: string) {
    const rows = agentId ? (this.db.query("SELECT data FROM rooms WHERE agent_id = ?").all(agentId) as Row[]) : (this.db.query("SELECT data FROM rooms").all() as Row[]);
    return parseAll<Room>(rows);
  }
  putMembership(m: Membership) {
    this.db.run("INSERT OR REPLACE INTO memberships(room_id, person_id, role, data) VALUES (?, ?, ?, ?)", [m.roomId, m.personId, m.role, JSON.stringify(m)]);
  }
  deleteMembership(roomId: string, personId: string) {
    this.db.run("DELETE FROM memberships WHERE room_id = ? AND person_id = ?", [roomId, personId]);
  }
  listMembers(roomId: string) {
    return parseAll<Membership>(this.db.query("SELECT data FROM memberships WHERE room_id = ?").all(roomId) as Row[]);
  }
  getMembership(roomId: string, personId: string) {
    return parse<Membership>(this.db.query("SELECT data FROM memberships WHERE room_id = ? AND person_id = ?").get(roomId, personId) as Row | null);
  }
  roomsForPerson(personId: string) {
    const rows = this.db.query("SELECT room_id FROM memberships WHERE person_id = ?").all(personId) as Row[];
    return rows.map((r) => r.room_id as string);
  }

  // ----- sessions -----
  putSession(s: Session) {
    this.db.run(
      "INSERT INTO sessions(id, room_id, agent_id, kind, data, last_activity_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET room_id = excluded.room_id, agent_id = excluded.agent_id, kind = excluded.kind, data = excluded.data, last_activity_at = excluded.last_activity_at",
      [s.id, s.roomId, s.agentId, s.kind ?? "room", JSON.stringify(s), s.lastActivityAt],
    );
  }
  getSession(id: string) {
    return parse<Session>(this.db.query("SELECT data FROM sessions WHERE id = ?").get(id) as Row | null);
  }
  latestSessionForRoom(roomId: string) {
    // Only the room's own conversation; a task agent's session must never answer for the room.
    return parse<Session>(
      this.db.query("SELECT data FROM sessions WHERE room_id = ? AND kind = 'room' ORDER BY last_activity_at DESC, rowid DESC LIMIT 1").get(roomId) as Row | null,
    );
  }

  // ----- runs -----
  putRun(r: Run) {
    this.db.run(
      "INSERT INTO runs(id, session_id, room_id, agent_id, status, dedup_key, started_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data",
      [r.id, r.sessionId, r.roomId, r.agentId, r.status, r.dedupKey ?? null, r.startedAt, JSON.stringify(r)],
    );
  }
  getRun(id: string) {
    return parse<Run>(this.db.query("SELECT data FROM runs WHERE id = ?").get(id) as Row | null);
  }
  findRunByDedup(key: string) {
    return parse<Run>(this.db.query("SELECT data FROM runs WHERE dedup_key = ?").get(key) as Row | null);
  }
  activeRunForSession(sessionId: string) {
    return parse<Run>(
      this.db.query("SELECT data FROM runs WHERE session_id = ? AND status IN ('running','waiting') ORDER BY started_at DESC, rowid DESC LIMIT 1").get(sessionId) as Row | null,
    );
  }
  listRuns(opts: { agentId?: string; roomId?: string; status?: RunStatus[]; limit?: number } = {}) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.agentId) {
      where.push("agent_id = ?");
      args.push(opts.agentId);
    }
    if (opts.roomId) {
      where.push("room_id = ?");
      args.push(opts.roomId);
    }
    if (opts.status?.length) {
      where.push(`status IN (${opts.status.map(() => "?").join(",")})`);
      args.push(...opts.status);
    }
    const sql = `SELECT data FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, rowid DESC LIMIT ${Math.min(Math.max(1, opts.limit ?? 50), 500)}`;
    return parseAll<Run>(this.db.query(sql).all(...(args as string[])) as Row[]);
  }

  // ----- run events (the watch cursor) -----
  appendEvent(e: Omit<RunEvent, "seq">): RunEvent {
    const tx = this.db.transaction(() => {
      const row = this.db.query("SELECT COALESCE(MAX(seq), 0) AS m FROM run_events WHERE session_id = ?").get(e.sessionId) as Row;
      const seq = (row.m as number) + 1;
      this.db.run("INSERT INTO run_events(session_id, seq, run_id, type, at, data) VALUES (?, ?, ?, ?, ?, ?)", [e.sessionId, seq, e.runId, e.type, e.at, JSON.stringify(e.data)]);
      return seq;
    });
    const seq = tx();
    return { ...e, seq };
  }
  eventsAfter(sessionId: string, cursor: number, limit = 500): RunEvent[] {
    const rows = this.db
      .query("SELECT session_id, seq, run_id, type, at, data FROM run_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(sessionId, cursor, limit) as Row[];
    return rows.map((r) => ({
      sessionId: r.session_id as string,
      seq: r.seq as number,
      runId: r.run_id as string,
      type: r.type as RunEvent["type"],
      at: r.at as number,
      data: JSON.parse(r.data as string),
    }));
  }
  eventsForRun(runId: string): RunEvent[] {
    const rows = this.db.query("SELECT session_id, seq, run_id, type, at, data FROM run_events WHERE run_id = ? ORDER BY seq").all(runId) as Row[];
    return rows.map((r) => ({
      sessionId: r.session_id as string,
      seq: r.seq as number,
      runId: r.run_id as string,
      type: r.type as RunEvent["type"],
      at: r.at as number,
      data: JSON.parse(r.data as string),
    }));
  }
  lastSeq(sessionId: string): number {
    const row = this.db.query("SELECT COALESCE(MAX(seq), 0) AS m FROM run_events WHERE session_id = ?").get(sessionId) as Row;
    return row.m as number;
  }

  // ----- tool calls -----
  putToolCall(t: ToolCallRecord) {
    this.db.run("INSERT OR REPLACE INTO tool_calls(id, run_id, name, status, started_at, data) VALUES (?, ?, ?, ?, ?, ?)", [
      t.id,
      t.runId,
      t.name,
      t.status,
      t.startedAt,
      JSON.stringify(t),
    ]);
  }
  toolCallsForRun(runId: string) {
    return parseAll<ToolCallRecord>(this.db.query("SELECT data FROM tool_calls WHERE run_id = ? ORDER BY started_at").all(runId) as Row[]);
  }

  // ----- messages -----
  putMessage(m: Message) {
    this.db.run("INSERT INTO messages(id, session_id, room_id, role, at, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", [
      m.id,
      m.sessionId,
      m.roomId,
      m.role,
      m.at,
      JSON.stringify(m),
    ]);
  }
  getMessage(id: string) {
    return parse<Message>(this.db.query("SELECT data FROM messages WHERE id = ?").get(id) as Row | null);
  }
  messagesForSession(sessionId: string, limit = 200): Message[] {
    const rows = this.db.query("SELECT data FROM messages WHERE session_id = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(sessionId, Math.min(Math.max(1, limit), 500)) as Row[];
    return parseAll<Message>(rows).reverse();
  }
  /** Chat search: newest messages in the given rooms whose text contains the words, one SQL LIKE per word. */
  // ponytail: LIKE over json_extract; move messages into an FTS5 table if a circle's history ever makes this slow
  searchMessages(roomIds: string[], query: string, limit = 50): Message[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    if (!roomIds.length || !words.length) return [];
    const like = words.map(() => "lower(json_extract(data, '$.text')) LIKE ? ESCAPE '\\'").join(" AND ");
    const args = [...roomIds, ...words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`), Math.min(Math.max(1, limit), 200)];
    const rows = this.db.query(`SELECT data FROM messages WHERE room_id IN (${roomIds.map(() => "?").join(",")}) AND ${like} ORDER BY at DESC LIMIT ?`).all(...args) as Row[];
    return parseAll<Message>(rows);
  }
  messagesForRoom(roomId: string, limit = 200): Message[] {
    const rows = this.db.query("SELECT data FROM messages WHERE room_id = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(roomId, Math.min(Math.max(1, limit), 500)) as Row[];
    return parseAll<Message>(rows).reverse();
  }

  // ----- memories -----
  putMemory(m: Memory) {
    const tx = this.db.transaction(() => {
      this.db.run("INSERT OR REPLACE INTO memories(id, agent_id, scope, scope_id, type, stated_at, retracted, superseded, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        m.id,
        m.agentId,
        m.scope,
        m.scopeId,
        m.type,
        m.statedAt,
        m.retractedAt ? 1 : 0,
        m.supersededBy ? 1 : 0,
        JSON.stringify(m),
      ]);
      this.db.run("DELETE FROM memories_fts WHERE id = ?", [m.id]);
      this.db.run("INSERT INTO memories_fts(id, text, aliases) VALUES (?, ?, ?)", [m.id, m.text, m.aliases.join(" ")]);
    });
    tx();
  }
  getMemory(id: string) {
    return parse<Memory>(this.db.query("SELECT data FROM memories WHERE id = ?").get(id) as Row | null);
  }
  listMemories(agentId: string, opts: { scope?: MemoryScope; scopeId?: string; includeInactive?: boolean; type?: string } = {}) {
    const where = ["agent_id = ?"];
    const args: unknown[] = [agentId];
    if (opts.scope) {
      where.push("scope = ?");
      args.push(opts.scope);
    }
    if (opts.scopeId) {
      where.push("scope_id = ?");
      args.push(opts.scopeId);
    }
    if (opts.type) {
      where.push("type = ?");
      args.push(opts.type);
    }
    if (!opts.includeInactive) where.push("retracted = 0 AND superseded = 0");
    const rows = this.db.query(`SELECT data FROM memories WHERE ${where.join(" AND ")} ORDER BY stated_at DESC`).all(...(args as string[])) as Row[];
    return parseAll<Memory>(rows);
  }
  /** Keyword search over text and aliases, FTS5 ranked, newest wins on ties. */
  searchMemories(agentId: string, query: string, limit = 20): Memory[] {
    const terms = query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"`).join(" OR ");
    const rows = this.db
      .query(
        `SELECT m.data AS data, bm25(memories_fts) AS rank FROM memories_fts f JOIN memories m ON m.id = f.id
         WHERE memories_fts MATCH ? AND m.agent_id = ? AND m.retracted = 0 AND m.superseded = 0
         ORDER BY rank, m.stated_at DESC LIMIT ?`,
      )
      .all(match, agentId, limit) as Row[];
    return parseAll<Memory>(rows);
  }
  putProfile(p: Profile) {
    this.db.run("INSERT OR REPLACE INTO profiles(agent_id, scope, scope_id, text, derived_at) VALUES (?, ?, ?, ?, ?)", [p.agentId, p.scope, p.scopeId, p.text, p.derivedAt]);
  }
  deleteProfile(agentId: string, scope: MemoryScope, scopeId: string) {
    this.db.run("DELETE FROM profiles WHERE agent_id = ? AND scope = ? AND scope_id = ?", [agentId, scope, scopeId]);
  }
  getProfile(agentId: string, scope: MemoryScope, scopeId: string): Profile | undefined {
    const r = this.db.query("SELECT * FROM profiles WHERE agent_id = ? AND scope = ? AND scope_id = ?").get(agentId, scope, scopeId) as Row | null;
    return r ? { agentId, scope, scopeId, text: r.text as string, derivedAt: r.derived_at as number } : undefined;
  }

  // ----- attention -----
  putAttention(a: AttentionItem) {
    this.db.run(
      "INSERT INTO attention(id, agent_id, room_id, assignee_id, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id, room_id = excluded.room_id, assignee_id = excluded.assignee_id, status = excluded.status, created_at = excluded.created_at, data = excluded.data",
      [a.id, a.agentId, a.roomId, a.assigneeId, a.status, a.createdAt, JSON.stringify(a)],
    );
  }
  getAttention(id: string) {
    return parse<AttentionItem>(this.db.query("SELECT data FROM attention WHERE id = ?").get(id) as Row | null);
  }
  listAttention(opts: { assigneeId?: string; agentId?: string; roomId?: string; status?: AttentionStatus[] } = {}) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.assigneeId) {
      where.push("assignee_id = ?");
      args.push(opts.assigneeId);
    }
    if (opts.agentId) {
      where.push("agent_id = ?");
      args.push(opts.agentId);
    }
    if (opts.roomId) {
      where.push("room_id = ?");
      args.push(opts.roomId);
    }
    if (opts.status?.length) {
      where.push(`status IN (${opts.status.map(() => "?").join(",")})`);
      args.push(...opts.status);
    }
    const sql = `SELECT data FROM attention ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC`;
    return parseAll<AttentionItem>(this.db.query(sql).all(...(args as string[])) as Row[]);
  }

  // ----- schedules -----
  putSchedule(s: Schedule) {
    this.db.run(
      "INSERT INTO schedules(id, agent_id, room_id, paused, next_run_at, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id, room_id = excluded.room_id, paused = excluded.paused, next_run_at = excluded.next_run_at, data = excluded.data",
      [s.id, s.agentId, s.roomId, s.paused ? 1 : 0, s.nextRunAt ?? null, JSON.stringify(s)],
    );
  }
  getSchedule(id: string) {
    return parse<Schedule>(this.db.query("SELECT data FROM schedules WHERE id = ?").get(id) as Row | null);
  }
  listSchedules(opts: { agentId?: string; roomId?: string } = {}) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.agentId) {
      where.push("agent_id = ?");
      args.push(opts.agentId);
    }
    if (opts.roomId) {
      where.push("room_id = ?");
      args.push(opts.roomId);
    }
    const sql = `SELECT data FROM schedules ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    return parseAll<Schedule>(this.db.query(sql).all(...(args as string[])) as Row[]);
  }
  dueSchedules(now: number) {
    return parseAll<Schedule>(this.db.query("SELECT data FROM schedules WHERE paused = 0 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(now) as Row[]);
  }

  // ----- commitments -----
  putCommitment(c: Commitment) {
    this.db.run(
      "INSERT INTO commitments(id, room_id, owner_id, status, next_nudge_at, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET room_id = excluded.room_id, owner_id = excluded.owner_id, status = excluded.status, next_nudge_at = excluded.next_nudge_at, data = excluded.data",
      [c.id, c.roomId, c.ownerId, c.status, c.nextNudgeAt ?? null, JSON.stringify(c)],
    );
  }
  getCommitment(id: string) {
    return parse<Commitment>(this.db.query("SELECT data FROM commitments WHERE id = ?").get(id) as Row | null);
  }
  listCommitments(opts: { roomId?: string; ownerId?: string; status?: string[] } = {}) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.roomId) {
      where.push("room_id = ?");
      args.push(opts.roomId);
    }
    if (opts.ownerId) {
      where.push("owner_id = ?");
      args.push(opts.ownerId);
    }
    if (opts.status?.length) {
      where.push(`status IN (${opts.status.map(() => "?").join(",")})`);
      args.push(...opts.status);
    }
    const sql = `SELECT data FROM commitments ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    return parseAll<Commitment>(this.db.query(sql).all(...(args as string[])) as Row[]);
  }
  dueCommitments(now: number) {
    return parseAll<Commitment>(this.db.query("SELECT data FROM commitments WHERE status = 'open' AND next_nudge_at IS NOT NULL AND next_nudge_at <= ?").all(now) as Row[]);
  }

  // ----- plans -----
  putPlan(p: Plan) {
    this.db.run("INSERT OR REPLACE INTO plans(id, run_id, data) VALUES (?, ?, ?)", [p.id, p.runId, JSON.stringify(p)]);
  }
  planForRun(runId: string) {
    return parse<Plan>(this.db.query("SELECT data FROM plans WHERE run_id = ?").get(runId) as Row | null);
  }

  // ----- approvals -----
  putApproval(a: Approval) {
    this.db.run(
      "INSERT INTO approvals(id, agent_id, room_id, run_id, gate_key, decided_at, data) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      [a.id, a.agentId, a.roomId, a.runId, a.gateKey, a.decidedAt, JSON.stringify(a)],
    );
  }
  approvalsFor(roomId: string, gateKey: string): Approval[] {
    return parseAll<Approval>(this.db.query("SELECT data FROM approvals WHERE room_id = ? AND gate_key = ? ORDER BY decided_at DESC, rowid DESC").all(roomId, gateKey) as Row[]);
  }
  /** Runs left running or waiting, for reconciliation at boot. */
  unfinishedRuns(): Run[] {
    return parseAll<Run>(this.db.query("SELECT data FROM runs WHERE status IN ('running','waiting') ORDER BY started_at").all() as Row[]);
  }

  // ----- tasks -----
  putTask(t: Task) {
    this.db.run(
      "INSERT INTO tasks(id, agent_id, room_id, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id, room_id = excluded.room_id, status = excluded.status, created_at = excluded.created_at, data = excluded.data",
      [t.id, t.agentId, t.roomId, t.status, t.createdAt, JSON.stringify(t)],
    );
  }
  getTask(id: string) {
    return parse<Task>(this.db.query("SELECT data FROM tasks WHERE id = ?").get(id) as Row | null);
  }
  listTasks(opts: { agentId?: string; roomId?: string; status?: Task["status"][] } = {}) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.agentId) {
      where.push("agent_id = ?");
      args.push(opts.agentId);
    }
    if (opts.roomId) {
      where.push("room_id = ?");
      args.push(opts.roomId);
    }
    if (opts.status?.length) {
      where.push(`status IN (${opts.status.map(() => "?").join(",")})`);
      args.push(...opts.status);
    }
    const sql = `SELECT data FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC`;
    return (this.db.query(sql).all(...args) as Row[]).map((r) => JSON.parse(r.data as string) as Task);
  }

  // ----- credentials (ciphertext only; the vault holds the key) -----
  putCredential(personId: string, service: string, ciphertext: string, at: number) {
    this.db.run("INSERT OR REPLACE INTO credentials(person_id, service, ciphertext, updated_at) VALUES (?, ?, ?, ?)", [personId, service, ciphertext, at]);
  }
  getCredential(personId: string, service: string): string | undefined {
    const r = this.db.query("SELECT ciphertext FROM credentials WHERE person_id = ? AND service = ?").get(personId, service) as Row | null;
    return r ? (r.ciphertext as string) : undefined;
  }
  listCredentialServices(personId: string): string[] {
    return (this.db.query("SELECT service FROM credentials WHERE person_id = ? ORDER BY service").all(personId) as Row[]).map((r) => r.service as string);
  }
  deleteCredential(personId: string, service: string) {
    this.db.run("DELETE FROM credentials WHERE person_id = ? AND service = ?", [personId, service]);
  }

  // ----- artifacts -----
  putArtifact(a: Artifact) {
    this.db.run("INSERT OR REPLACE INTO artifacts(id, agent_id, room_id, kind, created_at, data) VALUES (?, ?, ?, ?, ?, ?)", [
      a.id,
      a.agentId,
      a.roomId ?? null,
      a.kind,
      a.createdAt,
      JSON.stringify(a),
    ]);
  }
  getArtifact(id: string) {
    return parse<Artifact>(this.db.query("SELECT data FROM artifacts WHERE id = ?").get(id) as Row | null);
  }
  listArtifacts(agentId: string, opts: { roomId?: string; limit?: number } = {}): Artifact[] {
    const rows = opts.roomId
      ? (this.db.query("SELECT data FROM artifacts WHERE agent_id = ? AND room_id = ? ORDER BY created_at DESC LIMIT ?").all(agentId, opts.roomId, opts.limit ?? 50) as Row[])
      : (this.db.query("SELECT data FROM artifacts WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?").all(agentId, opts.limit ?? 50) as Row[]);
    return parseAll<Artifact>(rows);
  }

  // ----- kv -----
  getKv(k: string): string | undefined {
    const r = this.db.query("SELECT v FROM kv WHERE k = ?").get(k) as Row | null;
    return r ? (r.v as string) : undefined;
  }
  deleteKv(k: string) {
    this.db.run("DELETE FROM kv WHERE k = ?", [k]);
  }
  setKv(k: string, v: string) {
    this.db.run("INSERT OR REPLACE INTO kv(k, v) VALUES (?, ?)", [k, v]);
  }

  // ----- error log: operational, not a run record, so it is pruned -----
  logError(at: number, source: string, message: string, keep = 1000) {
    this.db.run("INSERT INTO errors(at, source, message) VALUES (?, ?, ?)", [at, source, message]);
    this.db.run("DELETE FROM errors WHERE id <= (SELECT MAX(id) FROM errors) - ?", [keep]);
  }
  listErrors(opts: { since?: number; limit?: number } = {}): { id: number; at: number; source: string; message: string }[] {
    return this.db.query("SELECT id, at, source, message FROM errors WHERE at >= ? ORDER BY id DESC LIMIT ?").all(opts.since ?? 0, opts.limit ?? 100) as never;
  }
}
