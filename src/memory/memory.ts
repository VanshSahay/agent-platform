import { newId } from "../core/ids.ts";
import type { Clock } from "../core/clock.ts";
import type { Id, Memory, MemoryScope, MemoryType, Room } from "../core/types.ts";
import type { Store } from "../store/repos.ts";

/**
 * Memory rules, taken from what works in Fo and Instinct and what we wanted:
 *  - the agent only writes `observation` memories during a run (raw, dated);
 *  - a background pass promotes observations into typed, deduplicated memories,
 *    generalises examples into traits, rewrites corrected facts with the date,
 *    and derives a short profile the agent reads first on every run;
 *  - retrieval is keyword over text + aliases (FTS5), newest wins on ties;
 *  - every memory has a scope and a visibility list, so what a group says
 *    stays with that group and a person's DM facts never surface in a group
 *    unless the person said them there.
 */
export class MemoryService {
  constructor(
    private store: Store,
    private clock: Clock,
  ) {}

  write(input: {
    agentId: Id;
    scope: MemoryScope;
    scopeId: Id;
    type: MemoryType;
    text: string;
    aliases?: string[];
    subjectPersonId?: Id;
    visibleToRooms?: Id[];
    statedAt?: number;
    sourceRunId?: Id;
  }): Memory {
    const now = this.clock.now();
    const m: Memory = {
      id: newId("mem"),
      agentId: input.agentId,
      scope: input.scope,
      scopeId: input.scopeId,
      type: input.type,
      subjectPersonId: input.subjectPersonId,
      visibleToRooms: input.visibleToRooms ?? (input.scope === "room" ? [input.scopeId] : []),
      text: input.text.trim(),
      aliases: dedupe((input.aliases ?? []).concat(autoAliases(input.text))),
      statedAt: input.statedAt ?? now,
      sourceRunId: input.sourceRunId,
      createdAt: now,
    };
    this.store.putMemory(m);
    return m;
  }

  /** A newer memory replaces an older one; the old one stays for history. */
  supersede(oldId: Id, replacement: Memory) {
    const old = this.store.getMemory(oldId);
    if (!old) return;
    old.supersededBy = replacement.id;
    this.store.putMemory(old);
  }

  retract(id: Id) {
    const m = this.store.getMemory(id);
    if (!m) return;
    m.retractedAt = this.clock.now();
    this.store.putMemory(m);
  }

  /**
   * Everything the agent may see while working in `room` for a request from
   * `requesterId`: agent-scope memories, the room's own memories, and the
   * person-scope memories of people in the room that are visible to the
   * room. A person's DM memories are visible in a group only if marked so.
   */
  visibleIn(agentId: Id, room: Room, memberIds: Id[], opts: { requesterId?: Id } = {}): Memory[] {
    const out: Memory[] = [];
    out.push(...this.store.listMemories(agentId, { scope: "agent", scopeId: agentId }));
    out.push(...this.store.listMemories(agentId, { scope: "room", scopeId: room.id }));
    for (const pid of memberIds) {
      const personal = this.store.listMemories(agentId, { scope: "person", scopeId: pid });
      for (const m of personal) {
        // In a person's own chat, their own notes apply wherever they were learned, as long as every room the
        // note names is one they are in: a note about Sam from the group shows in Sam's chat, while a note
        // someone else made about Sam in that someone's own chat names a room Sam is not in, so it stays
        // there (multiplayer-spec §9.2: "that DM only"). Never another member's notes, whatever the room size.
        const inDm = room.kind === "dm" && pid === opts.requesterId && m.visibleToRooms.every((r) => !!this.store.getMembership(r, pid));
        if (inDm || m.visibleToRooms.includes(room.id)) out.push(m);
      }
    }
    return out.filter((m) => m.type !== "observation" || isRecent(m, this.clock.now()));
  }

  /** Keyword recall restricted to what the room may see. */
  recall(agentId: Id, room: Room, memberIds: Id[], query: string, limit = 12, opts: { requesterId?: Id } = {}): Memory[] {
    const allowed = new Set(this.visibleIn(agentId, room, memberIds, { requesterId: opts.requesterId }).map((m) => m.id));
    return this.store
      .searchMemories(agentId, query, limit * 6)
      .filter((m) => allowed.has(m.id))
      .slice(0, limit);
  }

  rulesFor(agentId: Id, room: Room, memberIds: Id[]): Memory[] {
    return this.visibleIn(agentId, room, memberIds).filter((m) => m.type === "rule");
  }
}

function isRecent(m: Memory, now: number) {
  return now - m.statedAt < 3 * 24 * 60 * 60 * 1000;
}

function dedupe(xs: string[]) {
  return Array.from(new Set(xs.map((x) => x.toLowerCase().trim()).filter(Boolean)));
}

const STOP = new Set(
  "the a an and or but of to in on at for with from by is are was were be been it this that these those i you he she they we me him her them us my your his their our its as about into over under not no yes do does did have has had will would can could should may might".split(
    " ",
  ),
);

/** Cheap aliasing: content words of the memory itself, so grep-style recall hits. */
function autoAliases(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w))
    .slice(0, 12);
}
