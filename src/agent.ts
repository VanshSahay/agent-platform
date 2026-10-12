// The run loop. A message becomes a run: one model turn that may call tools, then a reply. Writes wait for the
// requester's yes (unless they put that action on their trust list); a person's accounts in a group wait for their
// consent once; a reply pending when someone new joins a group is held. The reply never claims more than the
// verified tool executions. The same loop serves iMessage and the web training chat.
import { sql, id, now, one, J, fmtLocal, zoned, PLATFORM_TZ } from "./db";
import * as rooms from "./rooms";
import * as model from "./model";
import * as gw from "./tools/index";
import "./tools/google"; import "./tools/web"; import "./tools/browser"; import "./tools/core";
import { retrieve, rules } from "./memory";
import { listSkills } from "./skills";
import * as im from "./imessage";
import { describe } from "./media";
import { publicUrl } from "./links";

const YES = /^\s*(yes|y|yep|yeah|yup|sure|ok|okay|go ahead|do it|send it|approve|approved|👍)\b/i;
const NO = /^\s*(no|nope|don'?t|cancel|skip|stop|reject|👎)\b/i;
// ponytail: a correction is spotted by its opening words; the smart tier then handles it. Replace with a model flag if it misfires.
const CORRECTION = /^\s*(no[,.! ]|not that|actually|i meant|that'?s (wrong|not)|wrong[,.! ])/i;
const CLAIMS = /\b(sent|booked|reserved|purchased|paid|cancell?ed|ordered)\b/i; // ponytail: past-tense action words the footer must back up
const MAX_TURNS = 12;

export async function onInbound(ev: im.Inbound) {
  const user = await rooms.userByPhone(ev.phone);
  const room = await rooms.roomForSpace(ev.spaceId, ev.isGroup, user);
  if (ev.reaction) return onReaction(ev.reaction, user);
  // Nobody texts an untrained agent. A private text from a number that isn't a trained web account gets one pointer a day.
  if (!ev.isGroup && !user.clerk_id) {
    if (!(await one(sql`select 1 from messages where room_id=${room.id} and direction='out' and created_at>${now() - 864e5}`)))
      await say(room, `Hi! I'm an assistant, but I haven't been set up for this number yet. Train yours first at ${publicUrl()}, then deploy it to iMessage from Settings.`);
    return;
  }
  if (ev.isGroup) { const owner = room.owner_id ? await rooms.userById(room.owner_id) : null; if (!owner?.clerk_id) return; } // a group's agent belongs to a trained account
  return handleMessage(room, user, ev.text, ev.attachments, ev.externalId);
}

/** One message from a person, in any room. Attachments are file ids already stored. */
export async function handleMessage(room: any, user: any, text: string, attachments?: string[], externalId?: string) {
  if (attachments?.length) text = [text, ...(await Promise.all(attachments.map((f) => describe(f, room, user))))].filter(Boolean).join("\n");
  if (!text.trim()) return;
  if (!(await rooms.storeMessage({ roomId: room.id, senderId: user.id, direction: "in", text, externalId }))) return; // seen before

  // Plain-words answers to what we asked: an approval card, a consent question, a held reply.
  const pending = await one(sql`select * from approvals where user_id=${user.id} and status='pending' and (room_id=${room.id} or (kind='consent' and ${room.kind === "private"})) order by created_at desc limit 1`);
  if (pending && (YES.test(text) || NO.test(text))) return decide(pending, YES.test(text));
  if (room.kind === "private") {
    const held = await one(sql`select * from runs where requester_id=${user.id} and status='held' order by created_at desc limit 1`);
    if (held && /^\s*(go|post|yes|send it|share it)\b/i.test(text)) return releaseHeld(held);
    if (held && /^\s*(drop|no|skip|cancel|never mind)\b/i.test(text)) { await sql`update runs set status='done', updated_at=${now()} where id=${held.id}`; return say(room, "Dropped it."); }
  }
  if (room.kind === "group" && !(await shouldRespond(room, user, text))) return;
  await runRequest(room, user, text);
}

/** In a group: answer when named, or when the owner's instructions cover the topic (one cheap yes/no). */
async function shouldRespond(room: any, user: any, text: string) {
  const name = await rooms.agentNameFor(room);
  if (new RegExp(`(^|\\W)@?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`, "i").test(text) || /^\s*@/.test(text)) return true;
  if (!room.instructions) return false;
  const recent = (await rooms.recentMessages(room.id, 6)).map((m: any) => `${m.direction === "out" ? name : rooms.displayName(m)}: ${m.text}`).join("\n");
  try {
    const r = await model.structured<{ respond: boolean }>("cheap", `You are ${name}, an assistant in a group chat. The person who added you said what you should do here:\n"""${room.instructions}"""\nDecide whether the latest message is something you should answer under those instructions. Stay quiet for chatter between people that doesn't need you. Return {"respond": true|false}.`, `Recent:\n${recent}\n\nLatest from ${rooms.displayName(user)}: ${text}`, user.id);
    return !!r.respond;
  } catch { return false; }
}

export async function runRequest(room: any, requester: any, request: string) {
  const rid = id("run");
  const tier: model.Tier = CORRECTION.test(request) ? "smart" : "cheap";
  await sql`insert into runs (id, room_id, requester_id, request, status, tier, tier_reason, created_at, updated_at) values (${rid}, ${room.id}, ${requester.id}, ${request}, 'running', ${tier}, ${tier === "smart" ? "correction" : null}, ${now()}, ${now()})`;
  if (room.space_id) await im.typing(room.space_id).catch(() => {});
  return step(await one(sql`select * from runs where id=${rid}`));
}
export const working = async (roomId: string) => !!(await one(sql`select 1 from runs where room_id=${roomId} and status='running' and updated_at>${now() - 10 * 60_000}`));

const needsSmart = (tools: gw.ToolDef[], c: model.ToolCall) => { const d = tools.find((t) => t.id === c.name); return !d || gw.kindOf(d, c.input) === "write" || c.name === "browser.task" || c.name.startsWith("mcp."); };

/** Advance a run until it replies or waits. `resume` carries tool calls left over from a wait (first one decided). */
async function step(run: any, resume?: { calls: model.ToolCall[]; approved?: boolean; rejected?: boolean }) {
  const room = await one(sql`select * from rooms where id=${run.room_id}`), requester = await rooms.userById(run.requester_id);
  const tools = await gw.toolsFor(requester.id);
  let msgs: model.Msg[] = J(run.transcript, []);
  if (!msgs.length) msgs = [{ role: "system", content: await systemPrompt(room, requester, tools) }, { role: "user", content: await userMessage(room, requester, run.request) }];
  let tier: model.Tier = run.tier, reason = run.tier_reason, cost = Number(run.cost_usd), calls = Number((await one(sql`select count(*) n from tool_executions where run_id=${run.id}`))?.n ?? 0);
  const save = (status: string) => sql`update runs set transcript=${JSON.stringify(msgs)}::text::jsonb, status=${status}, tier=${tier}, tier_reason=${reason}, cost_usd=${cost}, updated_at=${now()} where id=${run.id}`;

  const runCalls = async (list: model.ToolCall[], first?: { approved?: boolean; rejected?: boolean }): Promise<"waited" | "ok"> => {
    for (const [i, c] of list.entries()) {
      if (i === 0 && first?.rejected) { msgs.push({ role: "tool", toolCallId: c.id, content: "REJECTED: the person said no to this action. Do not do it; tell them it was skipped." }); continue; }
      const r = await gw.execute(run, room, requester, c, tools, { approved: i === 0 && !!first?.approved });
      if (r.kind === "approval") { await save("waiting_approval"); await askApproval(run, room, requester, c, list.slice(i), r.summary, r.preview); return "waited"; }
      if (r.kind === "consent") { await save("waiting_consent"); await askConsent(run, room, requester, c, list.slice(i)); return "waited"; }
      msgs.push({ role: "tool", toolCallId: c.id, content: r.content }); calls++;
    }
    return "ok";
  };
  if (resume && (await runCalls(resume.calls, resume)) === "waited") return;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let res: model.Res;
    try { res = await model.generate({ tier, messages: msgs, tools: gw.specsOf(tools), userId: requester.id, runId: run.id }); }
    catch (e: any) { await save("failed"); return say(room, e instanceof model.CapReached ? `I've hit today's budget, so I'm pausing until tomorrow. Sorry about that.` : `Something went wrong on my side (${e.message.slice(0, 120)}). Try again in a bit.`, run.id); }
    cost += res.costUsd;
    if (res.toolCalls.length) {
      const heavy = res.toolCalls.find((c) => needsSmart(tools, c));
      if (tier === "cheap" && (heavy || calls + res.toolCalls.length >= 3)) { tier = "smart"; reason = heavy ? `tool ${heavy.name}` : "3+ steps"; continue; }
      msgs.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
      if ((await runCalls(res.toolCalls)) === "waited") return;
      continue;
    }
    msgs.push({ role: "assistant", content: res.text });
    await save("running");
    return finish(run, room, requester, res.text, tools);
  }
  await save("running");
  return finish(run, room, requester, "I ran out of steps before finishing this. Here's where I got to; tell me how to continue.", tools);
}

/** The reply plus a status footer built from verified executions, never from the model's words. */
async function finish(run: any, room: any, requester: any, text: string, tools: gw.ToolDef[]) {
  const execs = await sql`select * from tool_executions where run_id=${run.id} order by created_at`;
  const writes = execs.filter((e: any) => { const d = tools.find((t) => t.id === e.tool); return d && gw.kindOf(d, e.input) === "write"; });
  const lines = writes.map((e: any) => { const d = tools.find((t) => t.id === e.tool)!; const s = gw.summarize(d, e.input); return e.verified ? `✓ ${s}` : e.status === "unknown" ? `? ${s}: not confirmed, please check` : `✗ ${s}: didn't happen`; });
  let reply = text.trim();
  if (CLAIMS.test(reply) && !writes.some((w: any) => w.verified)) reply += "\n\n(To be clear: nothing has actually been sent, booked or changed yet.)";
  if (lines.length) reply += `\n\n${lines.join("\n")}`;
  const fresh = await one(sql`select last_join_at from rooms where id=${room.id}`);
  if (room.kind === "group" && fresh?.last_join_at && Number(fresh.last_join_at) > Number(run.created_at)) {
    await sql`update runs set status='held', reply=${reply}, updated_at=${now()} where id=${run.id}`;
    const dm = await dmRoom(requester);
    return say(dm, `Someone new joined "${room.name ?? "the group"}" while I was working on your request, so I'm holding my reply. Say "go" to post it there, or "drop" to skip it.\n\nIt was:\n${reply}`);
  }
  await sql`update runs set status='done', reply=${reply}, updated_at=${now()} where id=${run.id}`;
  await say(room, reply, run.id);
}

async function releaseHeld(run: any) {
  const room = await one(sql`select * from rooms where id=${run.room_id}`);
  await sql`update runs set status='done', updated_at=${now()} where id=${run.id}`;
  await say(room, run.reply, run.id);
}

// ---- approvals and consent, answered in words or with a tapback ----
async function askApproval(run: any, room: any, requester: any, call: model.ToolCall, rest: model.ToolCall[], summary: string, preview?: string) {
  const aid = id("apr");
  const stored = { call: { ...call, fingerprint: gw.fingerprint(run.id, call.name, call.input) }, rest: rest.slice(1) };
  const text = `${summary}${preview ? `\n\n${preview}` : ""}\n\nReply "yes" to go ahead or "no" to skip.${room.space_id ? " (A 👍 or 👎 on this message works too.)" : ""}`;
  const extId = await say(room, text, run.id);
  await sql`insert into approvals (id, run_id, room_id, user_id, kind, call, summary, out_message_id, created_at) values (${aid}, ${run.id}, ${room.id}, ${requester.id}, 'action', ${JSON.stringify(stored)}::text::jsonb, ${summary}, ${extId ?? null}, ${now()})`;
}
async function askConsent(run: any, room: any, requester: any, call: model.ToolCall, rest: model.ToolCall[]) {
  const aid = id("apr"), dm = await dmRoom(requester), name = await rooms.agentNameFor(room);
  const text = `In "${room.name ?? "your group chat"}" you asked ${name} for something that uses your own accounts. OK to use your accounts in that group when you ask? Reply yes or no. (You can say "stop using my accounts here" in the group any time.)`;
  const extId = await say(dm, text, run.id);
  await sql`insert into approvals (id, run_id, room_id, user_id, kind, call, summary, out_message_id, created_at) values (${aid}, ${run.id}, ${room.id}, ${requester.id}, 'consent', ${JSON.stringify({ call, rest: rest.slice(1) })}::text::jsonb, ${"use your accounts in this group"}, ${extId ?? null}, ${now()})`;
}
async function onReaction(r: { emoji: string; targetId: string }, user: any) {
  const a = await one(sql`select * from approvals where out_message_id=${r.targetId} and status='pending' and user_id=${user.id}`);
  if (!a) return;
  if (/^(👍|❤️|♥️|‼️|like|love|emphasi[sz]e|thumbs_?up)$/i.test(r.emoji)) return decide(a, true);
  if (/^(👎|dislike|thumbs_?down)$/i.test(r.emoji)) return decide(a, false);
}
async function decide(a: any, yes: boolean) {
  await sql`update approvals set status=${yes ? "approved" : "rejected"}, decided_at=${now()} where id=${a.id}`;
  const run = await one(sql`select * from runs where id=${a.run_id}`), stored = J(a.call, {});
  if (!run || run.status === "done") return;
  if (a.kind === "consent") {
    if (yes) await rooms.grantConsent(a.room_id, a.user_id);
    const user = await rooms.userById(a.user_id);
    await say(await dmRoom(user), yes ? "Got it. I'll carry on in the group." : "Understood; I won't use your accounts there.");
    const calls = [stored.call, ...(stored.rest ?? [])];
    return step(run, yes ? { calls } : { calls, rejected: true });
  }
  return step(run, { calls: [stored.call, ...(stored.rest ?? [])], approved: yes, rejected: !yes });
}

// ---- context ----
const isoDate = (tz: string) => { const z = zoned(now(), tz); return `${z.y}-${String(z.mo + 1).padStart(2, "0")}-${String(z.d).padStart(2, "0")}`; };
const shortDate = (ts: any, tz: string) => new Date(Number(ts)).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
async function systemPrompt(room: any, requester: any, tools: gw.ToolDef[]) {
  const name = await rooms.agentNameFor(room), tz = requester.tz ?? PLATFORM_TZ();
  const skills = await listSkills();
  const who = room.kind === "group" ? `You are ${name}, the agent for the group chat "${room.name ?? "Group chat"}" in iMessage. You act for the group, not for any one person.`
    : room.channel === "web" ? `You are ${name}, ${rooms.displayName(requester)}'s personal agent. This is their training chat on the web: they are teaching you how they live and what they want done, before you work for them in iMessage and their group chats. Everything you remember here is yours in those chats too.`
    : `You are ${name}, ${rooms.displayName(requester)}'s personal agent, talking with them in iMessage.`;
  const hasPhone = tools.some((t) => t.id.startsWith("mcp."));
  const standing = await rules(room, requester.id);
  return [
    who,
    standing.length ? `Standing rules from ${room.kind === "group" ? "this group" : rooms.displayName(requester)} (follow them over anything below):\n${standing.map((m: any) => `- ${m.text}`).join("\n")}` : ``,
    `Now: ${fmtLocal(now(), tz)} (${tz}); today's date in ISO form is ${isoDate(tz)}. Use that year in any date you write.`,
    `Style: text messages. Short, plain, specific. No markdown, no headers, no bullet symbols; a dash list is fine. Lead with the answer or the question. Ask at most one question at a time.`,
    `Doing things: use tools; never pretend. Prefer a connected account (Google) first, then a public API or the web, then the browser for sites that need clicking${hasPhone ? ", then the person's phone (phone_* tools) for native apps or anything already signed in on the phone" : ""}. Sends, calendar changes, purchases and completing bookings are approved by the person before they happen unless they've put that action on their trust list; the platform asks them, you just call the tool with the final content. Never say something was sent, booked or done unless the tool result confirmed it; the platform adds a short status footer, don't repeat it. If a tool says DENIED with a link, pass the link on in plain words.`,
    `Memory: everything a person tells you about themselves is training. Call remember for each of it, with the right kind, one fact per call; when they tell you several things at once, save each. How they want you to behave (when to ask, when to just do it, tone, what never to do) is kind=rule and you follow it from then on. Private things stay private. Memories are shown with the date they were saved; newer beats older, and an inventory line is only as current as its date.`,
    room.kind === "group" ? `Group rules: anyone here can ask for reads (search, weather, a tally). A member's Google, phone or browser is used only when that member asks, for their own request. Never reveal anything from anyone's private chat. If asked about another member's accounts or private matters, decline kindly. The person who brought you in${room.owner_id === requester.id ? " (that's who you're talking to now)" : ""} can set what you do here with room.set_instructions.` : ``,
    room.instructions ? `What the group's owner asked you to do here: """${room.instructions}"""` : ``,
    room.kind === "private" && !requester.onboarded ? (room.channel === "web"
      ? `First conversation: you're new and in training. In one short message say so, ask what to call you, and ask them to start teaching you: what they'd like to hand off, how they want you to behave, and whatever about their life matters for that. When they name you, call agent.rename. When they share their name or where they live, call profile.update. Save each thing they teach you with remember.`
      : `First conversation here: introduce yourself in one line (you work for them here and in any group they add you to) and ask what they'd like help with first. When they share their name or where they live, call profile.update.`) : ``,
    `Skills (read one with skill.read before a task of that kind):\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");
}
async function userMessage(room: any, requester: any, request: string) {
  const name = await rooms.agentNameFor(room), tz = requester.tz ?? PLATFORM_TZ();
  const history = (await rooms.recentMessages(room.id, 30)).slice(0, -1).map((m: any) => `${m.direction === "out" ? name : rooms.displayName(m.sender_name ? { name: m.sender_name } : { phone: m.sender_phone })}: ${m.text}`).join("\n");
  const mems = await retrieve(room, requester.id, request);
  const members = room.kind === "group" ? (await rooms.members(room.id)).map((m: any) => `${rooms.displayName(m)}${m.id === room.owner_id ? " (brought you in)" : ""}`).join(", ") : "";
  return [
    members ? `People in this group: ${members}` : ``,
    mems.length ? `Things you remember (${room.kind === "private" ? "theirs and this chat's" : "this chat's"}):\n${mems.map((m: any) => `- [${m.id}] (${m.kind}, ${shortDate(m.created_at, tz)}) ${m.text}`).join("\n")}` : ``,
    history ? `Recent conversation:\n${history}` : ``,
    `New message from ${rooms.displayName(requester)}: ${request}`,
  ].filter(Boolean).join("\n\n");
}

// ---- sending ----
/** iMessage rooms go out over the line; the web room is read by the browser, so storing is sending. */
export async function say(room: any, text: string, runId?: string | null): Promise<string | undefined> {
  const extId = room.space_id ? await im.send(room.space_id, text).catch((e) => { console.error(`[send] ${room.id}: ${e.message}`); return undefined; }) : undefined;
  await rooms.storeMessage({ roomId: room.id, senderId: null, direction: "out", text, externalId: extId ?? null, runId });
  return extId;
}
/** The person's own chat with the agent: iMessage if they have a phone, else their web chat; opened by the agent if they've only ever been in a group. */
export async function dmRoom(user: any) {
  const r = await rooms.privateRoomOf(user.id);
  if (r) return r;
  if (!user.phone) return rooms.webRoomOf(user);
  const spaceId = await im.startDm(user.phone, `Hi, I'm the assistant from your group chat. I'll send you anything that's just for you here.`);
  return rooms.createPrivateRoom(user, spaceId);
}
/** First contact from the landing page: the agent opens the DM (shared-pool lines can't be texted first). */
export async function startConversation(phone: string) {
  const user = await rooms.userByPhone(phone);
  const existing = await rooms.privateRoomOf(user.id);
  if (existing) { await say(existing, "I'm here. What can I do for you?"); return existing; }
  const hello = user.agent_name ? `Hi, it's ${user.agent_name}. I'm here in iMessage now too, with everything you taught me. What can I do for you?`
    : `Hi! I'm your new assistant. I work for you here, and in any group chat you add me to. Two quick things: what should I call myself, and what would you like help with first?`;
  const spaceId = await im.startDm(user.phone, hello);
  const room = await rooms.createPrivateRoom(user, spaceId);
  await rooms.storeMessage({ roomId: room.id, senderId: null, direction: "out", text: hello });
  return room;
}
/** A scheduled job fires: deliver a message, or wake the agent with a task. */
export async function fireSchedule(s: any, kind: "message" | "task", text: string): Promise<void> {
  const room = await one(sql`select * from rooms where id=${s.room_id}`), user = await rooms.userById(s.user_id);
  if (!room || !user) return;
  if (kind === "message") { await say(room, text); return; }
  await runRequest(room, user, `[Scheduled job you set earlier fires now; do it and report briefly] ${text}`);
}
