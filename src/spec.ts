// Agent interpretation layer: a one-line request becomes an explicit Agent Spec the user confirms before anything is deployed —
// what it understood, the jobs, routines it will run on its own, the gaps it needs filled, its boundaries, how we'll know it works,
// and rehearsal scenarios that are run in the sandbox before it reaches a real chat.
import { one, all, J, now } from "./db";
import { structured, hasAnyModel } from "./model";
import * as tpl from "./templates";
import * as rt from "./runtime";
import { assessDepth, depthInstructions, type Depth } from "./depth";

export type Audience = "me" | "group" | "team";
export interface Routine { every: "daily" | "weekdays" | "weekly"; day?: number; hour: number; objective: string }
export interface Question { id: string; q: string; why: string; default?: string }
export interface Scenario { say: string; expect: string }
export interface AgentSpec {
  name: string; title: string; avatar: string; audience: Audience; understanding: string; jobs: string[]; routines: Routine[];
  questions: Question[]; boundaries: string[]; success: string[]; skills: string[]; connections: string[]; rehearsal: Scenario[]; tone: string;
  data_needs?: DataNeed[];
  depth?: Depth;           // how hard it works: decided from its jobs before deploying (src/depth.ts)
  notes?: string;          // free-form standing instructions (e.g. a catalog agent's own), kept verbatim
  answers?: Record<string, string>;
}
/** Where each fact the agent depends on comes from. Anything without a real source is said out loud, never guessed. */
export type DataHow = "built-in" | "connect" | "website" | "web" | "ask" | "none";
export interface DataNeed { need: string; how: DataHow; detail: string }
// What the platform can actually source, and the skill that brings it.
const DATA_CATALOG: { re: RegExp; how: DataHow; detail: string; skill?: string }[] = [
  { re: /stock|share|ticker|portfolio|crypto|bitcoin|etf|index|market|currenc|exchange rate|fx/i, how: "built-in", detail: "Live market quotes and price history (Yahoo Finance; Finnhub if connected)", skill: "market-data" },
  { re: /weather|forecast|rain|temperature/i, how: "built-in", detail: "Weather forecasts (Open-Meteo)", skill: "weather" },
  { re: /scores?|game|match|fixture|schedule of|nfl|nba|mlb|nhl|soccer|football|basketball|baseball|hockey|f1/i, how: "built-in", detail: "Live scores, results and schedules (ESPN feed, unofficial)", skill: "sports" },
  { re: /restaurant|table|reservation/i, how: "built-in", detail: "Restaurant search and booking (OpenTable/Resy through your login)", skill: "reservations" },
  { re: /email|inbox|calendar|meeting|contact/i, how: "connect", detail: "Connect Google (Gmail + Calendar)" },
  { re: /news|headline|article|review|price of|product|hotel|flight|event|ticket/i, how: "web", detail: "Web search + reading the source pages (cited, may be unverified)", skill: "web-research" },
];
const DATA_HOWS: DataHow[] = ["built-in", "connect", "website", "web", "ask", "none"];
export function resolveDataNeeds(needs: any[], skills: string[]): { needs: DataNeed[]; skills: string[] } {
  const out: DataNeed[] = [], add = new Set(skills);
  for (const n of (Array.isArray(needs) ? needs : []).slice(0, 6)) {
    const need = String(n?.need ?? "").trim(); if (!need) continue;
    const hit = DATA_CATALOG.find((c) => c.re.test(need));
    // Only the catalog can say "built in" (the model can't invent tools). It upgrades guesses like "web"/"none" to a real built-in
    // source, but "ask" (only the people know: their holdings) and "connect" (their accounts) stay as the model said.
    const said: DataHow = DATA_HOWS.includes(n?.how) ? n.how : "none";
    const how: DataHow = said === "ask" || said === "connect" ? said : hit?.how === "built-in" ? "built-in" : said === "built-in" ? (hit?.how ?? "web") : said;
    if (how === "built-in" && hit?.skill) add.add(hit.skill);
    if (how === "web") add.add("web-research");
    if (how === "website") add.add("browser");
    out.push({ need, how, detail: String((how === hit?.how ? hit?.detail : n?.detail) ?? hit?.detail ?? "").slice(0, 160) });
  }
  return { needs: out, skills: [...add].filter((x) => tpl.SKILLS[x]) };
}

const JOB: Record<string, string> = {
  "web-research": "Looks things up and answers with sources", "source-verification": "Checks facts against the original source", "monitor-topic": "Watches the topics you care about and reports only real changes",
  "email-triage": "Sorts your inbox into needs-reply, FYI and ignore", "email-drafting": "Drafts emails in your voice for you to approve", calendar: "Finds times and manages your calendar",
  "meeting-prep": "Preps you before each meeting", "follow-up-tracking": "Chases people who owe a reply", reminders: "Reminds you (or the group) at the right moment", documents: "Finds and reads your documents",
  reservations: "Finds tables and books them within limits you approve, watching sold-out spots", "group-buying": "Runs group orders: tally, deadline, who paid", browser: "Uses websites for you when there's no other way",
  "task-tracking": "Keeps track of who's doing what", delegation: "Hands work to your other agents", "travel-planning": "Plans trips around everyone's preferences", "group-coordination": "Keeps the group on track and sums up status",
  "candidate-matching": "Matches candidates to roles", "credential-followup": "Chases missing documents", polls: "Runs polls and RSVPs in the chat", "expense-splitting": "Splits costs and says who owes who, to the cent",
  "shared-lists": "Keeps shared lists like groceries and packing",
};
// Gaps worth asking about before deploy, per ability. `skip` = the description already answers it.
const ASK: Record<string, (Question & { skip?: RegExp })[]> = {
  reservations: [{ id: "city", q: "Which city or neighborhoods?", why: "so it searches the right places", skip: /\b(in|near|around) [A-Z]/ },
    { id: "party", q: "Usual party size?", why: "so it doesn't ask every time", default: "2", skip: /\bfor \d+\b|\bparty of\b/i },
    { id: "budget", q: "Budget per person, and any deposit limit?", why: "it never books outside limits you set", default: "up to $100, no deposits without asking", skip: /\$\d+/ }],
  "expense-splitting": [{ id: "pay", q: "How does the group pay each other (Venmo/Cash App handles)?", why: "so it can add pay links", skip: /venmo|cash ?app|paypal|zelle/i },
    { id: "currency", q: "Currency?", why: "for amounts and rounding", default: "USD" }],
  "group-buying": [{ id: "pay", q: "Where should people pay the organizer (e.g. venmo @name)?", why: "for pay links when an order closes", skip: /venmo|cash ?app|paypal/i }],
  "monitor-topic": [{ id: "topics", q: "Which topics, sites or products should it watch?", why: "it only reports real changes on these" }],
  "travel-planning": [{ id: "home", q: "Home airport or city?", why: "for flights and timing" }],
  calendar: [{ id: "hours", q: "Your working hours?", why: "so it only proposes sensible times", default: "9am–6pm, weekdays" }],
  "email-drafting": [{ id: "voice", q: "How should your emails sound?", why: "it drafts in your voice", default: "friendly, short, no fluff" }],
  documents: [{ id: "sources", q: "Which docs should it answer from?", why: "answers stay grounded in your sources" }],
};
/** Restate the user's words back to them: "grab me a table for my friends" → "grab you a table for your friends". */
export const toYou = (t: string) => t.replace(/\b(me|myself)\b/gi, "you").replace(/\bmy\b/gi, "your").replace(/\bmine\b/gi, "yours").replace(/\bI am\b/g, "you are").replace(/\bI'm\b/g, "you're").replace(/\bI\b/g, "you").replace(/\bwe\b/gi, "you").replace(/\bour\b/gi, "your").replace(/\bus\b/gi, "you");
const WD = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Routines stated in plain words: "every morning", "weekdays at 8", "every Friday at 10am". */
export function routinesFrom(text: string, objective: string): Routine[] {
  const t = text.toLowerCase(), at = t.match(/\bat (\d{1,2})(?::\d\d)?\s*(am|pm)?\b/);
  const hour = at ? (Number(at[1]) % 12) + (at[2] === "pm" ? 12 : 0) : /evening|night/.test(t) ? 19 : /afternoon/.test(t) ? 14 : 8;
  const day = WD.findIndex((d) => new RegExp(`\\b(every|each|on) ${d}s?\\b|\\b${d}s\\b`).test(t));
  if (day >= 0) return [{ every: "weekly", day, hour, objective }];
  if (/\b(weekly|every week|each week)\b/.test(t)) return [{ every: "weekly", day: 1, hour, objective }];
  if (/\b(weekdays?|every workday|monday to friday)\b/.test(t)) return [{ every: "weekdays", hour, objective }];
  if (/\b(every (morning|day|evening|night)|daily|each (morning|day))\b/.test(t)) return [{ every: "daily", hour, objective }];
  return [];
}

function heuristic(description: string, audience: Audience, draft: any): AgentSpec {
  const skills: string[] = draft.skills;
  const who = { me: "for you, 1:1", group: "in your group chat, for everyone in it", team: "for your team, in your shared channels" }[audience];
  const questions = skills.flatMap((s) => ASK[s] ?? []).filter((q) => !q.skip?.test(description)).map(({ skip, ...q }) => q)
    .filter((q, i, a) => a.findIndex((x) => x.id === q.id) === i).slice(0, 4);
  const perms = tpl.permissionTable(skills);
  const asks = perms.filter((p) => p.mode !== "auto" && p.mode !== "never").map((p) => `Asks you before it ${p.description.split(".")[0].replace(/^./, (c) => c.toLowerCase())}`);
  const starters = [...new Set(skills.map((s) => SAMPLE[s]).filter(Boolean))].slice(0, 3);
  return {
    name: draft.name, title: draft.title, audience,
    avatar: one<any>("select v.manifest from templates t join template_versions v on v.template_id=t.id and v.version=t.published_version where t.name=?", draft.name)?.manifest?.match(/"avatar":\s*"([^"]+)"/)?.[1] ?? "✨",
    understanding: `You want ${draft.name} to ${toYou(draft.job.replace(/^./, (c: string) => c.toLowerCase()).replace(/\.$/, ""))}, ${who}.`,
    jobs: skills.map((s) => JOB[s]).filter(Boolean).slice(0, 6),
    routines: routinesFrom(description, description),
    questions,
    boundaries: [...asks.slice(0, 3), ...(skills.some((s) => ["reservations", "group-buying", "expense-splitting"].includes(s)) ? ["Never moves money: it shares pay links and tracks who paid"] : []),
      audience === "group" ? "Only speaks in the group when someone asks it by name or votes/joins" : "Only acts for people in chats it's added to"],
    success: audience === "group" ? ["Everyone can use it by name without setup", "No one has to keep a separate spreadsheet or tally"]
      : audience === "team" ? ["Work gets tracked with an owner and nothing is dropped", "The team asks it instead of pinging each other"]
      : ["It handles the request end to end, and only asks when it really needs you", "You get a clear result, not a to-do list"],
    skills, connections: draft.connections ?? tpl.connectionsNeeded(skills),
    rehearsal: (starters.length ? starters : [description.slice(0, 140)]).map((say) => ({ say, expect: "Does the right thing with its tools, or asks one clear question" })),
    tone: audience === "group" ? "short, friendly, emoji-light; one message per reply" : "warm and concise",
  };
}
// Concrete first messages used to rehearse each ability in the sandbox.
const SAMPLE: Record<string, string> = {
  reservations: "Find a table for 2 this Friday around 8pm", "expense-splitting": "I paid $90 for gas, split with everyone", polls: "Poll: dinner Friday or Saturday?",
  "shared-lists": "Add milk, eggs and bread to the grocery list", "group-buying": "Let's do a group order of coffee 5lb bags $45 each, closes friday 6pm, venmo @maria",
  reminders: "Remind me tomorrow to call the landlord", "web-research": "What are the best-reviewed ramen spots near Union Square?", "monitor-topic": "Every morning, check AI news and tell me what changed",
  calendar: "When am I free for a 30 min call this week?", "email-triage": "What needs a reply in my inbox?", "travel-planning": "Find three hotel options in Lisbon for next weekend",
  "task-tracking": "Track: Sam books the van, Leo brings the cooler", "meeting-prep": "Prep me for my next meeting",
};

/** Interpret a plain-words request into an Agent Spec (model when available, deterministic fallback otherwise). */
export async function interpret(description: string, audience: Audience, workspaceId?: string): Promise<AgentSpec> {
  const draft = await tpl.draftAgent(description, workspaceId);
  const base = heuristic(description, audience, draft);
  const s = await structured<AgentSpec>("fast", // reasoning off: ~8s instead of ~16s on standard, same JSON quality
    `You turn a person's one-line request into a precise spec for a chat agent that will live ${audience === "group" ? "in a group chat" : audience === "team" ? "in a team's channels" : "in their 1:1 texts"}.
Return JSON with: name (friendly first name), title, avatar (one emoji), understanding (1-2 sentences restating what they want in plain words, including anything implied),
jobs (3-6 concrete things it will do), routines (things it should do on its own: [{every: "daily"|"weekdays"|"weekly", day?: 0-6 Sunday=0, hour: 0-23, objective}], only if implied),
questions (max 4 gaps that genuinely change behaviour, each {id, q, why, default?}; don't ask what the request already says), boundaries (what it must never do or must ask first),
success (2-3 observable signs it's working), skills (subset of [${Object.keys(tpl.SKILLS).join(", ")}]),
data_needs (the facts its jobs depend on, each {need, how, detail}: how = "built-in" (live market quotes, weather, sports scores/schedules, restaurant booking, web search are built in) | "connect" (needs an account connected: Gmail/Calendar, Slack, or an API via MCP) | "website" (read or operate a specific site in a browser) | "web" (general web search, cited, may be unverified) | "ask" (only the people know it, e.g. what's in their portfolio — ask once, then remember) | "none" (no reliable source: say so)),
rehearsal (2-3 realistic first messages a PERSON would send it {say, expect}; "say" must not contain invented prices, news or facts), tone.`,
    description, () => base, workspaceId);
  // Trust nothing structural from the model: keep only known skills, sane routines, bounded lists.
  const data = resolveDataNeeds((s as any).data_needs ?? [], (s.skills ?? []).filter((x) => tpl.SKILLS[x]));
  const skills = data.skills;
  const jobs = ((s.jobs ?? base.jobs) as string[]).slice(0, 6);
  return {
    ...base, ...s, data_needs: data.needs, depth: assessDepth(jobs, s.routines ?? []),
    audience, skills: skills.length ? skills : base.skills, connections: tpl.connectionsNeeded(skills.length ? skills : base.skills),
    routines: (s.routines ?? []).filter((r) => ["daily", "weekdays", "weekly"].includes(r.every) && r.hour >= 0 && r.hour < 24 && r.objective && (r.every !== "weekly" || (r.day! >= 0 && r.day! < 7))).slice(0, 3),
    questions: (s.questions ?? []).filter((q) => q?.id && q?.q).slice(0, 4), jobs: (s.jobs ?? base.jobs).slice(0, 6), rehearsal: (s.rehearsal ?? base.rehearsal).filter((r) => r?.say).slice(0, 3),
  };
}

/** The confirmed spec + answers become the agent's standing instructions. */
export function compile(spec: AgentSpec, answers: Record<string, string> = {}) {
  const facts = spec.questions.map((q) => [q.q, (answers[q.id] ?? "").trim() || q.default]).filter(([, a]) => a);
  return [`You are ${spec.name}, ${spec.title}. ${spec.understanding}`,
    `What you do:\n${spec.jobs.map((j) => `- ${j}`).join("\n")}`,
    facts.length && `What you know about the people you serve:\n${facts.map(([q, a]) => `- ${q} ${a}`).join("\n")}`,
    `Boundaries:\n${spec.boundaries.map((b) => `- ${b}`).join("\n")}`,
    spec.notes?.trim() && `Also:\n${spec.notes.trim()}`,
    spec.depth && depthInstructions(spec.depth),
    spec.data_needs?.length && `Where your information comes from (never guess what isn't covered):\n${spec.data_needs.map((d) => `- ${d.need}: ${{ "built-in": "use your built-in tool", connect: "needs a connected account — if it isn't connected, say so", website: "read it from the site with the browser", web: "search the web and cite sources; flag what's unverified", ask: "ask the people once, then remember it", none: "no reliable source yet — say you can't check it and call data.missing" }[d.how]}${d.detail ? ` (${d.detail})` : ""}`).join("\n")}`,
    `You're doing well when:\n${spec.success.map((b) => `- ${b}`).join("\n")}`,
    `Tone: ${spec.tone}.`].filter(Boolean).join("\n\n");
}

/** Run each rehearsal message in the agent's sandbox room and grade what happened. Nothing leaves the platform. */
export async function rehearse(agent: any, userId: string, room: any) {
  const spec: AgentSpec | null = J(agent.spec, null);
  const answers: Record<string, string> = (spec as any)?.answers ?? {};
  const party = answers.party?.match(/\d+/)?.[0]; // rehearse with what the user told us, not the sample's defaults
  // Without a spec, rehearse with concrete samples for its abilities, never starters with blanks ("…") filled by placeholder words.
  const samples = [...new Set((J(agent.skills, []) as string[]).map((s) => SAMPLE[s]).filter(Boolean)), ...tpl.starters(agent).filter((s) => !s.includes("…"))];
  const scenarios = (spec?.rehearsal?.length ? spec.rehearsal : samples.slice(0, 2).map((say) => ({ say, expect: "Does the right thing with its tools, or asks one clear question" })))
    .map((sc) => party ? { ...sc, say: sc.say.replace(/\bfor 2\b/, `for ${party}`) } : sc);
  const out = [];
  for (const sc of scenarios) {
    const since = now();
    const { started } = await rt.ingestMessage({ roomId: room.id, senderId: userId, text: sc.say, platform: "web" });
    await rt.drain();
    // A plan that waits for "go" is fine behaviour; confirm it so the rehearsal shows the whole task.
    for (const rid of started) if (one<any>("select brief_status from runs where id=?", rid)?.brief_status === "proposed") { (await import("./intake")).confirmBrief(rid, userId, null); await rt.drain(); }
    const replies = all<any>("select data from events where room_id=? and actor=? and type='message' and ts>=? order by seq", room.id, agent.id, since).map((e) => J(e.data).text).filter(Boolean);
    const tools = [...new Set(all<any>("select data from events where room_id=? and type='TOOL_CALL_REQUESTED' and ts>=?", room.id, since).map((e) => J(e.data).tool))];
    const failed = started.some((rid) => one<any>("select status from runs where id=?", rid)?.status === "failed_terminal");
    const approval = !!one("select 1 from approvals where room_id=? and status='pending' and created_at>=?", room.id, since);
    const reply = replies.join("\n").slice(0, 600);
    // Evidence, not vibes: a tool that actually succeeded, or an approval correctly requested. "Attempted" doesn't count.
    const done = [...new Set(all<any>("select data from events where room_id=? and type='TOOL_CALL_COMPLETED' and ts>=?", room.id, since).map((e) => J(e.data, {}))
      .filter((d) => /^SUCCEEDED|PARTIAL$/.test(String(d.status ?? ""))).map((d) => d.tool))];
    const leaked = /DSML|<tool_call|<function[=\s]/i.test(reply);
    let verdict: "pass" | "fail" | "unchecked", note: string;
    if (failed || !replies.length || leaked) { verdict = "fail"; note = failed ? "the task failed" : !replies.length ? "no reply" : "sent raw tool markup instead of an answer"; }
    else {
      const evidence = approval ? "asked for your approval first, as it should" : done.length ? `did it: ${done.join(", ")}` : "";
      // The grader: a real model judging against the expectation. Unavailable → null, which is never a pass by itself.
      const j = hasAnyModel(agent.workspace_id)
        ? await structured<{ pass: boolean | null; why: string }>("fast", `Grade an AI agent's reply in a rehearsal. Expected: ${sc.expect}. Fail it if it claims to have done something the tool list doesn't show, invents facts, or ignores the request. Return {"pass": boolean, "why": one short sentence}.`,
            `User: ${sc.say}\nTools that succeeded: ${done.join(", ") || "none"}\nApproval requested: ${approval}\nAgent: ${reply}`, () => ({ pass: null, why: "" }), agent.workspace_id)
        : { pass: null, why: "" };
      if (j.pass === false) { verdict = "fail"; note = j.why || "didn't do what was expected"; }
      else if (j.pass === true) { verdict = "pass"; note = j.why || evidence; }
      else if (evidence) { verdict = "pass"; note = `${evidence} (reply not reviewed — no grading model)`; }
      else { verdict = "unchecked"; note = "replied, but nothing proves it did the job and no grading model is available"; }
    }
    out.push({ say: sc.say, expect: sc.expect, reply, tools, verdict, note });
  }
  return out;
}


// ---------------- editing an agent after it exists ----------------
/** The agent's editable spec: its saved one, or (catalog/older agents) one rebuilt from its fields, keeping its instructions verbatim. */
export function fromAgent(agent: any): AgentSpec {
  const saved: AgentSpec | null = J(agent.spec, null);
  const skills: string[] = J(agent.skills, []);
  const routines = all<any>("select spec, objective from schedules where agent_id=? and status='active' and kind='recurring'", agent.id).map((r) => {
    const sp = J(r.spec, {}); return { every: sp.days?.length ? "weekly" : sp.every ?? "daily", ...(sp.days?.length ? { day: sp.days[0] } : sp.day != null ? { day: sp.day } : {}), hour: sp.hour ?? 9, objective: r.objective } as Routine; });
  if (saved) return { ...saved, name: agent.name, avatar: agent.avatar ?? saved.avatar, skills, routines };
  return { name: agent.name, title: agent.title ?? "", avatar: agent.avatar ?? "🤖", audience: "me", understanding: agent.job, jobs: skills.map((k) => JOB[k]).filter(Boolean),
    routines, questions: [], boundaries: [], success: [], skills, connections: tpl.connectionsNeeded(skills), rehearsal: [], tone: "", notes: agent.instructions ?? "", answers: {} };
}

/** Apply a plain-language change ("be shorter", "never text after 10pm") to a spec. Returns the new spec + what changed; saves nothing. */
export async function revise(current: AgentSpec, change: string, workspaceId?: string): Promise<{ spec: AgentSpec; summary: string[] }> {
  const fallback = () => {
    // Offline: a rule-like change becomes a boundary, anything else a standing note — never lost, always visible.
    const rule = /\b(never|don'?t|do not|always|only|stop|no more|must)\b/i.test(change);
    return { spec: rule ? { ...current, boundaries: [...current.boundaries, change.trim()] } : { ...current, notes: `${current.notes ?? ""}\n${change.trim()}`.trim() }, summary: [rule ? `New rule: ${change.trim()}` : `New instruction: ${change.trim()}`] };
  };
  const r = await structured<any>("fast", `You edit an AI chat agent's spec. Apply the person's requested change to the JSON spec and return {"spec": <the full updated spec, same shape>, "summary": [short plain-language bullets of exactly what changed]}.
Change only what they asked. Keys: name, title, avatar (emoji), understanding, jobs [], routines [{every: daily|weekdays|weekly, day?: 0-6, hour: 0-23, objective}], boundaries [], success [], skills (subset of [${Object.keys(tpl.SKILLS).join(", ")}]), tone, notes, data_needs [{need, how, detail}].`,
    `Current spec:\n${JSON.stringify({ ...current, rehearsal: undefined, questions: undefined, answers: undefined, connections: undefined })}\n\nRequested change: ${change}`, () => null, workspaceId);
  if (!r?.spec || typeof r.spec !== "object") return fallback();
  return { spec: sanitize({ ...current, ...r.spec, answers: current.answers, questions: current.questions, rehearsal: current.rehearsal }), summary: (Array.isArray(r.summary) ? r.summary : []).map(String).slice(0, 8) };
}

/** Trust nothing structural from an edit: known skills only, sane routines, bounded lists, data needs re-resolved. */
export function sanitize(sp: AgentSpec): AgentSpec {
  const list = (x: any, n: number) => (Array.isArray(x) ? x : []).map((v) => String(v).trim()).filter(Boolean).slice(0, n);
  const data = resolveDataNeeds(sp.data_needs ?? [], (sp.skills ?? []).filter((x) => tpl.SKILLS[x]));
  const skills = data.skills.length ? data.skills : ["web-research"];
  return { ...sp, name: String(sp.name || "Agent").slice(0, 40), title: String(sp.title ?? "").slice(0, 80), avatar: [...String(sp.avatar || "🤖")].slice(0, 2).join(""),
    understanding: String(sp.understanding ?? "").slice(0, 600), jobs: list(sp.jobs, 8), boundaries: list(sp.boundaries, 12), success: list(sp.success, 5), tone: String(sp.tone ?? "").slice(0, 200),
    notes: String(sp.notes ?? "").slice(0, 4000), skills, connections: tpl.connectionsNeeded(skills), data_needs: data.needs,
    depth: assessDepth(list(sp.jobs, 8), sp.routines ?? [], sp.depth?.overridden && ["light", "standard", "deep"].includes(sp.depth.level) ? sp.depth.level : undefined),
    routines: (sp.routines ?? []).filter((r: any) => ["daily", "weekdays", "weekly"].includes(r?.every) && r.hour >= 0 && r.hour < 24 && r.objective && (r.every !== "weekly" || (r.day >= 0 && r.day < 7))).slice(0, 5)
      .map((r: any) => ({ every: r.every, hour: Math.round(r.hour), ...(r.every === "weekly" ? { day: r.day } : {}), objective: String(r.objective).slice(0, 300) })) };
}
