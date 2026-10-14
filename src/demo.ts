/**
 * Offline walkthrough with a scripted model: the "Mandarin-speaking handyman"
 * errand in a family group chat, end to end, with no API key. Run with
 * `bun run demo`. The same runtime, store, gates and timers as production;
 * only the model's decisions are scripted.
 */
import { createApp } from "./app.ts";
import { FakeClock, HOUR } from "./core/clock.ts";
import { callTool, lastToolResult, lastUserText, reply, ScriptedModel, toolCallsSoFar, transcriptHas } from "./model/scripted.ts";
import { fakeHands, FakeCommunity, FakePhone, FakeSearch } from "./tools/hands.ts";
import { seedDemoWorld } from "./demo-world.ts";

const clock = new FakeClock(Date.UTC(2026, 9, 13, 17, 0, 0)); // 10:00 Los Angeles

const search = new FakeSearch(() => []); // the web turns up nothing useful this time
const community = new FakeCommunity(() => [
  { author: "u/sunnyvale_mom", text: "Try Mr. Lin at Lin Home Repair, 408-555-0142, speaks Mandarin, did our fence.", at: clock.now() },
  { author: "u/sjlocal", text: "Great Wall Handyman 408-555-0199, Mandarin and Cantonese, bit pricey.", at: clock.now() },
]);
const phone = new FakePhone((to) =>
  to.endsWith("0142")
    ? { summary: "Mr. Lin speaks Mandarin. Free Thursday 2pm or Saturday 10am. Dripping tap: $90-120 including parts.", status: "completed" }
    : { summary: "Great Wall: Mandarin yes. Earliest next Tuesday. $150 minimum.", status: "completed" },
);

const POST = {
  community: "reddit:r/sanjose",
  title: "Mandarin-speaking handyman recommendations?",
  body: "Looking for a reliable handyman who speaks Mandarin for small repairs (a dripping kitchen tap) in San Jose. Any recommendations?",
};
const CALL_LIN = { to: "+14085550142", who: "Lin Home Repair", objective: "Confirm Mandarin; dripping kitchen tap at a home in San Jose; availability this week; price range. Do not book.", language: "zh" };
const CALL_GW = { to: "+14085550199", who: "Great Wall Handyman", objective: "Confirm Mandarin; dripping kitchen tap; availability this week; price range. Do not book.", language: "zh" };

/** Results of every call to `name`, oldest first, by pairing tool_use ids with tool_result blocks. */
function resultsFor(req: Parameters<typeof lastToolResult>[0], name: string): string[] {
  const idToName = new Map<string, string>();
  const out: string[] = [];
  for (const m of req.messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") idToName.set(b.id, b.name);
      if (b.type === "tool_result" && idToName.get(b.tool_use_id) === name) out.push(typeof b.content === "string" ? b.content : JSON.stringify(b.content));
    }
  }
  return out;
}
const countIn = (req: Parameters<typeof lastToolResult>[0], needle: string) =>
  req.messages.filter((m) => m.role === "user" && typeof m.content === "string" && m.content.includes(needle)).length;

const model = new ScriptedModel((req) => {
  const calls = toolCallsSoFar(req);
  const n = (name: string) => calls.filter((c) => c.name === name).length;
  const lastCall = calls.at(-1);
  const results = (name: string) => resultsFor(req, name);
  const waiting = ["post_community", "place_call"].flatMap((t) => results(t)).filter((r) => r.includes("Waiting for the owner")).length;
  const approvals = countIn(req, "[APPROVED]");

  // Follow-up and heartbeat runs: a short, honest check-in.
  if (lastUserText(req).includes("Follow-up on responsibility")) return reply("Reminder: Lin Home Repair comes to Mum's tomorrow (Thu) at 2pm, $90–120. Ben, are you still around to let him in?");
  if (lastUserText(req).includes("Heartbeat check-in")) return callTool("stay_quiet", { reason: "nothing due before Thursday" });

  if (!calls.length) {
    return callTool("plan", {
      goal: "Find a Mandarin-speaking handyman to fix the dripping tap at Mum's, and let Ellie choose.",
      steps: [
        { text: "Find candidates who speak Mandarin near Mum", approach: "search" },
        { text: "Call candidates: confirm language, availability this week, price range", approach: "call" },
        { text: "Compare and let Ellie choose", approach: "wait" },
      ],
    });
  }
  if (n("search_memory") === 0) return callTool("search_memory", { query: "handyman mandarin repair" });
  if (n("web_search") === 0) return callTool("web_search", { query: "Mandarin speaking handyman San Jose", near: "San Jose, CA" });
  if (n("web_search") === 1) return callTool("web_search", { query: "handyman 普通话 San Jose" });
  if (n("ask_room") === 0) return callTool("ask_room", { question: "Does anyone know a Mandarin-speaking handyman near Mum's? Otherwise I'll ask r/sanjose, with Ellie's OK." });
  if (lastCall?.name === "ask_room" && !transcriptHas(req, "[ANSWERED]")) return reply("Asked the family; waiting to hear back.");

  // A gate is open and not yet approved: say so and stop.
  if (waiting > approvals) {
    const who = String(lastCall?.input.who ?? lastCall?.input.community ?? "that");
    return reply(lastCall?.name === "post_community" ? "I've drafted a post for r/sanjose and asked Ellie to OK it. Nothing is public yet." : `I've asked Ellie to OK calling ${who}.`);
  }

  // Community post, then read replies.
  if (!results("post_community").some((r) => r.includes("postId"))) return callTool("post_community", POST);
  if (n("read_community_replies") === 0) return callTool("read_community_replies", { postId: "post_1" });

  // Calls, each gated once; re-issued after the yes.
  if (!results("place_call").some((r) => r.includes("Mr. Lin speaks"))) return callTool("place_call", CALL_LIN);
  if (!results("place_call").some((r) => r.includes("Great Wall: Mandarin"))) return callTool("place_call", CALL_GW);

  if (n("compare_options") === 0)
    return callTool("compare_options", {
      title: "Handymen who speak Mandarin",
      options: [
        { name: "Lin Home Repair", price: "$90–120 incl. parts", availability: "Thu 2pm or Sat 10am", notes: "Mandarin; recommended on r/sanjose" },
        { name: "Great Wall Handyman", price: "$150 minimum", availability: "next Tuesday", notes: "Mandarin and Cantonese" },
      ],
      recommendation: "Lin: sooner and cheaper.",
    });
  if (n("wait_for_user_input") === 0)
    return callTool("wait_for_user_input", { question: "Lin Home Repair (Thu 2pm or Sat 10am, $90–120) or Great Wall (next Tue, $150+)? Which one, and which slot?", kind: "decision", options: ["Lin Thu 2pm", "Lin Sat 10am", "Great Wall Tue"] });
  if (lastCall?.name === "wait_for_user_input" && !transcriptHas(req, "Lin Thu 2pm")) return reply("Two options above; tell me which and I'll book it.");
  if (n("track_commitment") === 0) return callTool("track_commitment", { title: "Lin Home Repair fixes the kitchen tap at Mum's", owner: "me", beneficiary: "Mum", dueAt: "2026-10-15T21:00:00Z", detail: "Thu 2pm, $90–120 incl. parts, Mandarin-speaking" });
  if (n("remember") === 0) return callTool("remember", { type: "store", text: "Lin Home Repair (408-555-0142) is a Mandarin-speaking handyman the family used for Mum's tap.", about: "Mum" });
  return reply("Lin Home Repair is coming Thursday 2pm to fix Mum's tap, $90–120 including parts. I'll remind whoever is there the day before.");
});

const app = createApp({ clock, model, hands: fakeHands({ search, phone, community }), heartbeatEveryMs: 24 * HOUR });
const w = seedDemoWorld(app);
const name = (id: string) => (id === w.agent.id ? w.agent.name : (app.store.getPerson(id)?.displayName ?? id));
app.onDeliver((d) => {
  const room = app.store.getRoom(d.roomId);
  const where = room?.kind === "dm" ? `[private: ${room.name}]` : `[${room?.name}]`;
  const tag = d.kind === "reply" ? w.agent.name : `${w.agent.name} (${d.kind})`;
  console.log(`${where} ${tag}: ${d.text}\n`);
});
const say = async (roomId: string, personId: string, text: string) => {
  console.log(`[${app.store.getRoom(roomId)?.name}] ${name(personId)}: ${text}\n`);
  return app.runtime.handleMessage({ roomId, personId, text });
};

console.log("=== A family group chat, offline, scripted model ===\n");
await say(w.family.id, w.wei.id, "@pip Mum's kitchen tap is dripping again. Can you find someone who speaks Mandarin to fix it?");
clock.advance(20 * 60_000);
await say(w.family.id, w.ben.id, "I don't know anyone, sorry.");
clock.advance(5 * 60_000);
console.log(">>> Ellie's inbox:", app.attention.openFor(w.ellie.id).map((i) => `${i.kind}: ${i.title}`), "\n");
await say(w.ellieDm.id, w.ellie.id, "Yes, post it.");
clock.advance(5 * 60_000);
await say(w.ellieDm.id, w.ellie.id, "Yes");
clock.advance(5 * 60_000);
await say(w.ellieDm.id, w.ellie.id, "Yes");
clock.advance(5 * 60_000);
await say(w.family.id, w.ellie.id, "Lin Thu 2pm");

console.log("=== Ellie's home ===");
const inbox = app.attention.inbox(w.ellie.id, w.agent.id);
console.log("Needs you:", inbox.needsYou.map((i) => i.title));
console.log("Last activity:", inbox.activity.map((r) => `${r.status}: ${r.outcome ?? r.failureReason ?? ""}`));
console.log("Ledger:\n" + app.commitments.describe(w.family.id, name, "America/Los_Angeles"));
const run = app.store.listRuns({ roomId: w.family.id })[0]!;
console.log("\nRecorded steps for the last run:");
for (const c of app.store.toolCallsForRun(run.id)) console.log(`  ${c.status.padEnd(7)} ${c.name.padEnd(22)} ${c.labelDone}${c.evidence ? `  [${c.evidence}]` : ""}`);
console.log("\n=== The day before: the nudge fires ===\n");
clock.set(Date.UTC(2026, 9, 14, 21, 0, 1));
await app.scheduler.tick();
