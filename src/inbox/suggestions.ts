import { DAY, fmtWhen, type Clock } from "../core/clock.ts";
import type { AgentSpec, Id, Person } from "../core/types.ts";
import type { ModelClient } from "../model/types.ts";
import type { Store } from "../store/repos.ts";
import type { CommitmentService } from "../care/commitments.ts";

export interface Suggestion {
  id: string;
  roomId: Id;
  title: string;
  prompt: string;
  category: "follow-up" | "upcoming" | "schedule" | "idea";
}

/**
 * "Want me to…" cards for the home page and the empty thread. Mined from
 * what the circle already has (the ledger, the schedules), not from the
 * person's inbox: the group's open threads are the honest source. A few
 * extra ideas come from the small model when there is enough context.
 */
export class SuggestionService {
  constructor(
    private store: Store,
    private clock: Clock,
    private commitments: CommitmentService,
    private model: ModelClient,
  ) {}

  /** Deterministic cards: overdue or blocked items, items due within two days, schedules firing today. */
  mined(person: Person, agent: AgentSpec): Suggestion[] {
    const now = this.clock.now();
    const out: Suggestion[] = [];
    const rooms = this.store.listRooms(agent.id).filter((r) => this.store.getMembership(r.id, person.id));
    const nameOf = (id: Id) => (id === agent.id ? agent.name : (this.store.getPerson(id)?.displayName ?? id));
    for (const room of rooms) {
      for (const c of this.commitments.open(room.id)) {
        const overdue = c.dueAt !== undefined && c.dueAt < now;
        if (c.status === "blocked" || overdue) {
          out.push({
            id: `s_${c.id}_chase`,
            roomId: room.id,
            title: `Chase "${c.title}"`,
            prompt: `Check on "${c.title}" with ${nameOf(c.ownerId)} and tell the room where it stands.`,
            category: "follow-up",
          });
        } else if (c.dueAt !== undefined && c.dueAt - now < 2 * DAY) {
          out.push({
            id: `s_${c.id}_confirm`,
            roomId: room.id,
            title: `Confirm "${c.title}"`,
            prompt: `Confirm "${c.title}" is still on for ${fmtWhen(c.dueAt, person.timezone)} and remind ${nameOf(c.ownerId)}.`,
            category: "upcoming",
          });
        }
      }
      for (const s of this.store.listSchedules({ roomId: room.id })) {
        if (!s.paused && s.nextRunAt !== undefined && s.nextRunAt - now < DAY) {
          out.push({
            id: `s_${s.id}_today`,
            roomId: room.id,
            title: `"${s.title}" runs today`,
            prompt: `Before "${s.title}" runs, check its premise still holds and tell me if anything changed.`,
            category: "schedule",
          });
        }
      }
    }
    return out.slice(0, 6);
  }

  /**
   * Names for a chat this person might start next, from what the assistant knows about
   * them: their notes, their chats so far. Nothing known means no suggestions, not stock
   * ones. Cached for a day per person.
   */
  async roomStarters(person: Person, agent: AgentSpec): Promise<string[]> {
    const key = `starters:${agent.id}:${person.id}`;
    const cached = this.store.getKv(key);
    if (cached) {
      try {
        const c = JSON.parse(cached) as { at: number; names: string[] };
        if (this.clock.now() - c.at < DAY) return c.names;
      } catch {
        /* stale shape; recompute */
      }
    }
    const rooms = this.store.listRooms(agent.id).filter((r) => r.kind === "group" && this.store.getMembership(r.id, person.id));
    // A note about this person counts only if it may be seen in a chat they are in: what someone told the
    // agent about them privately (visible in that someone's own chat) never comes back to them as a suggestion.
    const theirRooms = new Set(this.store.roomsForPerson(person.id));
    const notes = [
      ...this.store.listMemories(agent.id, { scope: "person", scopeId: person.id }).filter((m) => m.visibleToRooms.length === 0 || m.visibleToRooms.some((r) => theirRooms.has(r))),
      ...this.store.listMemories(agent.id, { scope: "agent", scopeId: agent.id }),
      ...rooms.flatMap((r) => this.store.listMemories(agent.id, { scope: "room", scopeId: r.id })),
    ]
      .filter((m) => m.type !== "observation" && m.type !== "rule")
      .slice(0, 40);
    if (!notes.length && !rooms.length) return [];
    let names: string[] = [];
    try {
      const raw = await this.model.complete({
        system:
          `Propose names for group chats ${person.displayName} might start next with the people around them, from what the assistant "${agent.name}" knows. ` +
          "Return only JSON: an array of up to 5 strings, two to four words each, concrete (a trip, a home, a family, a care circle, an event, a project), " +
          "none that repeat a chat they already have, no personal details in a name. Return [] when nothing fits.",
        prompt: `Their chats: ${rooms.map((r) => r.name).join(", ") || "(none)"}
Notes:
${notes.map((m) => `- ${m.text}`).join("\n") || "(none)"}`,
        effort: "low",
        maxTokens: 200,
      });
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      const parsed = start >= 0 && end > start ? (JSON.parse(raw.slice(start, end + 1)) as unknown[]) : [];
      const have = new Set(rooms.map((r) => r.name.toLowerCase()));
      names = [...new Set(parsed.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 40)))].filter((x) => x && !have.has(x.toLowerCase())).slice(0, 5);
    } catch {
      names = [];
    }
    this.store.setKv(key, JSON.stringify({ at: this.clock.now(), names }));
    return names;
  }

  /** Mined cards plus up to three ideas from the small model, de-duplicated, at most six. */
  async forHome(person: Person, agent: AgentSpec): Promise<Suggestion[]> {
    const mined = this.mined(person, agent);
    if (mined.length >= 3) return mined;
    const rooms = this.store.listRooms(agent.id).filter((r) => this.store.getMembership(r.id, person.id) && r.kind === "group");
    const room = rooms[0];
    if (!room) return mined;
    const recent = this.store
      .messagesForRoom(room.id, 20)
      .map((m) => `${m.role === "assistant" ? agent.name : (this.store.getPerson(m.authorId)?.displayName ?? "someone")}: ${m.text.slice(0, 160)}`)
      .join("\n");
    const ledger =
      this.commitments
        .open(room.id)
        .map((c) => `- ${c.title} (${c.status})`)
        .join("\n") || "(empty)";
    const memories = this.store
      .listMemories(agent.id, { scope: "room", scopeId: room.id })
      .slice(0, 12)
      .map((m) => `- ${m.text}`)
      .join("\n");
    let ideas: Suggestion[] = [];
    try {
      const raw = await this.model.complete({
        system:
          `You suggest things the assistant "${agent.name}" could do next for ${person.displayName}. Purpose: ${agent.purpose}. ` +
          'Return only JSON: an array of up to 3 objects {"title": "<four to six words, imperative>", "prompt": "<one sentence the person could type to ask for it>"}. ' +
          "Base them on open threads and what the group has mentioned. No made-up names, no medical or financial advice, nothing that contacts strangers without asking.",
        prompt: `Recent messages:\n${recent || "(none)"}\n\nOpen responsibilities:\n${ledger}\n\nNotes about this room:\n${memories || "(none)"}`,
        effort: "low",
        maxTokens: 800,
      });
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      const parsed = start >= 0 && end > start ? (JSON.parse(raw.slice(start, end + 1)) as { title?: unknown; prompt?: unknown }[]) : [];
      ideas = parsed
        .filter((x) => typeof x.title === "string" && typeof x.prompt === "string")
        .slice(0, 3)
        .map((x, i) => ({ id: `s_idea_${room.id}_${i}`, roomId: room.id, title: String(x.title), prompt: String(x.prompt), category: "idea" as const }));
    } catch {
      ideas = [];
    }
    const seen = new Set(mined.map((m) => m.title.toLowerCase()));
    return mined.concat(ideas.filter((i) => !seen.has(i.title.toLowerCase()))).slice(0, 6);
  }
}
