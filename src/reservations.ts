// Reservation agent domain: search, book, and watch hard-to-get tables on Resy / OpenTable.
// The hard part is speed + trust: watches poll fast around release times and book instantly, but only inside limits the
// person pre-approved (a standing approval), otherwise they get a one-tap approval card on their phone.
// Providers: "browser" (Browser Use / Stagehand via the browser runner, with the user's site login) and "sandbox"
// (fictional venues that release tables on a schedule; used in test mode and when no browser runner is configured).
import { all, one, exec, emit, id, now, S, J, tx } from "./db";
import { extraPlanners, extraChains, extraSummaries, type Msg } from "./model";
import * as rt from "./runtime";
import * as tools from "./tools";

// ---------------- natural-language parsing (offline planner + tool input tolerance) ----------------
const WD = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NUMW: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const atDay = (base: number, add: number) => { const d = new Date(base); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + add); return d; };

/** Dates mentioned in text, as YYYY-MM-DD (local). */
export function parseDates(text: string, base = now()): string[] {
  const t = text.toLowerCase(), out: string[] = [];
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of t.matchAll(new RegExp(`\\b(${MON.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:\\s*[-–]\\s*(\\d{1,2}))?`, "g"))) {
    const mon = MON.indexOf(m[1]), from = Number(m[2]), to = Number(m[3] ?? m[2]);
    for (let day = from; day <= Math.min(to, from + 13); day++) {
      const d = new Date(base); d.setHours(12, 0, 0, 0); d.setMonth(mon, day);
      if (+d < base - 864e5) d.setFullYear(d.getFullYear() + 1);
      out.push(ymd(d));
    }
  }
  if (/\b(tonight|today)\b/.test(t)) out.push(ymd(atDay(base, 0)));
  if (/\btomorrow\b/.test(t)) out.push(ymd(atDay(base, 1)));
  if (/\bthis weekend\b/.test(t)) for (const wd of [5, 6]) out.push(ymd(atDay(base, (wd - new Date(base).getDay() + 7) % 7)));
  for (const m of t.matchAll(new RegExp(`\\b(next\\s+)?(${WD.join("|")})s?\\b`, "g"))) {
    let add = (WD.indexOf(m[2]) - new Date(base).getDay() + 7) % 7;
    if (m[1]) add += add === 0 ? 7 : 0;
    out.push(ymd(atDay(base, add)));
  }
  return [...new Set(out)];
}
const hhmm = (h: number, m = 0) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
function toH(hs: string, ms: string | undefined, ap: string | undefined, assumePm = true) {
  let h = Number(hs); if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0; if (!ap && assumePm && h < 11) h += 12;
  return { h, m: Number(ms ?? 0) };
}
/** Time window from text; defaults to prime dinner time. */
export function parseWindow(text: string): { from: string; to: string } {
  const t = text.toLowerCase();
  const range = t.match(/\b(?:between\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|and)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (range) { const b = toH(range[4], range[5], range[6]), a = toH(range[1], range[2], range[3] ?? range[6]); return { from: hhmm(a.h, a.m), to: hhmm(b.h, b.m) }; }
  const around = t.match(/\b(?:around|about|at|~)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (around) { const a = toH(around[1], around[2], around[3]); const s = a.h * 60 + a.m; return { from: hhmm(Math.floor((s - 45) / 60), (s - 45) % 60), to: hhmm(Math.floor((s + 45) / 60), (s + 45) % 60) }; }
  const after = t.match(/\bafter\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/); if (after) { const a = toH(after[1], after[2], after[3]); return { from: hhmm(a.h, a.m), to: "22:30" }; }
  const before = t.match(/\bbefore\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/); if (before) { const a = toH(before[1], before[2], before[3]); return { from: "17:00", to: hhmm(a.h, a.m) }; }
  if (/\blunch\b/.test(t)) return { from: "11:30", to: "14:00" };
  if (/\bbrunch\b/.test(t)) return { from: "10:00", to: "14:00" };
  return { from: "18:00", to: "21:30" };
}
export function parseParty(text: string): number {
  const m = text.toLowerCase().match(/\b(?:for|party of|table for|table of|group of)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b/);
  return m ? Number(NUMW[m[1]] ?? m[1]) : /\b(us two|the two of us|date night)\b/i.test(text) ? 2 : 2;
}

// ---------------- sandbox provider (fictional venues) ----------------
export const SANDBOX_VENUES = [
  { id: "sb-lumen", name: "Lumen", area: "West Village", cuisine: "Italian", site: "resy", hot: true, release_days: 14, release_hour: 10, deposit: 0 },
  { id: "sb-kinjo", name: "Kinjo", area: "East Village", cuisine: "Japanese omakase", site: "resy", hot: true, release_days: 30, release_hour: 9, deposit: 50 },
  { id: "sb-ember-room", name: "The Ember Room", area: "Flatiron", cuisine: "Steakhouse", site: "opentable", hot: true, release_days: 21, release_hour: 10, deposit: 0 },
  { id: "sb-osteria-nove", name: "Osteria Nove", area: "SoHo", cuisine: "Italian", site: "opentable", hot: false, release_days: 60, release_hour: 0, deposit: 0 },
  { id: "sb-casa-verde", name: "Casa Verde", area: "Williamsburg", cuisine: "Mexican", site: "resy", hot: false, release_days: 60, release_hour: 0, deposit: 0 },
  { id: "sb-harbor-oyster", name: "Harbor Oyster Bar", area: "Seaport", cuisine: "Seafood", site: "opentable", hot: false, release_days: 60, release_hour: 0, deposit: 0 },
];
const venueOf = (q: string) => {
  const t = q.toLowerCase();
  return SANDBOX_VENUES.filter((v) => t.includes(v.name.toLowerCase()) || v.id === q || (t.length > 3 && (v.cuisine.toLowerCase().includes(t) || v.area.toLowerCase().includes(t))));
};
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
/** When a hot venue releases tables for `date` (local time). */
export function releaseAt(v: (typeof SANDBOX_VENUES)[number], date: string) {
  const d = new Date(`${date}T00:00:00`); d.setDate(d.getDate() - v.release_days); d.setHours(v.release_hour, 0, 0, 0);
  return +d;
}
const SNAP_MS = 120_000; // in the sandbox, released prime tables are taken by someone else after 2 minutes

function sandboxSearch(venues: typeof SANDBOX_VENUES, date: string, party: number, from: string, to: string) {
  const slots: any[] = [];
  for (const v of venues) {
    if (party > 8) continue;
    const times: string[] = [];
    if (!v.hot) { for (let m = 17 * 60 + 30; m <= 22 * 60; m += 15) if (hash(`${v.id}|${date}|${m}`) % 3 === 0) times.push(hhmm(Math.floor(m / 60), m % 60)); }
    else {
      const rel = releaseAt(v, date);
      if (now() >= rel && now() < rel + SNAP_MS) times.push("19:30", "20:15", "17:00", "22:00");
      else if (now() >= rel) times.push("17:00", "22:00"); // only the unloved times are left
    }
    const mine = all<any>("select time from reservations where venue_id=? and date=? and status='booked'", v.id, date).map((r) => r.time);
    for (const time of times) if (time >= from && time <= to && !mine.includes(time))
      slots.push({ site: v.site, venue: v.name, venue_id: v.id, date, time, party_size: party, slot_id: `${v.id}|${date}|${time}`, deposit_per_person: v.deposit || null, url: `https://${v.site}.example/${v.id}`, sandbox: true });
  }
  return slots;
}

// ---------------- provider routing ----------------
async function search(q: { query: string; date: string; party_size: number; time_from: string; time_to: string; site?: string }, ctx: tools.ToolCtx) {
  const sandboxVenues = venueOf(q.query);
  const useBrowser = !sandboxVenues.length && ctx.room?.mode !== "test" && process.env.RESERVATIONS_PROVIDER !== "sandbox" && (tools.browserMcp(ctx.agent.id) || process.env.BROWSER_TASK_URL);
  if (!useBrowser) return { provider: "sandbox", slots: sandboxSearch(sandboxVenues.length ? sandboxVenues : SANDBOX_VENUES.filter((v) => !q.site || v.site === q.site), q.date, q.party_size, q.time_from, q.time_to) };
  const site = q.site ?? "resy";
  const r = await tools.runBrowser(`On ${site}.com, find reservation availability for "${q.query}" on ${q.date} for ${q.party_size} people between ${q.time_from} and ${q.time_to}. Do NOT book anything.
Reply ONLY with JSON: {"slots":[{"venue":"...","time":"HH:MM","slot_id":"<what you'd need to book it>","deposit_per_person":number|null,"url":"..."}]}`, `https://${site}.com`, ctx);
  const slots = (typeof r?.output === "object" ? r.output.slots : null) ?? [];
  return { provider: "browser", slots: slots.map((s: any) => ({ ...s, site, date: q.date, party_size: q.party_size, venue_id: s.venue_id ?? `${site}:${s.venue}` })) };
}

async function book(i: any, ctx: tools.ToolCtx) {
  if (String(i.venue_id).startsWith("sb-") || ctx.room?.mode === "test") {
    const v = SANDBOX_VENUES.find((x) => x.id === i.venue_id);
    if (!v) throw new tools.ToolError("BUSINESS_RULE", "unknown venue");
    const open = sandboxSearch([v], i.date, i.party_size, i.time, i.time).length > 0;
    if (!open) return { status: "FAILED" as const, output: { status: "unavailable", venue: v.name, date: i.date, time: i.time, note: "someone else got it first" } };
    return { status: "SUCCEEDED" as const, output: record(i, v.name, v.site, `${v.site.toUpperCase().slice(0, 3)}-${hash(i.slot_id ?? `${i.date}${i.time}`) % 900000 + 100000}`, true) };
  }
  const site = i.site ?? String(i.venue_id).split(":")[0];
  const r = await tools.runBrowser(`Book a table on ${site}.com: "${i.venue}" on ${i.date} at ${i.time} for ${i.party_size} people (slot: ${i.slot_id ?? "n/a"}). Log in with {{username}} / {{password}} if asked.
Only accept a deposit up to $${i.deposit_per_person ?? 0} per person. Reply ONLY with JSON: {"status":"booked"|"unavailable"|"failed","confirmation":"...","details":"..."}`, `https://${site}.com`, ctx);
  if (!r) throw new tools.ToolError("BUSINESS_RULE", "no browser runner is connected (Connections → MCP server or BROWSER_TASK_URL)");
  const o = typeof r.output === "object" ? r.output : { status: "unknown", details: String(r.output) };
  if (o.status === "booked") return { status: "SUCCEEDED" as const, output: record(i, i.venue, site, o.confirmation ?? "booked", false) };
  if (o.status === "unavailable" || o.status === "failed") return { status: "FAILED" as const, output: { status: o.status, venue: i.venue, details: o.details } };
  return { status: "UNKNOWN" as const, output: o }; // never retry a booking blindly
}

function record(i: any, venue: string, site: string, confirmation: string, sandbox: boolean) {
  const rid = id("rsv");
  exec(`insert into reservations (id, workspace_id, user_id, agent_id, site, venue_id, venue, date, time, party_size, confirmation, deposit, status, sandbox, created_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, rid, i.__ws, i.__user, i.__agent, site, i.venue_id, venue, i.date, i.time, i.party_size, confirmation, i.deposit_per_person ?? 0, "booked", sandbox ? 1 : 0, now());
  if (i.watch_id) exec("update reservation_watches set status='booked', booked_reservation_id=? where id=?", rid, i.watch_id);
  return { status: "booked", reservation_id: rid, venue, date: i.date, time: i.time, party_size: i.party_size, confirmation, site, sandbox };
}

// ---------------- standing approvals ("book it if you can get it, within these limits") ----------------
function matchesLimits(c: any, i: any) {
  return (!c.venue_ids?.length || c.venue_ids.includes(i.venue_id)) && (!c.dates?.length || c.dates.includes(i.date))
    && (!c.time_from || i.time >= c.time_from) && (!c.time_to || i.time <= c.time_to) && (!c.party_size || Number(i.party_size) === Number(c.party_size))
    && Number(i.deposit_per_person ?? 0) <= Number(c.max_deposit_per_person ?? 0);
}
function standingFor(input: any, run: any) {
  for (const s of all<any>("select * from standing_approvals where agent_id=? and tool_id='reservations.book' and status='active' and uses<max_uses and (expires_at is null or expires_at>?)", run.agent_id, now()))
    if (matchesLimits(J(s.constraints, {}), input)) return s.id as string;
  return null;
}

// ---------------- watches ----------------
function nextCheck(w: any) {
  const c = J(w.criteria);
  const t = now(), rel: number | null = w.release_at;
  if (rel && t < rel - 60_000) return Math.min(rel - 60_000, t + (w.interval_ms ?? 10 * 6e4));
  if (rel && t < rel + 10 * 6e4) return t + 5_000; // drop window: every 5 seconds
  return t + (w.interval_ms ?? (c.provider === "browser" ? 10 * 6e4 : 5 * 6e4));
}

/** Worker hook: run due watches. Deterministic and cheap — no model call unless there's something to do. */
export async function checkWatches() {
  let n = 0;
  for (const w of all<any>("select * from reservation_watches where status='active' and next_check_at<=?", now())) {
    n++;
    const c = J(w.criteria);
    if (c.dates.every((d: string) => d < ymd(new Date(now())))) { exec("update reservation_watches set status='expired' where id=?", w.id); continue; }
    if (w.pending_run_id && !rt.isFinished(w.pending_run_id)) { exec("update reservation_watches set next_check_at=? where id=?", nextCheck(w), w.id); continue; }
    const agent = one<any>("select * from agents where id=?", w.agent_id), room = one<any>("select * from rooms where id=?", w.room_id);
    const ctx = { run: { id: "watch", workspace_id: w.workspace_id }, agent, room, idempotencyKey: w.id } as any;
    let hit: any = null;
    for (const date of c.dates) {
      if (date < ymd(new Date(now()))) continue;
      const r = await search({ query: c.query, date, party_size: c.party_size, time_from: c.time_from, time_to: c.time_to, site: c.site }, ctx).catch(() => ({ slots: [] as any[] }));
      hit = r.slots.find((s: any) => Number(s.deposit_per_person ?? 0) <= Number(c.max_deposit_per_person ?? Infinity)) ?? r.slots[0];
      if (hit) break;
    }
    exec("update reservation_watches set checks=checks+1, last_checked_at=?, next_check_at=? where id=?", now(), nextCheck(w), w.id);
    if (!hit) continue;
    // A table opened: hand it to the agent as a pre-planned booking step (policy, approvals, audit all apply).
    const input = { venue_id: hit.venue_id, venue: hit.venue, site: hit.site, date: hit.date, time: hit.time, party_size: hit.party_size, slot_id: hit.slot_id,
      deposit_per_person: hit.deposit_per_person ?? 0, watch_id: w.id };
    const auto = !!standingFor(input, { agent_id: w.agent_id });
    const run = rt.createRun({ room, agent, requestedBy: w.user_id, kind: "task",
      objective: `${auto ? "Book" : "Ask to book"} the table that just opened: ${hit.venue}, ${hit.date} at ${hit.time} for ${hit.party_size} (watch ${w.id}).` });
    exec("update runs set brief_status='skipped' where id=?", run.id);
    rt.appendStep(run.id, "assistant", { text: "", toolCalls: [{ id: `watch_${w.id}`, name: "reservations.book", input }] });
    exec("update reservation_watches set pending_run_id=? where id=?", run.id, w.id);
    emit("WATCH_HIT", { workspace_id: w.workspace_id, room_id: w.room_id, run_id: run.id, actor: w.agent_id, data: { watch_id: w.id, slot: hit, auto } });
  }
  return n;
}

// ---------------- tools ----------------
const isoOrParse = (v: any) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? [String(v)] : parseDates(String(v ?? "")));
const obj = (props: Record<string, any>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description?: string) => ({ type: "string", description }), num = (description?: string) => ({ type: "number", description });

export function registerReservationTools(def: (d: tools.ToolDef) => void) {
  def({
    id: "reservations.search", description: "Find open restaurant reservations (Resy / OpenTable). query = restaurant name, cuisine or area. Dates may be YYYY-MM-DD or natural ('friday').",
    risk: "read", idempotency: "safe", defaultApproval: "none",
    inputSchema: obj({ query: str(), date: str(), party_size: num(), time_from: str("HH:MM"), time_to: str("HH:MM"), site: { type: "string", enum: ["resy", "opentable"] } }, ["query", "date"]),
    async execute(i, ctx) {
      const dates = isoOrParse(i.date); if (!dates.length) throw new tools.ToolError("BUSINESS_RULE", `couldn't understand the date "${i.date}"`);
      const slots: any[] = []; let provider = "sandbox";
      for (const date of dates.slice(0, 7)) { const r = await search({ query: i.query, date, party_size: i.party_size ?? 2, time_from: i.time_from ?? "17:00", time_to: i.time_to ?? "22:30", site: i.site }, ctx); provider = r.provider; slots.push(...r.slots); }
      return { status: "SUCCEEDED", untrusted: provider === "browser", output: { provider, slots: slots.slice(0, 12) } };
    },
  });
  def({
    id: "reservations.book", description: "Book a specific slot returned by reservations.search. Requires approval unless the person pre-approved limits that cover it.",
    risk: "write_external", riskOf: (i) => (Number(i.deposit_per_person ?? 0) > 0 ? "financial" : "write_external"), idempotency: "key_required", defaultApproval: "always",
    inputSchema: obj({ venue_id: str(), venue: str(), site: str(), date: str(), time: str("HH:MM"), party_size: num(), slot_id: str(), deposit_per_person: num(), watch_id: str() }, ["venue_id", "venue", "date", "time", "party_size"]),
    summarize: (i) => `Book ${i.venue} on ${i.date} at ${i.time} for ${i.party_size}${Number(i.deposit_per_person) > 0 ? ` ($${i.deposit_per_person}/person deposit)` : ""}`,
    siteLogin: (i) => (String(i.venue_id).startsWith("sb-") ? undefined : `${i.site ?? String(i.venue_id).split(":")[0]}.com`),
    preApproved: (i, run) => standingFor(i, run),
    async execute(i, ctx) { return book({ ...i, __ws: ctx.run.workspace_id, __user: ctx.run.requested_by, __agent: ctx.agent.id }, ctx); },
  });
  def({
    id: "reservations.watch", description: "Keep checking for a hard-to-get table and act the moment one opens (polls every few seconds around release times). Call reservations.preauthorize afterwards if the person wants it booked automatically.",
    risk: "write_internal", idempotency: "safe", defaultApproval: "none",
    inputSchema: obj({ query: str("restaurant name"), dates: str("e.g. 'friday', 'dec 18-20', '2026-10-09'"), time_from: str(), time_to: str(), party_size: num(), site: str(), release_at: str("ISO time tables drop, if known") }, ["query", "dates"]),
    summarize: (i) => `Watch ${i.query} for ${i.dates}`,
    async execute(i, ctx) {
      const dates = isoOrParse(i.dates); if (!dates.length) throw new tools.ToolError("BUSINESS_RULE", `couldn't understand the dates "${i.dates}"`);
      const v = venueOf(i.query)[0];
      const rel = i.release_at ? Date.parse(i.release_at) : v?.hot ? Math.min(...dates.map((d) => releaseAt(v, d))) : null;
      const criteria = { query: v?.name ?? i.query, venue_ids: v ? [v.id] : [], dates, time_from: i.time_from ?? "18:00", time_to: i.time_to ?? "21:30", party_size: i.party_size ?? 2, site: i.site ?? v?.site,
        provider: v ? "sandbox" : "browser" };
      const wid = id("wch");
      exec(`insert into reservation_watches (id, workspace_id, agent_id, room_id, user_id, criteria, release_at, status, checks, next_check_at, created_at) values (?,?,?,?,?,?,?, 'active', 0, ?, ?)`,
        wid, ctx.run.workspace_id, ctx.agent.id, ctx.room.id, ctx.run.requested_by, S(criteria), rel && rel > now() ? rel : null, now(), now());
      exec("update reservation_watches set next_check_at=? where id=?", nextCheck(one<any>("select * from reservation_watches where id=?", wid)), wid);
      emit("WATCH_CREATED", { workspace_id: ctx.run.workspace_id, room_id: ctx.room.id, run_id: ctx.run.id, actor: ctx.agent.id, data: { watch_id: wid, criteria } });
      return { status: "SUCCEEDED", output: { watch_id: wid, ...criteria, release_at: rel && rel > now() ? new Date(rel).toISOString() : null } };
    },
  });
  def({
    id: "reservations.preauthorize", description: "Ask the person to pre-approve booking limits for a watch, so the table can be booked instantly when it opens. Use watch_id 'latest' for the watch just created.",
    risk: "financial", idempotency: "safe", defaultApproval: "always",
    inputSchema: obj({ watch_id: str(), max_deposit_per_person: num(), max_bookings: num() }, ["watch_id"]),
    summarize: (i) => { const w = watchFor(i.watch_id); const c = J(w?.criteria, {}); return `Pre-approve booking ${c.query ?? "a table"} on ${(c.dates ?? []).join(", ")} ${c.time_from}–${c.time_to} for ${c.party_size}, deposit ≤ $${i.max_deposit_per_person ?? 0}/person, up to ${i.max_bookings ?? 1} booking`; },
    async execute(i, ctx) {
      const w = watchFor(i.watch_id, ctx.agent.id, ctx.room.id);
      if (!w) throw new tools.ToolError("BUSINESS_RULE", "no such watch in this conversation");
      const c = J(w.criteria);
      const sid = id("sta");
      exec("insert into standing_approvals (id, agent_id, tool_id, constraints, max_uses, uses, expires_at, granted_by, ref, status, created_at) values (?,?,?,?,?,0,?,?,?, 'active', ?)",
        sid, ctx.agent.id, "reservations.book", S({ venue_ids: c.venue_ids, dates: c.dates, time_from: c.time_from, time_to: c.time_to, party_size: c.party_size, max_deposit_per_person: i.max_deposit_per_person ?? 0 }),
        i.max_bookings ?? 1, Date.parse(`${c.dates.at(-1)}T23:59:59`), ctx.run.requested_by, w.id, now());
      exec("update reservation_watches set auto_book=1, criteria=json_set(criteria, '$.max_deposit_per_person', ?) where id=?", i.max_deposit_per_person ?? 0, w.id);
      return { status: "SUCCEEDED", output: { standing_approval_id: sid, watch_id: w.id, auto_book: true, query: c.query, dates: c.dates } };
    },
  });
  def({
    id: "reservations.list", description: "List this person's upcoming reservations and active watches.", risk: "read", idempotency: "safe", defaultApproval: "none", inputSchema: obj({}),
    async execute(_i, ctx) {
      return { status: "SUCCEEDED", output: {
        reservations: all<any>("select id, venue, date, time, party_size, confirmation, status from reservations where user_id=? and agent_id=? and date>=? order by date, time", ctx.run.requested_by, ctx.agent.id, ymd(new Date(now()))),
        watches: all<any>("select id, criteria, status, auto_book, release_at, checks from reservation_watches where user_id=? and agent_id=? and status='active'", ctx.run.requested_by, ctx.agent.id).map((w) => ({ ...w, criteria: J(w.criteria) })),
      } };
    },
  });
  def({
    id: "reservations.cancel", description: "Cancel a reservation (or stop a watch) by id.", risk: "destructive", idempotency: "safe", defaultApproval: "always",
    inputSchema: obj({ id: str("reservation id (rsv_...) or watch id (wch_...)") }, ["id"]),
    summarize: (i) => { const r = one<any>("select venue, date, time from reservations where id=?", i.id); return r ? `Cancel ${r.venue} on ${r.date} at ${r.time}` : `Stop watch ${i.id}`; },
    async execute(i, ctx) {
      if (String(i.id).startsWith("wch_")) { exec("update reservation_watches set status='stopped' where id=? and agent_id=?", i.id, ctx.agent.id); return { status: "SUCCEEDED", output: { stopped: i.id } }; }
      const r = one<any>("select * from reservations where id=? and agent_id=?", i.id, ctx.agent.id);
      if (!r) throw new tools.ToolError("BUSINESS_RULE", "no such reservation");
      if (!r.sandbox) { const b = await tools.runBrowser(`On ${r.site}.com, cancel the reservation at ${r.venue} on ${r.date} at ${r.time} (confirmation ${r.confirmation}). Reply ONLY with JSON {"status":"cancelled"|"failed"}`, `https://${r.site}.com`, ctx);
        if (b?.output?.status !== "cancelled") return { status: "UNKNOWN", output: { note: "couldn't confirm the cancellation", details: b?.output } }; }
      exec("update reservations set status='cancelled' where id=?", r.id);
      return { status: "SUCCEEDED", output: { cancelled: r.id, venue: r.venue } };
    },
  });
}
function watchFor(wid: string, agentId?: string, roomId?: string) {
  if (wid === "latest" || !wid) return one<any>(`select * from reservation_watches where status='active' ${agentId ? "and agent_id=? and room_id=?" : ""} order by created_at desc limit 1`, ...(agentId ? [agentId, roomId] : []));
  return one<any>(`select * from reservation_watches where id=? ${agentId ? "and agent_id=? and room_id=?" : ""}`, wid, ...(agentId ? [agentId, roomId] : []));
}

// ---------------- offline planner + summaries ----------------
extraPlanners.push((text, c) => {
  if (!c.tools.includes("reservations.search")) return { steps: [] };
  const t = text.toLowerCase();
  if (/\b(my reservations|what('?s| do i have) booked|upcoming reservations|my watches)\b/.test(t)) return { steps: [{ name: "reservations.list", input: {} }], exclusive: true };
  const v = SANDBOX_VENUES.find((x) => t.includes(x.name.toLowerCase()));
  if (!v && !/\b(reservation|reserve|book|table|dinner|lunch|brunch|resy|opentable|spot)\b/.test(t)) return { steps: [] };
  const q = v?.name ?? text.match(/\bat\s+([A-Z][\w'&]*(?:\s+[A-Z][\w'&]*)*)/)?.[1] ?? text.match(/"([^"]+)"/)?.[1] ?? (t.match(/\b(italian|japanese|sushi|omakase|mexican|steak\w*|seafood)\b/)?.[1] ?? "dinner");
  const dates = parseDates(text), w = parseWindow(text), party = parseParty(text);
  if (!dates.length) return { steps: [] }; // the brief will ask which day
  const watch = /\b(watch|keep (trying|checking|an eye)|when (it|a table|something|one) opens|if (anything|something|a table) opens|snipe|as soon as|drops?|release|cancell?ations?|grab)\b/.test(t);
  const auto = /\b(book it|grab it|go ahead and book|book automatically|auto[- ]?book|snag it|just book|grab (me|us) (one|a table))\b/.test(t) && !/\b(don'?t|do not) book\b/.test(t);
  if (watch) return { exclusive: true, steps: [
    { name: "reservations.watch", input: { query: q, dates: dates.join(", "), time_from: w.from, time_to: w.to, party_size: party } },
    ...(auto && c.tools.includes("reservations.preauthorize") ? [{ name: "reservations.preauthorize", input: { watch_id: "latest", max_deposit_per_person: Number(text.match(/deposit\D{0,20}\$(\d+)/i)?.[1] ?? (v?.deposit ?? 0)) } }] : []),
  ] };
  return { exclusive: true, steps: dates.slice(0, 3).map((d) => ({ name: "reservations.search", input: { query: q, date: d, party_size: party, time_from: w.from, time_to: w.to } })) };
});
extraChains.push((objective, last: Msg) => {
  if (last.toolName !== "reservations.search" || !/\b(book|reserve|grab|get us)\b/i.test(objective) || /\b(don'?t|do not) book\b/i.test(objective)) return null;
  try { const s = JSON.parse(last.content.replace(/^<untrusted[^>]*>\n?|\n?<\/untrusted>$/g, "")).slots?.[0]; if (!s) return null;
    return { name: "reservations.book", input: { venue_id: s.venue_id, venue: s.venue, site: s.site, date: s.date, time: s.time, party_size: s.party_size, slot_id: s.slot_id, deposit_per_person: s.deposit_per_person ?? 0 } };
  } catch { return null; }
});
const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtTime = (t: string) => { const [h, m] = t.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`; };
extraSummaries["reservations.search"] = (j) => j.slots?.length
  ? `Open tables${j.provider === "sandbox" ? " (sandbox data)" : ""}:\n${j.slots.slice(0, 6).map((s: any, n: number) => `${n + 1}. ${s.venue} — ${fmtDate(s.date)} ${fmtTime(s.time)} for ${s.party_size}${s.deposit_per_person ? ` ($${s.deposit_per_person}/pp deposit)` : ""}`).join("\n")}\nSay "book 1" or the time you want.`
  : "Nothing open in that window. Want me to watch it and grab a table the moment one opens?";
extraSummaries["reservations.book"] = (j) => j.status === "booked"
  ? `🎉 Booked: ${j.venue}, ${fmtDate(j.date)} at ${fmtTime(j.time)} for ${j.party_size}. Confirmation ${j.confirmation}${j.sandbox ? " (sandbox)" : ""}.`
  : `Couldn't book ${j.venue}${j.note ? ` — ${j.note}` : j.details ? ` — ${j.details}` : ""}.`;
extraSummaries["reservations.watch"] = (j) => `👀 Watching ${j.query} for ${j.dates.map(fmtDate).join(", ")}, ${fmtTime(j.time_from)}–${fmtTime(j.time_to)}, party of ${j.party_size}.${j.release_at ? ` Tables drop ${new Date(j.release_at).toLocaleString()} — I'll be checking every few seconds then.` : " I'll check regularly."}`;
extraSummaries["reservations.preauthorize"] = (j) => `✅ Auto-book is on for ${j.query}: I'll book the first table that fits your limits and text you the confirmation.`;
extraSummaries["reservations.list"] = (j) => [j.reservations.length ? `Upcoming:\n${j.reservations.map((r: any) => `• ${r.venue} ${fmtDate(r.date)} ${fmtTime(r.time)} (${r.confirmation})`).join("\n")}` : "No upcoming reservations.",
  j.watches.length ? `Watching:\n${j.watches.map((w: any) => `• ${w.criteria.query} — ${w.criteria.dates.map(fmtDate).join(", ")}${w.auto_book ? " (auto-book)" : ""}`).join("\n")}` : ""].filter(Boolean).join("\n");
extraSummaries["reservations.cancel"] = (j) => (j.stopped ? "Stopped watching." : `Cancelled ${j.venue}.`);
