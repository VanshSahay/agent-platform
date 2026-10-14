import type { Clock } from "../core/clock.ts";
import type { AgentSpec, Id, Memory, MemoryType } from "../core/types.ts";
import type { ModelClient } from "../model/types.ts";
import type { Store } from "../store/repos.ts";
import type { MemoryService } from "./memory.ts";

/**
 * The background writer. Runs once a day (or on demand). For each scope it:
 *  1. promotes raw observations into typed memories,
 *  2. merges duplicates and generalises repeated examples into traits,
 *  3. rewrites corrected facts as dated supersessions,
 *  4. retracts what was explicitly taken back,
 *  5. derives a short profile the agent reads first.
 * The agent itself never edits durable memory; it only writes observations.
 */
export class Consolidator {
  constructor(
    private store: Store,
    private clock: Clock,
    private model: ModelClient,
    private memory: MemoryService,
  ) {}

  async runFor(agent: AgentSpec): Promise<{ scopes: number; promoted: number; retracted: number; superseded: number }> {
    const stats = { scopes: 0, promoted: 0, retracted: 0, superseded: 0 };
    const all = this.store.listMemories(agent.id);
    const scopes = new Map<string, Memory[]>();
    for (const m of all) {
      const k = `${m.scope}:${m.scopeId}`;
      scopes.set(k, (scopes.get(k) ?? []).concat(m));
    }
    for (const [key, mems] of scopes) {
      stats.scopes += 1;
      const r = await this.consolidateScope(agent, mems);
      stats.promoted += r.promoted;
      stats.retracted += r.retracted;
      stats.superseded += r.superseded;
      const [scope, scopeId] = key.split(":") as [Memory["scope"], string];
      await this.deriveProfile(agent, scope, scopeId);
    }
    this.store.setKv(`consolidated:${agent.id}`, String(this.clock.now()));
    return stats;
  }

  private async consolidateScope(agent: AgentSpec, mems: Memory[]) {
    const stats = { promoted: 0, retracted: 0, superseded: 0 };
    const observations = mems.filter((m) => m.type === "observation");
    const durable = mems.filter((m) => m.type !== "observation");
    if (!observations.length) return stats;

    const listing = (xs: Memory[]) => xs.map((m) => `${m.id} | ${new Date(m.statedAt).toISOString().slice(0, 10)} | ${m.type} | ${m.text}`).join("\n");
    const raw = await this.model.complete({
      system:
        "You maintain an agent's long-term memory. Return only JSON: an array of operations. " +
        'Operations: {"op":"promote","id":<observation id>,"type":<rule|preference|person|schedule|store|inventory|decision|fact|lesson>,"text":<rewritten, specific, third person>,"aliases":[...]} ' +
        '{"op":"merge","ids":[<observation or memory ids>],"type":...,"text":...,"aliases":[...]} (one memory replaces several) ' +
        '{"op":"correct","old":<memory id>,"id":<observation id>,"type":...,"text":<corrected fact, keep the date it changed>} ' +
        '{"op":"retract","id":<memory or observation id>} (explicitly taken back, or a one-time code/secret). ' +
        "Generalise repeated examples into a trait. Drop incidental detail. Keep dates. Never invent.",
      prompt: `Durable memories:\n${listing(durable) || "(none)"}\n\nNew observations:\n${listing(observations)}\n\nJSON:`,
      effort: "low",
    });
    const ops = parseOps(raw);
    const handled = new Set<string>();
    // The model names memories by id; only ids from this scope's own listing are acted on.
    const byId = new Map<string, Memory>(durable.concat(observations).map((m) => [m.id, m]));
    const own = (id: unknown) => (typeof id === "string" ? byId.get(id) : undefined);
    const validType = (t: unknown): MemoryType => (TYPES.has(String(t)) ? (String(t) as MemoryType) : "fact");

    for (const op of ops) {
      if (op.op === "retract" && own(op.id)) {
        this.memory.retract(String(op.id));
        handled.add(String(op.id));
        stats.retracted += 1;
      } else if (op.op === "promote" && own(op.id)) {
        const src = own(op.id)!;
        const nm = this.memory.write({ ...scopeOf(src), agentId: agent.id, type: validType(op.type), text: String(op.text ?? src.text), aliases: arr(op.aliases), statedAt: src.statedAt, sourceRunId: src.sourceRunId });
        this.memory.supersede(src.id, nm);
        handled.add(src.id);
        stats.promoted += 1;
      } else if (op.op === "merge" && Array.isArray(op.ids) && op.ids.length) {
        const srcs = op.ids.map((id) => own(id)).filter((m): m is Memory => !!m);
        if (!srcs.length) continue;
        const newest = srcs.reduce((a, b) => (a.statedAt > b.statedAt ? a : b));
        const nm = this.memory.write({ ...scopeOf(newest), agentId: agent.id, type: validType(op.type), text: String(op.text ?? newest.text), aliases: arr(op.aliases), statedAt: newest.statedAt });
        for (const s of srcs) (this.memory.supersede(s.id, nm), handled.add(s.id));
        stats.superseded += srcs.length;
      } else if (op.op === "correct" && own(op.old) && own(op.id)) {
        const src = own(op.id)!;
        const old = own(op.old)!;
        const nm = this.memory.write({ ...scopeOf(old), agentId: agent.id, type: validType(op.type ?? old.type), text: String(op.text ?? src.text), aliases: arr(op.aliases).concat(old.aliases), statedAt: src.statedAt });
        this.memory.supersede(old.id, nm);
        this.memory.supersede(src.id, nm);
        handled.add(src.id);
        handled.add(old.id);
        stats.superseded += 1;
      }
    }
    // Deterministic fallback: anything the model did not handle is promoted verbatim using its bracketed hint.
    for (const o of observations) {
      if (handled.has(o.id)) continue;
      const m = o.text.match(/^\[(\w+)\]\s*(.*)$/s);
      const nm = this.memory.write({ ...scopeOf(o), agentId: agent.id, type: validType(m?.[1]), text: m?.[2] ?? o.text, aliases: o.aliases, statedAt: o.statedAt, sourceRunId: o.sourceRunId });
      this.memory.supersede(o.id, nm);
      stats.promoted += 1;
    }
    return stats;
  }

  /**
   * Person profiles come in two: one from facts the person shared with a room
   * (safe anywhere they are a member) and one that also holds what they told the
   * agent privately, used only in their own chat. Agent and room scopes have one.
   */
  async deriveProfile(agent: AgentSpec, scope: Memory["scope"], scopeId: Id) {
    const all = this.store.listMemories(agent.id, { scope, scopeId }).filter((m) => m.type !== "observation");
    if (scope === "person") {
      await this.writeProfile(agent, scope, scopeId, all.filter((m) => m.visibleToRooms.length > 0));
      await this.writeProfile(agent, scope, privateProfileId(scopeId), all);
      return;
    }
    await this.writeProfile(agent, scope, scopeId, all);
  }

  private async writeProfile(agent: AgentSpec, scope: Memory["scope"], scopeId: Id, mems: Memory[]) {
    if (!mems.length) return;
    const ownerName = this.store.getPerson(agent.ownerId)?.displayName ?? "the owner";
    const who =
      scope === "person"
        ? (this.store.getPerson(scopeId.replace(/#private$/, ""))?.displayName ?? "this person")
        : scope === "room"
          ? `the room "${this.store.getRoom(scopeId)?.name ?? scopeId}"`
          : `the assistant ${agent.name}'s own standing instructions from its owner ${ownerName} (write it as "how ${ownerName} wants ${agent.name} to work", not as facts about ${agent.name})`;
    const text = await this.model.complete({
      system:
        "Write a short profile (under 180 words) an assistant reads before every conversation: who they are, how they like things done, standing arrangements, open threads, what to be careful about. Dated facts keep their dates. Plain prose, no headings. If a fact is old, say when it was last confirmed.",
      prompt: `Subject: ${who}\nMemories:\n${mems.map((m) => `${new Date(m.statedAt).toISOString().slice(0, 10)} [${m.type}] ${m.text}`).join("\n")}`,
      effort: "low",
    });
    const profileText = text.trim() || mems.slice(0, 8).map((m) => m.text).join(" ");
    this.store.putProfile({ agentId: agent.id, scope, scopeId, text: profileText, derivedAt: this.clock.now() });
  }
}

const TYPES = new Set(["rule", "preference", "person", "schedule", "store", "inventory", "decision", "fact", "lesson"]);

/** Where the private (own-chat-only) profile of a person is stored. */
export function privateProfileId(personId: Id) {
  return `${personId}#private`;
}

function scopeOf(m: Memory) {
  return { scope: m.scope, scopeId: m.scopeId, subjectPersonId: m.subjectPersonId, visibleToRooms: m.visibleToRooms };
}
function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}
type Op = { op: string; id?: unknown; ids?: unknown[]; old?: unknown; type?: unknown; text?: unknown; aliases?: unknown };
function parseOps(raw: string): Op[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    const v = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object" && typeof x.op === "string") as Op[]) : [];
  } catch {
    return [];
  }
}
