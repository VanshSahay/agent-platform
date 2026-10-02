// Skills, Agent Templates (versioned manifests), install / fork / publish / review (plan §2.3, §2.7, §18).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { all, one, exec, id, now, S, J, tx, emit } from "./db";
import { TOOLS } from "./tools";
import { defaultMode } from "./policy";
import { structured } from "./model";

export interface Skill { id: string; name: string; tools: string[]; procedure: string }
export const SKILLS: Record<string, Skill> = Object.fromEntries(([
  ["web-research", "Web research", ["web.search", "web.fetch"], "Search, open the best sources, and answer with cited URLs. Prefer primary sources. Say what you could not verify."],
  ["source-verification", "Source verification", ["web.fetch"], "Before stating a fact as current, open the source and check its date."],
  ["monitor-topic", "Topic monitoring", ["web.search", "web.fetch", "reminder.schedule", "memory.remember"], "For standing topics, schedule a recurring check, compare against what you remember, and only report meaningful changes. Save the new state to room memory."],
  ["email-triage", "Email triage", ["email.search"], "Group unread mail into: needs reply, FYI, can ignore. Flag anything time-sensitive first."],
  ["email-drafting", "Email drafting & sending", ["email.draft", "email.send"], "Draft in the user's voice. Show the draft; sending is gated by approval."],
  ["calendar", "Calendar management", ["calendar.list_events", "calendar.create_event", "calendar.cancel_event"], "Check conflicts before proposing times. Creating or cancelling events is gated by approval."],
  ["meeting-prep", "Meeting preparation", ["calendar.list_events", "email.search", "web.search"], "For each upcoming meeting: who, why, last thread with them, and 3 talking points."],
  ["follow-up-tracking", "Follow-up tracking", ["task.create", "task.update", "wait.for_reply", "reminder.schedule"], "When someone owes a reply, create a task and wait for it with a timeout; nudge the owner when it lapses."],
  ["reminders", "Reminders & schedules", ["reminder.schedule"], "Turn time-based asks into scheduled wake-ups. Confirm the exact time back."],
  ["browser", "Browser tasks", ["browser.task"], "Use the browser only when there is no API and search/fetch can't do it."],
  ["task-tracking", "Task tracking", ["task.create", "task.update"], "Every commitment becomes a task with an owner. Respect tasks marked blocked: a human owns those."],
  ["delegation", "Delegation", ["agent.delegate"], "Delegate only when another agent has different permissions, knowledge or ownership. Pass only the context it needs."],
  ["travel-planning", "Travel planning", ["web.search", "web.fetch", "browser.task", "memory.remember"], "Reconcile each traveler's stated preferences. Give 3 options with price, location and trade-offs. Never book or pay without explicit approval."],
  ["group-coordination", "Group coordination", ["task.create", "task.update", "memory.remember", "reminder.schedule"], "Track who owns what. Summarize status on request. Escalate blockers to their owner."],
  ["candidate-matching", "Candidate matching", ["web.search", "task.create", "memory.remember"], "Match on hard constraints first (license, specialty, start date, location), then preferences. Humans own rejection and rate decisions."],
  ["credential-followup", "Credential follow-up", ["task.create", "task.update", "email.draft", "email.send", "wait.for_reply"], "For each missing document, one task, one owner. Outreach is gated by approval and never to candidates a human has claimed."],
] as const).map(([sid, name, tools, procedure]) => [sid, { id: sid, name, tools: [...tools], procedure }]));

export const CORE_TOOLS = ["memory.remember", "task.create", "task.update"];

export function agentTools(agent: { skills: string | string[] }): Set<string> {
  const skills: string[] = typeof agent.skills === "string" ? J(agent.skills, []) : agent.skills;
  return new Set([...CORE_TOOLS, ...skills.flatMap((s) => SKILLS[s]?.tools ?? [])]);
}

export function connectionsNeeded(skills: string[]) {
  return [...new Set(skills.flatMap((s) => SKILLS[s]?.tools ?? []).map((t) => TOOLS[t]?.requiresConnection).filter(Boolean))] as string[];
}

export function permissionTable(skills: string[], overrides: Record<string, string> = {}) {
  return [...agentTools({ skills })].filter((t) => TOOLS[t]).map((t) => ({
    tool: t, risk: TOOLS[t].risk, mode: overrides[t] ?? defaultMode(TOOLS[t].defaultApproval, TOOLS[t].risk), description: TOOLS[t].description,
  }));
}

// ---------- natural-language agent creation (plan §3.4) ----------
const ROLE_RULES: [RegExp, string, string, string[]][] = [
  [/\b(recruit|candidate|staffing|nurse|credential)/i, "Recruiter", "Healthcare Recruiter", ["candidate-matching", "credential-followup", "task-tracking", "web-research"]],
  [/\b(travel|trip|hotel|flight|vacation|concierge|restaurant)/i, "Scout", "Travel Planner", ["travel-planning", "web-research", "reminders"]],
  [/\b(research|analy[sz]|monitor|brief|news|competitor)/i, "Atlas", "Research Analyst", ["web-research", "source-verification", "monitor-topic"]],
  [/\b(team|ops|operations|coordinat|standup|status|project)/i, "Relay", "Team Operations Coordinator", ["group-coordination", "task-tracking", "follow-up-tracking", "reminders"]],
  [/\b(email|inbox|calendar|meeting|assistant|schedul|remind)/i, "Ava", "Executive Assistant", []],
];
const KEYWORD_SKILLS: [RegExp, string[]][] = [
  [/\b(email|inbox|mail)/i, ["email-triage", "email-drafting"]],
  [/\b(calendar|schedul|meeting)/i, ["calendar", "meeting-prep"]],
  [/\b(remind|follow.?up|haven'?t replied|nudge)/i, ["follow-up-tracking", "reminders"]],
  [/\b(research|search|look up|web)/i, ["web-research"]],
  [/\b(browser|website|form|book)/i, ["browser"]],
  [/\b(monitor|keep .* (updated|current))/i, ["monitor-topic"]],
];

export async function draftAgent(description: string, workspaceId?: string) {
  const fallback = () => {
    const role = ROLE_RULES.find(([re]) => re.test(description)) ?? [null, "Sage", "Assistant", []];
    const skills = new Set<string>(role[3]);
    for (const [re, s] of KEYWORD_SKILLS) if (re.test(description)) s.forEach((x) => skills.add(x));
    if (!skills.size) skills.add("web-research");
    const job = description.replace(/^i (want|need) (an?|someone|something) /i, "").replace(/^(agent )?(that|who|to) /i, "").trim();
    return { name: role[1], title: role[2], job: job.charAt(0).toUpperCase() + job.slice(1), skills: [...skills] };
  };
  const d = await structured<{ name: string; title: string; job: string; skills: string[] }>("fast",
    `You design AI agents. Given a description, return {"name": short friendly name, "title": role title, "job": one-sentence job, "skills": subset of [${Object.keys(SKILLS).join(", ")}]}.`,
    description, fallback, workspaceId);
  d.skills = d.skills.filter((s) => SKILLS[s]);
  return {
    ...d,
    skillDetails: d.skills.map((s) => ({ id: s, name: SKILLS[s].name })),
    connections: connectionsNeeded(d.skills),
    permissions: permissionTable(d.skills),
    channels: ["web", "imessage", "telegram", "slack", "whatsapp", "email", "phone"],
  };
}

// ---------- manifests ----------
export interface Manifest {
  name: string; slug: string; version: string; publisher: string; tagline: string; avatar?: string; title: string;
  job: string; scope?: string; instructions?: string; skills: string[]; permissions?: Record<string, string>;
  model_profile?: string; channels?: string[]; onboarding?: { id: string; question: string }[];
  proactivity?: string[]; escalation?: string[]; memory_rules?: string[]; network?: string[]; evals?: string[]; pricing?: string; data_retention?: string;
}

export function validateManifest(m: Manifest): string[] {
  const errs: string[] = [];
  for (const k of ["name", "slug", "version", "job"] as const) if (!m[k]) errs.push(`${k} is required`);
  if (!/^\d+\.\d+\.\d+$/.test(m.version ?? "")) errs.push("version must be semver");
  if (!/^[a-z0-9-]+$/.test(m.slug ?? "")) errs.push("slug must be lowercase-kebab");
  for (const s of m.skills ?? []) if (!SKILLS[s]) errs.push(`unknown skill ${s}`);
  const tools = agentTools({ skills: m.skills ?? [] });
  for (const [t, mode] of Object.entries(m.permissions ?? {})) {
    if (!tools.has(t)) errs.push(`permission for ${t} but no skill provides it`);
    if (!["auto", "first_time", "ask", "always_ask", "never"].includes(mode)) errs.push(`bad permission mode ${mode}`);
  }
  return errs;
}

/** Risky choices that require human review before a public listing (plan §18.4). */
export function reviewFlags(m: Manifest): string[] {
  const flags: string[] = [];
  for (const [t, mode] of Object.entries(m.permissions ?? {}))
    if (mode === "auto" && TOOLS[t] && ["write_external", "destructive", "financial"].includes(TOOLS[t].risk)) flags.push(`${t} set to auto (${TOOLS[t].risk})`);
  if ((m.skills ?? []).includes("browser") && !(m.network ?? []).length) flags.push("browser skill without declared network destinations");
  return flags;
}

function ensurePublisher(name: string, ownerUserId: string | null, verified = false) {
  const p = one<any>("select * from publishers where name=?", name);
  if (p) return p.id;
  const pid = id("pub");
  exec("insert into publishers values (?,?,?,?)", pid, name, ownerUserId, verified ? 1 : 0);
  return pid;
}

export function publishVersion(m: Manifest, publisherId: string, opts: { platform?: boolean; forkedFrom?: string } = {}) {
  const errs = validateManifest(m);
  if (errs.length) return { error: errs.join("; ") };
  return tx(() => {
    let t = one<any>("select * from templates where slug=?", m.slug);
    if (t && t.publisher_id !== publisherId) return { error: "slug belongs to another publisher" };
    if (t && one("select 1 from template_versions where template_id=? and version=?", t.id, m.version)) return { error: `version ${m.version} already exists` };
    const flags = reviewFlags(m);
    // Curated/closed: only platform templates go live without review (plan §30).
    const status = opts.platform && !flags.length ? "published" : "in_review";
    if (!t) {
      t = { id: id("tpl") };
      exec("insert into templates (id, slug, publisher_id, name, tagline, status, latest_version, forked_from, created_at) values (?,?,?,?,?,?,?,?,?)",
        t.id, m.slug, publisherId, m.name, m.tagline ?? "", status, m.version, opts.forkedFrom ?? null, now());
    } else exec("update templates set name=?, tagline=?, status=?, latest_version=? where id=?", m.name, m.tagline ?? "", status, m.version, t.id);
    exec("insert into template_versions values (?,?,?,?,?)", t.id, m.version, S(m), flags.join("; ") || null, now());
    return { id: t.id, status, flags };
  });
}

export function reviewTemplate(templateId: string, decision: "approve" | "reject", reviewer: string) {
  exec("update templates set status=? where id=?", decision === "approve" ? "published" : "rejected", templateId);
  emit("TEMPLATE_REVIEWED", { actor: reviewer, data: { templateId, decision } });
}

export function seedFirstParty(dir = join(import.meta.dir, "..", "agents")) {
  const pub = ensurePublisher("platform", null, true);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const m: Manifest = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const t = one<any>("select * from templates where slug=?", m.slug);
    if (t?.latest_version === m.version) continue;
    const r = publishVersion(m, pub, { platform: true });
    if ("error" in r) throw new Error(`${f}: ${r.error}`);
    exec("update templates set featured=1 where slug=?", m.slug);
  }
}

export const getManifest = (templateId: string, version?: string): Manifest | null => {
  const t = one<any>("select * from templates where id=? or slug=?", templateId, templateId);
  if (!t) return null;
  const v = one<any>("select manifest from template_versions where template_id=? and version=?", t.id, version ?? t.latest_version);
  return v ? J(v.manifest) : null;
};

export function createAgent(workspaceId: string, userId: string, a: { name: string; title?: string; job: string; instructions?: string; skills: string[];
  permissions?: Record<string, string>; model_profile?: string; template_id?: string; template_version?: string; onboarding?: any; avatar?: string }) {
  const aid = id("agt");
  exec(`insert into agents (id, workspace_id, name, avatar, job, instructions, skills, permissions, model_profile, template_id, template_version, onboarding, created_by, created_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, aid, workspaceId, a.name, a.avatar ?? a.name[0], a.job, a.instructions ?? (a.title ? `You are ${a.name}, a ${a.title}.` : ""),
    S(a.skills), S(a.permissions ?? {}), a.model_profile ?? "standard", a.template_id ?? null, a.template_version ?? null, S(a.onboarding ?? {}), userId, now());
  emit("AGENT_CREATED", { workspace_id: workspaceId, actor: userId, data: { agent_id: aid, name: a.name } });
  return one<any>("select * from agents where id=?", aid);
}

/** Install a published template into a workspace as an Agent Instance. User data lives only in the instance (plan §2.3). */
export function install(slug: string, workspaceId: string, userId: string, answers: Record<string, string> = {}) {
  const t = one<any>("select * from templates where slug=?", slug);
  if (!t || t.status !== "published") return { error: "template not available" };
  const m = getManifest(t.id)!;
  const instructions = [m.instructions, m.scope && `Scope: ${m.scope}`, ...(m.escalation ?? []).map((e) => `Escalate: ${e}`),
    ...Object.entries(answers).map(([k, v]) => `${m.onboarding?.find((q) => q.id === k)?.question ?? k} → ${v}`)].filter(Boolean).join("\n");
  const agent = createAgent(workspaceId, userId, { name: m.name, title: m.title, job: m.job, instructions, skills: m.skills, permissions: m.permissions,
    model_profile: m.model_profile, template_id: t.id, template_version: m.version, onboarding: answers, avatar: m.avatar });
  exec("insert into installs values (?,?,?,?,?,?)", id("ins"), t.id, m.version, workspaceId, agent.id, now());
  return { agent, connections: connectionsNeeded(m.skills), permissions: permissionTable(m.skills, m.permissions) };
}

/** Upgrade an instance to the template's latest version: config changes, memory/connections/channels stay. */
export function upgradeInstance(agentId: string) {
  const a = one<any>("select * from agents where id=?", agentId);
  if (!a?.template_id) return { error: "not a template instance" };
  const m = getManifest(a.template_id)!;
  exec("update agents set job=?, skills=?, permissions=?, model_profile=?, template_version=? where id=?", m.job, S(m.skills), S(m.permissions ?? {}), m.model_profile ?? "standard", m.version, agentId);
  return { version: m.version };
}

/** Fork copies configuration only — never creator or user data (plan §18.5). */
export function fork(slug: string, userId: string, newSlug: string) {
  const src = one<any>("select * from templates where slug=?", slug);
  if (!src) return { error: "no such template" };
  const m = { ...getManifest(src.id)!, slug: newSlug, version: "0.1.0", publisher: one<any>("select name from users where id=?", userId)?.name ?? "me" };
  const pub = ensurePublisher(`user:${userId}`, userId);
  const r = publishVersion(m, pub, { forkedFrom: src.id });
  if ("error" in r) return r;
  exec("update templates set status='draft' where id=?", r.id);
  return { ...r, status: "draft", manifest: m };
}

export function submitForReview(templateId: string, userId: string, m: Manifest) {
  const t = one<any>("select t.*, p.owner_user_id from templates t join publishers p on p.id=t.publisher_id where t.id=?", templateId);
  if (!t || t.owner_user_id !== userId) return { error: "not your template" };
  return publishVersion({ ...m, slug: t.slug }, t.publisher_id);
}

/** Reviews only after meaningful usage (plan §30): the reviewer's install must have >= 3 completed runs. */
export function addReview(slug: string, userId: string, rating: number, text: string) {
  const t = one<any>("select * from templates where slug=?", slug);
  if (!t) return { error: "no such template" };
  const used = one<{ n: number }>(`select count(*) n from runs r join installs i on i.agent_id=r.agent_id join memberships m on m.workspace_id=i.workspace_id
    where i.template_id=? and m.user_id=? and r.status='completed'`, t.id, userId)!.n;
  if (used < 3) return { error: "use the agent a bit more before reviewing (3 completed tasks)" };
  if (rating < 1 || rating > 5) return { error: "rating must be 1-5" };
  exec("insert into reviews values (?,?,?,?,?,?)", id("rev"), t.id, userId, rating, text, now());
  return { ok: true };
}

/** Aggregated creator analytics. Never conversations, memory, credentials or tool output (plan §18.3). */
export function creatorAnalytics(templateId: string) {
  const q = (sql: string) => one<{ n: number }>(sql, templateId)!.n;
  return {
    installs: q("select count(*) n from installs where template_id=?"),
    active_instances: q("select count(distinct a.id) n from agents a join installs i on i.agent_id=a.id where i.template_id=? and a.status='active'"),
    runs_completed: q("select count(*) n from runs r join installs i on i.agent_id=r.agent_id where i.template_id=? and r.status='completed'"),
    runs_failed: q("select count(*) n from runs r join installs i on i.agent_id=r.agent_id where i.template_id=? and r.status='failed_terminal'"),
    approvals_granted: q("select count(*) n from approvals a join installs i on i.agent_id=a.agent_id where i.template_id=? and a.status='approved'"),
    approvals_total: q("select count(*) n from approvals a join installs i on i.agent_id=a.agent_id where i.template_id=? and a.status!='pending'"),
    avg_rating: one<any>("select avg(rating) r from reviews where template_id=?", templateId)?.r ?? null,
  };
}

export const listTemplates = (status = "published") =>
  all<any>(`select t.*, p.name publisher, (select count(*) from installs i where i.template_id=t.id) installs,
    (select avg(rating) from reviews r where r.template_id=t.id) rating from templates t join publishers p on p.id=t.publisher_id
    where t.status=? order by t.featured desc, installs desc`, status);
