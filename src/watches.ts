// Availability watches for anything on a website: ticket drops, hotel holds, class spots, a product back in stock.
// The restaurant watch (reservations.ts) knows Resy/OpenTable; this one knows nothing about the site — it uses the browser
// runner to *look* (a read-only task) on a schedule that speeds up around the moment things open, and when something is
// there it hands the agent a pre-planned browser step to act, which goes through the normal approval card (or a standing
// approval the person gave when they set the watch).
import { all, one, exec, emit, id, now, S, tzOf, fmtLocal } from "./db";
import * as rt from "./runtime";
import { obj, type ToolDef } from "./tools";

export interface SiteWatch { id: string; workspace_id: string; agent_id: string; room_id: string; user_id: string; what: string; url: string; site: string; opens_at: number | null; until: number;
  every_min: number; max_price: number | null; quantity: number; action: "notify" | "act"; status: string; checks: number; last_result: string | null; pending_run_id: string | null; next_check_at: number; created_at: number }

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
/** Fast around the drop (every 30s for the first 10 minutes after it opens), otherwise the chosen cadence. */
function nextCheck(w: SiteWatch) {
  const t = now();
  if (w.opens_at && t >= w.opens_at - 60_000 && t <= w.opens_at + 10 * 60_000) return t + 30_000;
  if (w.opens_at && t < w.opens_at) return Math.min(w.opens_at - 60_000, t + w.every_min * 60_000);
  return t + w.every_min * 60_000;
}

/** What the browser is asked to do on each check: look only, report in a fixed shape the checker can read. */
export const checkTask = (w: SiteWatch) =>
  `Look only — do not add to cart, reserve, buy, log in or submit anything. On this page, check whether "${w.what}" is currently available${w.max_price != null ? ` at or under $${w.max_price} each` : ""}${w.quantity > 1 ? ` for ${w.quantity}` : ""}. ` +
  `Use the site's search or filters if needed. Finish with exactly one line in this format: AVAILABLE: yes|no | PRICE: <lowest price or n/a> | DETAIL: <what and where, one sentence>`;

export function parseCheck(text: string) {
  const m = String(text).match(/AVAILABLE:\s*(yes|no)\s*\|\s*PRICE:\s*([^|]*)\|\s*DETAIL:\s*(.*)$/im);
  if (!m) return { available: /\bavailable: yes\b/i.test(text), price: null as number | null, detail: String(text).slice(0, 200) };
  const price = parseFloat(m[2].replace(/[^\d.]/g, ""));
  return { available: m[1].toLowerCase() === "yes", price: Number.isFinite(price) ? price : null, detail: m[3].trim().slice(0, 200) };
}

/** Run every due watch: look with the browser; on a hit, start a run that acts (approval applies). Called from the worker tick. */
export async function checkSiteWatches(look: (w: SiteWatch) => Promise<string> = defaultLook) {
  let n = 0;
  for (const w of all<SiteWatch>("select * from site_watches where status='active' and next_check_at<=?", now())) {
    n++;
    if (now() > w.until) { exec("update site_watches set status='expired' where id=?", w.id); rt.postMessage(w.room_id, { sender: w.agent_id, text: `Stopped watching ${w.site} for ${w.what} — the window passed without it opening.`, targets: rt.replyTargets(w.room_id, null) }); continue; }
    if (w.pending_run_id && !rt.isFinished(w.pending_run_id)) { exec("update site_watches set next_check_at=? where id=?", nextCheck(w), w.id); continue; }
    if (w.pending_run_id && one("select 1 from approvals where run_id=? and status='rejected'", w.pending_run_id)) {
      exec("update site_watches set status='paused', pending_run_id=null where id=?", w.id);
      rt.postMessage(w.room_id, { sender: w.agent_id, text: `Paused watching ${w.site} for ${w.what}. Say "keep watching" to resume.`, targets: rt.replyTargets(w.room_id, null) });
      continue;
    }
    let result: string;
    try { result = await look(w); } catch (e: any) { result = `check failed: ${e.message}`; }
    const r = parseCheck(result);
    exec("update site_watches set checks=checks+1, last_result=?, next_check_at=? where id=?", result.slice(0, 500), nextCheck(w), w.id);
    const okPrice = w.max_price == null || r.price == null || r.price <= w.max_price;
    if (!r.available || !okPrice) continue;
    const agent = one<any>("select * from agents where id=?", w.agent_id), room = one<any>("select * from rooms where id=?", w.room_id);
    const run = rt.createRun({ room, agent, requestedBy: w.user_id, kind: "task",
      objective: `${w.what} is available on ${w.site}${r.price != null ? ` at $${r.price}` : ""}: ${r.detail} (watch ${w.id}).` });
    exec("update runs set brief_status='skipped' where id=?", run.id);
    if (w.action === "act") {
      // A pre-planned browser step: book/buy it, stopping at the final page unless a standing approval covers it. The approval card shows exactly this.
      const task = `Get "${w.what}"${w.quantity > 1 ? ` (${w.quantity})` : ""}${w.max_price != null ? ` at or under $${w.max_price} each` : ""} on this site, as the person asked. Complete the purchase or booking.`;
      rt.appendStep(run.id, "assistant", { text: "", toolCalls: [{ id: `watch_${w.id}`, name: "browser.task", input: { task, start_url: w.url, site: w.site } }] });
    } else {
      rt.appendStep(run.id, "signal", { text: `[EVENT] Your watch found it: ${w.what} on ${w.site}${r.price != null ? ` at $${r.price}` : ""}. ${r.detail}. Tell the person now with the link (${w.url}) and ask if they want you to get it.` });
    }
    exec("update site_watches set pending_run_id=? where id=?", run.id, w.id);
    emit("WATCH_HIT", { workspace_id: w.workspace_id, room_id: w.room_id, run_id: run.id, actor: w.agent_id, data: { watch_id: w.id, site: w.site, what: w.what, price: r.price, action: w.action } });
  }
  return n;
}
async function defaultLook(w: SiteWatch) {
  const { getTool } = await import("./tools");
  const agent = one<any>("select * from agents where id=?", w.agent_id), room = one<any>("select * from rooms where id=?", w.room_id);
  const out = await getTool("browser.task")!.execute({ task: checkTask(w), start_url: w.url, site: w.site }, { run: { id: `watch:${w.id}`, workspace_id: w.workspace_id, requested_by: w.user_id, room_id: w.room_id }, agent, room, idempotencyKey: `${w.id}:${now()}` } as any);
  return String(out.output?.result ?? out.output?.summary ?? S(out.output));
}

export function registerWatchTools(def: (d: ToolDef) => void) {
  def({
    id: "watch.site", description: "Watch a website for something to become available — tickets going on sale, a hotel room, a class spot, an item back in stock — and act the moment it does. Give the page URL, what to look for, when it opens (opens_at, ISO with offset) if known, a max price and quantity, and how long to keep watching. action='notify' (default) tells the person with the link; action='act' tries to get it and asks for approval unless they pre-approved.",
    risk: "write_internal", idempotency: "safe", defaultApproval: "none",
    inputSchema: obj({ what: { type: "string" }, url: { type: "string" }, opens_at: { type: "string" }, until: { type: "string", description: "ISO; default 7 days" }, every_minutes: { type: "number" }, max_price: { type: "number" }, quantity: { type: "number" }, action: { type: "string", enum: ["notify", "act"] } }, ["what", "url"]),
    async execute(i, ctx) {
      const u = new URL(String(i.url)); if (!/^https?:$/.test(u.protocol)) throw new Error("http(s) URLs only");
      const opens = i.opens_at ? Date.parse(String(i.opens_at)) : null;
      if (i.opens_at && !Number.isFinite(opens)) throw new Error("opens_at must be an ISO date-time");
      const until = i.until ? Date.parse(String(i.until)) : now() + 7 * 864e5;
      const w: SiteWatch = { id: id("sw"), workspace_id: ctx.run.workspace_id, agent_id: ctx.agent.id, room_id: ctx.room.id, user_id: ctx.run.requested_by, what: String(i.what).slice(0, 200), url: u.toString(), site: host(u.toString()),
        opens_at: Number.isFinite(opens as number) ? (opens as number) : null, until: Number.isFinite(until) ? until : now() + 7 * 864e5, every_min: Math.max(5, Math.min(1440, Number(i.every_minutes) || 30)), max_price: i.max_price != null ? Number(i.max_price) : null, quantity: Math.max(1, Number(i.quantity) || 1),
        action: i.action === "act" ? "act" : "notify", status: "active", checks: 0, last_result: null, pending_run_id: null, next_check_at: 0, created_at: now() };
      w.next_check_at = w.opens_at ? Math.max(now(), w.opens_at - 60_000) : now();
      exec("insert into site_watches (id, workspace_id, agent_id, room_id, user_id, what, url, site, opens_at, until, every_min, max_price, quantity, action, status, checks, last_result, pending_run_id, next_check_at, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        w.id, w.workspace_id, w.agent_id, w.room_id, w.user_id, w.what, w.url, w.site, w.opens_at, w.until, w.every_min, w.max_price, w.quantity, w.action, w.status, 0, null, null, w.next_check_at, w.created_at);
      emit("WATCH_CREATED", { workspace_id: w.workspace_id, room_id: w.room_id, run_id: ctx.run.id, actor: ctx.agent.id, data: { watch_id: w.id, site: w.site, what: w.what, opens_at: w.opens_at, action: w.action } });
      const tz = tzOf(ctx.run.requested_by);
      return { status: "SUCCEEDED", output: { watch_id: w.id.slice(-6), site: w.site, what: w.what, first_check: fmtLocal(w.next_check_at, tz), opens_at: w.opens_at ? fmtLocal(w.opens_at, tz) : null, until: fmtLocal(w.until, tz), action: w.action,
        note: w.opens_at ? "Checks every 30 seconds for the first 10 minutes after it opens." : `Checks every ${w.every_min} minutes.` } };
    },
  });
  def({
    id: "watch.list", description: "The active website watches in this chat.", risk: "read", idempotency: "safe", defaultApproval: "none", inputSchema: obj({}),
    async execute(_i, ctx) {
      const tz = tzOf(ctx.run.requested_by);
      return { status: "SUCCEEDED", output: { watches: all<SiteWatch>("select * from site_watches where room_id=? and status in ('active','paused') order by created_at", ctx.room.id).map((w) => ({ id: w.id.slice(-6), what: w.what, site: w.site, status: w.status, checks: w.checks, next_check: fmtLocal(w.next_check_at, tz), until: fmtLocal(w.until, tz), last_result: w.last_result?.slice(0, 120) ?? null })) } };
    },
  });
  def({
    id: "watch.cancel", description: "Stop (or resume with resume=true) a website watch by id or words from what it watches.", risk: "write_internal", idempotency: "safe", defaultApproval: "none",
    inputSchema: obj({ watch: { type: "string" }, resume: { type: "boolean" } }, ["watch"]),
    async execute({ watch, resume }, ctx) {
      const w = all<SiteWatch>("select * from site_watches where room_id=? and status in ('active','paused') order by created_at desc", ctx.room.id).find((x) => x.id.endsWith(String(watch)) || x.what.toLowerCase().includes(String(watch).toLowerCase()));
      if (!w) throw new Error("no such watch");
      exec("update site_watches set status=?, pending_run_id=null, next_check_at=? where id=?", resume ? "active" : "cancelled", now(), w.id);
      return { status: "SUCCEEDED", output: { id: w.id.slice(-6), what: w.what, status: resume ? "active" : "cancelled" } };
    },
  });
}
