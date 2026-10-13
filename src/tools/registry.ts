import type { Clock } from "../core/clock.ts";
import type { AgentSpec, ApproachKind, AttentionItem, AttentionKind, Id, Room, Run, Session } from "../core/types.ts";
import type { ToolSpec } from "../model/types.ts";
import type { Store } from "../store/repos.ts";
import type { MemoryService } from "../memory/memory.ts";
import type { RoomService } from "../rooms/rooms.ts";
import type { AttentionService } from "../inbox/attention.ts";
import type { CommitmentService } from "../care/commitments.ts";
import type { Planner } from "../planning/planner.ts";
import type { Hands } from "./hands.ts";

export type ToolFamily = "plan" | "search" | "people" | "calls" | "community" | "memory" | "schedule" | "care" | "money";

/** What a tool hands back to the runtime. */
export interface ToolResult {
  ok: boolean;
  /** What the model sees. Objects are JSON-encoded. */
  content: unknown;
  /** Provider evidence that the effect happened. */
  evidence?: string;
  /** The run must pause until this attention item is answered. */
  waitingOn?: AttentionItem;
  /** The approach stalled (no results, no answer); the planner should count it. */
  stall?: string;
  /** Message the agent should relay to the room verbatim (e.g. "I've asked Ellie to OK that"). */
  roomNotice?: string;
  /** Plan progress signal when the tool embodies an approach. */
  approach?: ApproachKind;
}

export type GateDecision = { granted: true; reason: string } | { granted: false; item: AttentionItem; notice?: string } | { granted: false; held: string };

export interface ToolContext {
  store: Store;
  clock: Clock;
  memory: MemoryService;
  rooms: RoomService;
  attention: AttentionService;
  commitments: CommitmentService;
  planner: Planner;
  hands: Hands;
  agent: AgentSpec;
  room: Room;
  session: Session;
  run: Run;
  requesterId?: Id;
  /** Ask for a yes before an effect, or learn it was pre-authorised. */
  gate(input: { kind: AttentionKind; title: string; detail: string; money?: number; outreach?: { who: string; how: "phone" | "sms" | "email" | "community_post" } }): GateDecision;
  /** Send a message to a person's private chat with the agent (cards, questions). */
  dm(personId: Id, text: string): void;
  /** Resolve a member by name or id inside this room. */
  findMember(nameOrId: string): { id: Id; name: string } | undefined;
  progress(text: string): void;
}

export interface ToolDef {
  spec: ToolSpec;
  family: ToolFamily;
  labels: { running: string; done: string; failed?: string };
  /** Writes or contacts someone. Side-effect tools ask first unless trusted. */
  sideEffect: boolean;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []): ToolSpec["input_schema"] =>
  ({ type: "object", properties, required, additionalProperties: false }) as ToolSpec["input_schema"];
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

const s = (v: unknown) => (typeof v === "string" ? v : "");
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// ----------------------------------------------------------------------------

export const TOOLS: ToolDef[] = [
  {
    spec: {
      name: "plan",
      description:
        "Write or replace the plan for this request before doing multi-step work. Each step names the approach you will try first; fallbacks are filled in automatically (search, ask the group, call, ask a community with permission, ask a person). Keep steps concrete.",
      input_schema: obj(
        {
          goal: str("What done looks like, in one sentence."),
          steps: {
            type: "array",
            items: obj(
              {
                text: str("The step."),
                approach: { type: "string", enum: ["search", "ask_room", "ask_person", "call", "community_post", "browse", "wait"] },
              },
              ["text", "approach"],
            ),
          },
        },
        ["goal", "steps"],
      ),
    },
    family: "plan",
    labels: { running: "Planning…", done: "Made a plan" },
    sideEffect: false,
    async run(input, ctx) {
      const steps = Array.isArray(input.steps) ? (input.steps as { text: string; approach: ApproachKind }[]) : [];
      if (!steps.length) return { ok: false, content: "A plan needs at least one step." };
      const plan = ctx.planner.create(ctx.run.id, s(input.goal), steps);
      return { ok: true, content: ctx.planner.describe(plan) };
    },
  },
  {
    spec: {
      name: "web_search",
      description: "Search the web. Use for businesses, hours, prices, how-tos and anything public. Returns titles, URLs and snippets.",
      input_schema: obj({ query: str("Search query."), near: str("Optional place to bias results, e.g. a city.") }, ["query"]),
    },
    family: "search",
    labels: { running: "Searching the web…", done: "Searched the web" },
    sideEffect: false,
    async run(input, ctx) {
      const r = await ctx.hands.search.search(s(input.query), { near: s(input.near) || undefined, limit: 8 });
      if (!r.results.length) return { ok: true, content: "No results.", evidence: r.evidence, stall: `no results for "${s(input.query)}"`, approach: "search" };
      return { ok: true, content: r.results, evidence: r.evidence, approach: "search" };
    },
  },
  {
    spec: {
      name: "browse_page",
      description:
        "Open a web page in a real browser and read it as text (hours, prices, booking forms, listings). Optionally fill one field or click one element first. Never enter passwords or payment details; stop and ask the person instead.",
      input_schema: obj(
        {
          url: str("Absolute URL."),
          click: str("CSS selector or text=... selector to click after load, if needed."),
          fill: obj({ selector: str("CSS selector of the field"), value: str("Text to type") }, ["selector", "value"]),
        },
        ["url"],
      ),
    },
    family: "search",
    labels: { running: "Using a website…", done: "Read a web page", failed: "Couldn't load the page" },
    sideEffect: false,
    async run(input, ctx) {
      const url = s(input.url);
      if (!/^https?:\/\//i.test(url)) return { ok: false, content: "url must start with http:// or https://" };
      const fill = input.fill && typeof input.fill === "object" ? (input.fill as { selector?: unknown; value?: unknown }) : undefined;
      try {
        const r = await ctx.hands.browser.readPage({
          url,
          action: { click: s(input.click) || undefined, fill: fill && s(fill.selector) ? { selector: s(fill.selector), value: s(fill.value) } : undefined },
        });
        if (!r.text.trim()) return { ok: true, content: { url: r.url, title: r.title, text: "", links: r.links }, evidence: r.evidence, stall: `empty page at ${url}`, approach: "browse" };
        return { ok: true, content: { url: r.url, title: r.title, text: r.text, links: r.links.slice(0, 30) }, evidence: r.evidence, approach: "browse" };
      } catch (e) {
        return { ok: false, content: `Could not load ${url}: ${String((e as Error).message).slice(0, 200)}`, stall: `page failed: ${url}`, approach: "browse" };
      }
    },
  },
  {
    spec: {
      name: "ask_room",
      description:
        "Ask the whole group a question and wait for an answer (recommendations, availability, who can do what). The run pauses until someone replies. Use before calling strangers.",
      input_schema: obj({ question: str("The question, in plain words, addressed to the group.") }, ["question"]),
    },
    family: "people",
    labels: { running: "Asking the group…", done: "Asked the group" },
    sideEffect: false,
    async run(input, ctx) {
      const assignee = ctx.requesterId ?? ctx.agent.ownerId;
      const item = ctx.attention.open({
        agentId: ctx.agent.id,
        roomId: ctx.room.id,
        runId: ctx.run.id,
        assigneeId: assignee,
        kind: "information",
        title: "Question for the group",
        detail: s(input.question),
        ttlMs: 2 * 24 * 60 * 60 * 1000,
      });
      return { ok: true, content: "Question posted. The run pauses until someone answers.", waitingOn: item, roomNotice: s(input.question), approach: "ask_room" };
    },
  },
  {
    spec: {
      name: "ask_person",
      description:
        "Ask one member a question privately (their own chat with you) and wait. Use for decisions that belong to one person, or anything private. Names must be room members.",
      input_schema: obj(
        {
          person: str("Member name or id."),
          question: str("The question."),
          kind: { type: "string", enum: ["decision", "information", "action"], description: "What you need from them." },
          options: { type: "array", items: { type: "string" }, description: "Choices, for a decision." },
        },
        ["person", "question"],
      ),
    },
    family: "people",
    labels: { running: "Asking someone…", done: "Asked someone" },
    sideEffect: false,
    async run(input, ctx) {
      const who = ctx.findMember(s(input.person));
      if (!who) return { ok: false, content: `No member named "${s(input.person)}" in this room.` };
      const kind = (["decision", "information", "action"].includes(s(input.kind)) ? s(input.kind) : "information") as AttentionKind;
      const item = ctx.attention.open({
        agentId: ctx.agent.id,
        roomId: ctx.room.id,
        runId: ctx.run.id,
        assigneeId: who.id,
        requesterId: ctx.requesterId,
        kind,
        title: `${ctx.agent.name} has a question`,
        detail: s(input.question),
        options: Array.isArray(input.options) ? (input.options as string[]) : undefined,
        ttlMs: 3 * 24 * 60 * 60 * 1000,
      });
      ctx.dm(who.id, s(input.question));
      return {
        ok: true,
        content: `Asked ${who.name} privately. The run pauses until they answer.`,
        waitingOn: item,
        roomNotice: who.id === ctx.requesterId ? undefined : `I've asked ${who.name} about that.`,
        approach: "ask_person",
      };
    },
  },
  {
    spec: {
      name: "wait_for_user_input",
      description:
        "Stop and wait for the person you are serving to answer something only they know: a decision between options, a missing fact, a code, or an action on their side. The run pauses.",
      input_schema: obj(
        {
          question: str("What you need, in one or two sentences."),
          kind: { type: "string", enum: ["decision", "information", "action"] },
          options: { type: "array", items: { type: "string" } },
        },
        ["question", "kind"],
      ),
    },
    family: "people",
    labels: { running: "Waiting for your reply…", done: "Got your reply" },
    sideEffect: false,
    async run(input, ctx) {
      const assignee = ctx.requesterId ?? ctx.agent.ownerId;
      const item = ctx.attention.open({
        agentId: ctx.agent.id,
        roomId: ctx.room.id,
        runId: ctx.run.id,
        assigneeId: assignee,
        kind: s(input.kind) as AttentionKind,
        title: "Your input is needed",
        detail: s(input.question),
        options: Array.isArray(input.options) ? (input.options as string[]) : undefined,
        ttlMs: 7 * 24 * 60 * 60 * 1000,
      });
      return { ok: true, content: "Waiting.", waitingOn: item, roomNotice: s(input.question), approach: "wait" };
    },
  },
  {
    spec: {
      name: "place_call",
      description:
        "Call a business or person and pursue an objective (ask hours, get a quote, book, confirm). Contacting anyone outside the room needs the owner's OK unless it was disclosed when this was scheduled. Calls outside working hours are held until morning.",
      input_schema: obj(
        {
          to: str("Phone number in E.164."),
          who: str("Who this is (business or person name)."),
          objective: str("What to achieve on the call, including what to ask and what not to agree to."),
          language: str("Language to speak, e.g. 'zh' for Mandarin. Default English."),
        },
        ["to", "who", "objective"],
      ),
    },
    family: "calls",
    labels: { running: "On a call…", done: "Made a call", failed: "Call failed" },
    sideEffect: true,
    async run(input, ctx) {
      const gate = ctx.gate({
        kind: "outreach_approval",
        title: `OK to call ${s(input.who)}?`,
        detail: `${ctx.agent.name} wants to call ${s(input.who)} (${s(input.to)}) by phone to: ${s(input.objective)}`,
        outreach: { who: s(input.who), how: "phone" },
      });
      if (!gate.granted) {
        if ("held" in gate) return { ok: true, content: gate.held, approach: "call" };
        return { ok: true, content: "Waiting for the owner's go-ahead. Nothing has been dialed.", waitingOn: gate.item, roomNotice: gate.notice, approach: "call" };
      }
      ctx.progress(`Calling ${s(input.who)}…`);
      const r = await ctx.hands.phone.call({ to: s(input.to), objective: s(input.objective), callerName: ctx.agent.name, language: s(input.language) || undefined });
      const stalled = r.status !== "completed";
      return {
        ok: true,
        content: { status: r.status, durationSeconds: r.durationSeconds, summary: r.summary, transcript: r.transcript },
        evidence: r.evidence,
        stall: stalled ? `call to ${s(input.who)}: ${r.status}` : undefined,
        approach: "call",
      };
    },
  },
  {
    spec: {
      name: "send_sms",
      description: "Text a phone number outside the room (a vendor, a clinic). Needs the owner's OK unless disclosed. Held outside working hours.",
      input_schema: obj({ to: str("E.164 number."), who: str("Who this is."), text: str("The message.") }, ["to", "who", "text"]),
    },
    family: "calls",
    labels: { running: "Sending a text…", done: "Sent a text" },
    sideEffect: true,
    async run(input, ctx) {
      const gate = ctx.gate({
        kind: "outreach_approval",
        title: `OK to text ${s(input.who)}?`,
        detail: `${ctx.agent.name} wants to text ${s(input.who)} (${s(input.to)}): "${s(input.text)}"`,
        outreach: { who: s(input.who), how: "sms" },
      });
      if (!gate.granted) {
        if ("held" in gate) return { ok: true, content: gate.held };
        return { ok: true, content: "Waiting for the owner's go-ahead. Nothing was sent.", waitingOn: gate.item, roomNotice: gate.notice };
      }
      const r = await ctx.hands.phone.sendSms({ to: s(input.to), text: s(input.text), from: ctx.agent.name });
      return { ok: true, content: { sent: true, messageId: r.messageId }, evidence: r.evidence };
    },
  },
  {
    spec: {
      name: "post_community",
      description:
        "Ask a local or language community for recommendations (Reddit subreddit like 'reddit:r/bayarea', or 'rednote'). Always needs the owner's explicit OK for that community. Say what will be posted. Never include private details about members.",
      input_schema: obj(
        {
          community: str("e.g. reddit:r/sanfrancisco or rednote"),
          title: str("Post title."),
          body: str("Post body. No names, addresses or health details of members."),
          language: str("Language of the post, e.g. zh."),
        },
        ["community", "title", "body"],
      ),
    },
    family: "community",
    labels: { running: "Asking a community…", done: "Posted to a community" },
    sideEffect: true,
    async run(input, ctx) {
      const gate = ctx.gate({
        kind: "community_post_approval",
        title: `OK to post on ${s(input.community)}?`,
        detail: `${ctx.agent.name} wants to post publicly on ${s(input.community)}:\n"${s(input.title)}"\n${s(input.body)}`,
        outreach: { who: s(input.community), how: "community_post" },
      });
      if (!gate.granted) {
        if ("held" in gate) return { ok: true, content: gate.held, approach: "community_post" };
        return { ok: true, content: "Waiting for the owner's OK before posting anything public.", waitingOn: gate.item, roomNotice: gate.notice, approach: "community_post" };
      }
      const r = await ctx.hands.community.post({ community: s(input.community), title: s(input.title), body: s(input.body), language: s(input.language) || undefined });
      return { ok: true, content: { postId: r.postId, url: r.url, note: "Check replies later with read_community_replies, or schedule a check." }, evidence: r.evidence, approach: "community_post" };
    },
  },
  {
    spec: {
      name: "read_community_replies",
      description: "Read replies to a community post you made earlier.",
      input_schema: obj({ postId: str("The post id returned by post_community.") }, ["postId"]),
    },
    family: "community",
    labels: { running: "Reading replies…", done: "Read community replies" },
    sideEffect: false,
    async run(input, ctx) {
      const replies = await ctx.hands.community.replies(s(input.postId));
      if (!replies.length) return { ok: true, content: "No replies yet.", stall: "no community replies yet", approach: "community_post" };
      return { ok: true, content: replies, approach: "community_post" };
    },
  },
  {
    spec: {
      name: "compare_options",
      description: "Lay out candidates side by side (vendors, slots, products) so a person can choose. Produces the table you then show.",
      input_schema: obj(
        {
          title: str("What is being compared."),
          options: {
            type: "array",
            items: obj({ name: str("Name"), price: str("Price or quote"), availability: str("When"), notes: str("Anything that matters") }, ["name"]),
          },
          recommendation: str("Your pick and why, one sentence."),
        },
        ["title", "options"],
      ),
    },
    family: "plan",
    labels: { running: "Comparing options…", done: "Compared options" },
    sideEffect: false,
    async run(input) {
      const opts = Array.isArray(input.options) ? (input.options as Record<string, string>[]) : [];
      const rows = opts.map((o, i) => `${i + 1}. ${o.name}${o.price ? ` — ${o.price}` : ""}${o.availability ? ` — ${o.availability}` : ""}${o.notes ? ` — ${o.notes}` : ""}`);
      const text = `${s(input.title)}\n${rows.join("\n")}${s(input.recommendation) ? `\nSuggestion: ${s(input.recommendation)}` : ""}`;
      return { ok: true, content: text };
    },
  },
  {
    spec: {
      name: "remember",
      description:
        "Note something worth keeping: a rule the owner states, a preference, a person, a store, a decision, a fact, or a lesson (what you taught someone and how far they got). Say who it is about. Notes are dated; newer wins.",
      input_schema: obj(
        {
          type: { type: "string", enum: ["rule", "preference", "person", "schedule", "store", "inventory", "decision", "fact", "lesson"] },
          text: str("One sentence, specific, in the third person."),
          about: str("Member name the note is about, if a person."),
          private: { type: "boolean", description: "True if only this room and the person should ever see it." },
          aliases: { type: "array", items: { type: "string" }, description: "Other words a search should hit." },
        },
        ["type", "text"],
      ),
    },
    family: "memory",
    labels: { running: "Noting that…", done: "Noted" },
    sideEffect: false,
    async run(input, ctx) {
      const about = s(input.about) ? ctx.findMember(s(input.about)) : undefined;
      const type = s(input.type);
      const requesterIsOwner = ctx.requesterId === ctx.agent.ownerId;
      // Rules from the owner take effect now. Everything else is an observation until the nightly pass promotes it.
      const stored = type === "rule" && requesterIsOwner ? "rule" : "observation";
      const scope = about ? "person" : ctx.room.kind === "dm" && ctx.requesterId ? "person" : "room";
      const scopeId = scope === "person" ? (about?.id ?? ctx.requesterId!) : ctx.room.id;
      const m = ctx.memory.write({
        agentId: ctx.agent.id,
        scope: stored === "rule" && !about ? "agent" : scope,
        scopeId: stored === "rule" && !about ? ctx.agent.id : scopeId,
        type: stored,
        text: stored === "observation" ? `[${type}] ${s(input.text)}` : s(input.text),
        aliases: Array.isArray(input.aliases) ? (input.aliases as string[]) : [],
        subjectPersonId: about?.id ?? ctx.requesterId,
        visibleToRooms: input.private ? [ctx.room.id] : [ctx.room.id],
        sourceRunId: ctx.run.id,
      });
      return { ok: true, content: `Noted (${m.id}).` };
    },
  },
  {
    spec: {
      name: "search_memory",
      description: "Look up what you know (people, preferences, past decisions, lessons) by keywords. Only returns what this room may see.",
      input_schema: obj({ query: str("Keywords.") }, ["query"]),
    },
    family: "memory",
    labels: { running: "Checking what I know…", done: "Checked my notes" },
    sideEffect: false,
    async run(input, ctx) {
      const hits = ctx.memory.recall(ctx.agent.id, ctx.room, ctx.rooms.memberIds(ctx.room.id), s(input.query));
      if (!hits.length) return { ok: true, content: "Nothing relevant in my notes." };
      return { ok: true, content: hits.map((m) => `${new Date(m.statedAt).toISOString().slice(0, 10)} [${m.type}] ${m.text}`).join("\n") };
    },
  },
  {
    spec: {
      name: "schedule_action",
      description:
        "Schedule yourself to do something later: a reminder, a follow-up call, a recurring check-in. Write the prompt as instructions to your future self and state the premise that must still hold. Name any third party you will contact so the owner is told now.",
      input_schema: obj(
        {
          title: str("Short title."),
          prompt: str("Instructions to your future self."),
          runAt: str("ISO 8601 instant for a one-off."),
          calendar: obj({
            hour: num("0-23"),
            minute: num("0-59"),
            dayOfWeek: { type: "array", items: { type: "number" } },
            everyDays: num("Every N days"),
          }),
          premise: str("What must still be true for this to make sense, e.g. 'the reservation is still unconfirmed'."),
          disclosedOutreach: {
            type: "array",
            items: obj({ who: str("Name"), how: { type: "string", enum: ["phone", "email", "sms", "community_post"] }, why: str("Purpose") }, ["who", "how", "why"]),
          },
        },
        ["title", "prompt", "premise"],
      ),
    },
    family: "schedule",
    labels: { running: "Scheduling…", done: "Scheduled" },
    sideEffect: true,
    async run(input, ctx) {
      const zone = ctx.store.getPerson(ctx.agent.ownerId)?.timezone ?? "UTC";
      const runAt = s(input.runAt) ? Date.parse(s(input.runAt)) : undefined;
      const cal = input.calendar && typeof input.calendar === "object" ? (input.calendar as Record<string, unknown>) : undefined;
      if (!runAt && !cal) return { ok: false, content: "Give runAt or calendar." };
      if (runAt !== undefined && !Number.isFinite(runAt)) return { ok: false, content: "runAt is not a valid ISO instant." };
      // Only the owner or a decider may put the agent on a schedule without asking.
      const role = ctx.requesterId ? ctx.rooms.role(ctx.room.id, ctx.requesterId) : undefined;
      if (role !== "owner" && role !== "decider") {
        const gate = ctx.gate({ kind: "decision", title: `OK to schedule "${s(input.title)}"?`, detail: `${s(input.prompt)}\nPremise: ${s(input.premise)}` });
        if (!gate.granted) {
          if ("held" in gate) return { ok: true, content: gate.held };
          return { ok: true, content: "Asked the owner before scheduling.", waitingOn: gate.item, roomNotice: gate.notice };
        }
      }
      const { Scheduler } = await import("../scheduler/scheduler.ts");
      const sched = Scheduler.createSchedule(ctx.store, ctx.clock, {
        agentId: ctx.agent.id,
        roomId: ctx.room.id,
        sessionId: ctx.session.id,
        title: s(input.title),
        prompt: s(input.prompt),
        runAt,
        calendar: cal
          ? {
              hour: n(cal.hour),
              minute: n(cal.minute) ?? 0,
              dayOfWeek: Array.isArray(cal.dayOfWeek) ? (cal.dayOfWeek as number[]) : undefined,
              everyDays: n(cal.everyDays),
              timeZone: zone,
            }
          : undefined,
        authorization: {
          basis: "user_requested",
          disclosedOutreach: Array.isArray(input.disclosedOutreach) ? (input.disclosedOutreach as never) : [],
          premise: s(input.premise),
        },
        createdByRunId: ctx.run.id,
      });
      return { ok: true, content: { scheduleId: sched.id, nextRunAt: sched.nextRunAt ? new Date(sched.nextRunAt).toISOString() : null }, evidence: `schedule:${sched.id}` };
    },
  },
  {
    spec: {
      name: "track_commitment",
      description:
        "Record a responsibility someone took on (or you took on) so it is followed up: who, what, for whom, by when. Use for appointments, rides, repairs, bills, anything with a deadline.",
      input_schema: obj(
        {
          title: str("What will be done."),
          owner: str("Member name, or 'me' for yourself."),
          beneficiary: str("Who it is for, if someone else."),
          dueAt: str("ISO 8601 instant, if any."),
          detail: str("Context: address, confirmation numbers, what to bring."),
        },
        ["title", "owner"],
      ),
    },
    family: "care",
    labels: { running: "Writing it down…", done: "Tracking a responsibility" },
    sideEffect: false,
    async run(input, ctx) {
      const ownerName = s(input.owner).toLowerCase();
      const owner = ownerName === "me" || ownerName === ctx.agent.name.toLowerCase() ? { id: ctx.agent.id, name: ctx.agent.name } : ctx.findMember(s(input.owner));
      if (!owner) return { ok: false, content: `No member named "${s(input.owner)}".` };
      const ben = s(input.beneficiary) ? ctx.findMember(s(input.beneficiary)) : undefined;
      const due = s(input.dueAt) ? Date.parse(s(input.dueAt)) : undefined;
      const c = ctx.commitments.track({
        roomId: ctx.room.id,
        agentId: ctx.agent.id,
        ownerId: owner.id,
        beneficiaryId: ben?.id,
        title: s(input.title),
        detail: s(input.detail) || undefined,
        dueAt: due && Number.isFinite(due) ? due : undefined,
        sourceRunId: ctx.run.id,
      });
      return { ok: true, content: { commitmentId: c.id, owner: owner.name, nextNudgeAt: c.nextNudgeAt ? new Date(c.nextNudgeAt).toISOString() : null }, evidence: `commitment:${c.id}` };
    },
  },
  {
    spec: {
      name: "update_commitment",
      description: "Mark a tracked responsibility done, dropped, blocked, or change its due time or owner.",
      input_schema: obj(
        {
          commitmentId: str("The id."),
          status: { type: "string", enum: ["open", "done", "dropped", "blocked"] },
          dueAt: str("New ISO instant."),
          owner: str("New owner member name."),
          detail: str("Updated context."),
        },
        ["commitmentId"],
      ),
    },
    family: "care",
    labels: { running: "Updating…", done: "Updated a responsibility" },
    sideEffect: false,
    async run(input, ctx) {
      const owner = s(input.owner) ? ctx.findMember(s(input.owner)) : undefined;
      const due = s(input.dueAt) ? Date.parse(s(input.dueAt)) : undefined;
      try {
        const c = ctx.commitments.update(s(input.commitmentId), {
          status: s(input.status) ? (s(input.status) as never) : undefined,
          dueAt: due && Number.isFinite(due) ? due : undefined,
          ownerId: owner?.id,
          detail: s(input.detail) || undefined,
        });
        return { ok: true, content: { commitmentId: c.id, status: c.status } };
      } catch (e) {
        return { ok: false, content: String((e as Error).message) };
      }
    },
  },
  {
    spec: {
      name: "request_purchase",
      description:
        "Before paying for anything, declare the amount and what for. Returns whether you may proceed, or waits for approval. Purchases under the owner's threshold pass automatically; a paused budget blocks.",
      input_schema: obj({ amountUsd: num("Total in USD."), what: str("What is bought."), where: str("Merchant.") }, ["amountUsd", "what", "where"]),
    },
    family: "money",
    labels: { running: "Checking the budget…", done: "Checked the budget" },
    sideEffect: true,
    async run(input, ctx) {
      const amount = n(input.amountUsd) ?? 0;
      if (ctx.agent.trust.spendingPaused) return { ok: true, content: "Spending is paused by the owner. Do not buy; tell them." };
      const gate = ctx.gate({
        kind: "purchase_approval",
        title: `OK to spend $${amount.toFixed(2)}?`,
        detail: `${ctx.agent.name} wants to pay $${amount.toFixed(2)} at ${s(input.where)} for: ${s(input.what)}`,
        money: amount,
      });
      if (!gate.granted) {
        if ("held" in gate) return { ok: true, content: gate.held };
        return { ok: true, content: "Waiting for approval before paying.", waitingOn: gate.item, roomNotice: gate.notice };
      }
      return { ok: true, content: `Approved: ${gate.reason}. You may proceed with the purchase.`, evidence: `purchase-approved:${amount}` };
    },
  },
];

export const TOOL_INDEX = new Map(TOOLS.map((t) => [t.spec.name, t]));

export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => t.spec);
}
