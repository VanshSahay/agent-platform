// The friendship signal: who a person mentions in their own private chat, and who has gone quiet. Counted from their own
// messages only, never from the family's; surfaced only to them, as a suggestion they can decline.
import { all, one, now, J } from "./db";
import * as rt from "./runtime";
import type { ToolDef } from "./tools";

const NOT_NAMES = new Set(["I", "The", "A", "An", "My", "Me", "You", "We", "He", "She", "It", "They", "This", "That", "What", "When", "Where", "Why", "How", "Who", "Can", "Could", "Please", "Thanks", "Thank", "Ok", "Okay", "Yes", "No", "Not", "And", "But", "Or", "So", "If", "Then", "Also", "Just", "Hi", "Hey", "Hello", "Dr", "Mr", "Mrs", "Ms", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December", "Uber", "Lyft", "Amazon", "Google", "Apple", "Netflix", "Costco", "Walmart", "Target"]);

/** People named in the person's own messages here: how often and when last. ponytail: capitalised-word heuristic, the agent's names come first. */
export function mentions(roomId: string, userId: string, agentName: string) {
  const seen = new Map<string, { n: number; last: number; first: number }>();
  for (const e of all<any>("select ts, data from events where room_id=? and type='message' and actor=? order by seq", roomId, userId)) {
    const text = String(J(e.data, {}).text ?? "");
    for (const m of text.matchAll(/(?:^|[\s,.!?("'])([A-Z][a-z]{1,15})(?=$|[\s,.!?)"':;-])/g)) {
      const name = m[1];
      if (NOT_NAMES.has(name) || name === agentName) continue;
      const cur = seen.get(name) ?? { n: 0, last: 0, first: e.ts };
      cur.n++; cur.last = Math.max(cur.last, e.ts); seen.set(name, cur);
    }
  }
  return [...seen].map(([name, v]) => ({ name, ...v })).filter((p) => p.n >= 2).sort((a, b) => b.n - a.n);
}

export function registerPeopleTools(def: (d: ToolDef) => void) {
  def({
    id: "people.quiet", description: "In a person's private chat: the friends and family they've mentioned to you, and who they haven't mentioned in a while (quiet_days, default 30). Use it to suggest reaching out — one gentle suggestion, only to the person themselves, never reported to anyone else.",
    risk: "read", idempotency: "safe", defaultApproval: "none",
    inputSchema: { type: "object", properties: { quiet_days: { type: "number" } }, additionalProperties: false },
    async execute({ quiet_days = 30 }, ctx) {
      if (ctx.room.kind !== "private") throw new Error("people.quiet works only in a person's private chat");
      const all_ = mentions(ctx.room.id, ctx.run.requested_by, ctx.agent.id), cutoff = now() - Number(quiet_days) * 864e5;
      const days = (t: number) => Math.floor((now() - t) / 864e5);
      return { status: "SUCCEEDED", output: {
        people: all_.slice(0, 20).map((p) => ({ name: p.name, mentioned: p.n, last_mentioned_days_ago: days(p.last) })),
        quiet: all_.filter((p) => p.last < cutoff && p.n >= 3).slice(0, 5).map((p) => ({ name: p.name, last_mentioned_days_ago: days(p.last) })),
        note: "Names come from what the person said here. Suggest, don't nag: at most one 'haven't heard you mention X lately — want to reach out?' per week, and drop it if they say no." } };
    },
  });
  void one; void rt;
}
