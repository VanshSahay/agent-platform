// Test harness: fresh in-memory DB, controllable clock, fake network, scripted model, signed-webhook builders.
import { createHmac } from "node:crypto";
import { openDb, resetClock, one, all, exec, id, now, J, S } from "../src/db";
import { hooks, type ModelRequest, type ModelResult } from "../src/model";
import { seedFirstParty, install, createAgent } from "../src/templates";
import { addChannelIdentity, handleWebhook } from "../src/channels";
import * as rt from "../src/runtime";
import { seal } from "../src/db";
import { resolver } from "../src/tools";

// Fake DNS: *.internal.test resolves to a private address, everything else to a public one.
resolver.lookup = async (h: string) => [{ address: /internal\.test$/.test(h) ? "10.0.0.5" : "93.184.216.34" }];

if (!process.env.KEEP_MODEL_KEYS) { delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.EXA_API_KEY; delete process.env.OPENROUTER_API_KEY; delete process.env.STRIPE_SECRET_KEY; delete process.env.JEV_API_KEY; delete process.env.CLERK_SECRET_KEY; }

// ---------- fake network ----------
type Handler = (req: Request, body: any) => Response | Promise<Response>;
export const net = {
  routes: [] as { re: RegExp; fn: Handler }[],
  calls: [] as { method: string; url: string; body: any; headers: Record<string, string> }[],
  on(re: RegExp, fn: Handler) { this.routes.unshift({ re, fn }); },
  to(re: RegExp) { return this.calls.filter((c) => re.test(c.url)); },
  reset() { this.routes = []; this.calls = []; },
};
const realFetch = globalThis.fetch;
const INTEGRATIONS = /googleapis\.com|slack\.com|telegram\.org|graph\.facebook\.com|photon\.test|twilio\.com|resend\.com|browserbase|stripe\.com|exa\.ai|\.test\//;
globalThis.fetch = (async (input: any, init?: any) => {
  const req = new Request(input, init);
  const text = init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === "string" ? init.body : "";
  let body: any = text; try { body = JSON.parse(text); } catch {}
  net.calls.push({ method: req.method, url: req.url, body, headers: Object.fromEntries(req.headers) });
  if (/api\.anthropic\.com|api\.openai\.com/.test(req.url) || (process.env.KEEP_MODEL_KEYS && /openrouter\.ai\/api|api\.typesafe\.ai/.test(req.url))) return realFetch(input, init); // real models (and JEV) pass through (evals)
  // Live evals: public web reads are real (search + page fetches); anything that writes or talks to an integration stays faked.
  if (process.env.EVAL_LIVE_WEB && (/duckduckgo\.com|api\.browserbase\.com\/v1\/search/.test(req.url) || (req.method === "GET" && !INTEGRATIONS.test(req.url)))) return realFetch(input, init);
  const r = net.routes.find((x) => x.re.test(req.url));
  if (r) return r.fn(req, body);
  return Response.json({ ok: true, id: id("ext"), result: { message_id: 1 }, messages: [{ id: "wamid.1" }], ts: "1.0" });
}) as any;
export { realFetch };

// Google API fakes used by most scenarios.
export function fakeGoogle() {
  net.on(/gmail\.googleapis\.com\/.*\/messages\/send/, () => Response.json({ id: id("gm") }));
  net.on(/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\?q=rfc822msgid/, () => Response.json({ resultSizeEstimate: 0 })); // reconcile: not in the mailbox
  net.on(/calendar\/v3\/calendars\/primary\/events\?/, () => Response.json({ items: [{ id: "ev1", summary: "Board meeting", start: { dateTime: "2026-10-02T15:00:00Z" } }] }));
  net.on(/calendar\/v3\/calendars\/primary\/events$/, (_r, b) => Response.json({ id: b.id, start: b.start, htmlLink: "https://cal/x" }));
  net.on(/people\.googleapis\.com/, (r) => Response.json({ results: /query=Sam/i.test(r.url) ? [{ person: { names: [{ displayName: "Sam Lee" }], emailAddresses: [{ value: "sam.lee@example.com" }] } }] : [] }));
  net.on(/duckduckgo/, () => new Response(`<a class="result__a" href="https://hotel.example/one">Hotel One</a><a class="result__snippet">Beachfront, $650</a>
    <a class="result__a" href="https://hotel.example/two">Hotel Two</a><a class="result__snippet">Near restaurants, $720</a>
    <a class="result__a" href="https://hotel.example/three">Hotel Three</a><a class="result__snippet">Quiet, $480</a>`));
}

// ---------- scripted model ----------
/** Script the model: each call gets the next response; a function receives the request. */
export function scriptModel(...steps: (Partial<ModelResult> | ((r: ModelRequest) => Partial<ModelResult>))[]) {
  const seen: ModelRequest[] = [];
  let i = 0;
  hooks.model = (req) => { seen.push(req); const s = steps[Math.min(i++, steps.length - 1)]; return typeof s === "function" ? s(req) : s; };
  return seen;
}
export const call = (name: string, input: any, cid = id("call")) => ({ toolCalls: [{ id: cid, name, input }] });

// ---------- world ----------
export function setup() {
  process.env.DEBOUNCE_MS = "0"; process.env.DDG_PACE_MS = "0"; process.env.EMAIL_RECONCILE_DELAY_MS = "0";
  openDb(":memory:"); resetClock(); hooks.model = null; net.reset(); fakeGoogle(); seedFirstParty();
}
export function user(name: string, email = `${name.toLowerCase()}@example.com`) {
  const uid = id("usr");
  exec("insert into users (id, email, name, created_at) values (?,?,?,?)", uid, email, name, now());
  return uid;
}
export function workspace(name: string, owner: string, members: [string, string?, string?][] = [], kind = "team") {
  const wid = id("ws");
  exec("insert into workspaces (id, name, kind, plan, created_at) values (?,?,?,?,?)", wid, name, kind, "team", now());
  exec("insert into memberships values (?,?,?,?)", wid, owner, "owner", null);
  for (const [u, role, title] of members) exec("insert into memberships values (?,?,?,?)", wid, u, role ?? "member", title ?? null);
  return wid;
}
export function setTitle(ws: string, u: string, title: string) { exec("update memberships set title=? where workspace_id=? and user_id=?", title, ws, u); }
export function installAgent(slug: string, ws: string, by: string) {
  const r = install(slug, ws, by);
  if ("error" in r) throw new Error(r.error);
  return r.agent;
}
export function customAgent(ws: string, by: string, skills: string[], perms: Record<string, string> = {}, name = "Tess") {
  return createAgent(ws, by, { name, job: "test agent", skills, permissions: perms });
}
export function googleConnection(ws: string, owner: string, agentIds: string[], visibility = "private", account?: string) {
  const cid = id("con");
  exec("insert into connections (id, workspace_id, owner_id, visibility, provider, label, account, cred_enc, created_at) values (?,?,?,?,?,?,?,?,?)",
    cid, ws, owner, visibility, "google", "Google", account ?? one<any>("select email from users where id=?", owner).email, seal({ access_token: "tok" }), now());
  for (const a of agentIds) exec("insert into connection_grants values (?,?)", cid, a);
  return cid;
}
export async function say(roomId: string, userId: string, text: string) {
  const r = await rt.ingestMessage({ roomId, senderId: userId, text, platform: "web" });
  await rt.drain();
  return r;
}
export const messages = (roomId: string) => all<any>("select * from events where room_id=? and type='message' order by seq", roomId).map((e) => ({ ...J(e.data), actor: e.actor, name: rt.nameOf(e.actor) }));
export const lastFrom = (roomId: string, actor: string) => messages(roomId).filter((m) => m.actor === actor).at(-1)?.text as string | undefined;
export const runsIn = (roomId: string) => all<any>("select * from runs where room_id=? order by created_at", roomId);
export const pendingApprovals = (roomId: string) => all<any>("select * from approvals where room_id=? and status='pending'", roomId);
export const events = (type: string) => all<any>("select * from events where type=? order by seq", type).map((e) => ({ ...e, data: J(e.data) }));

// ---------- channels + signed webhooks ----------
export const SECRETS = {
  telegram: { bot_token: "123:abc", webhook_secret: "tg-secret" },
  slack: { bot_token: "xoxb-1", signing_secret: "slack-secret" },
  whatsapp: { access_token: "wa-tok", app_secret: "wa-secret", verify_token: "wa-verify" },
  email: { resend_api_key: "re_1", webhook_secret: "whsec_" + Buffer.from("resend-secret").toString("base64") },
  imessage: { api_url: "https://photon.test", api_key: "ph", webhook_secret: "im-secret" },
  phone: { auth_token: "tw-secret" },
};
export function channel(agentId: string, platform: keyof typeof SECRETS, address = "", config: any = {}) {
  return addChannelIdentity(agentId, platform as any, address, SECRETS[platform], config);
}
const hm = (alg: string, k: string | Buffer, d: string, enc: "hex" | "base64" = "hex") => createHmac(alg, k).update(d).digest(enc);
export function signed(platform: keyof typeof SECRETS, cid: string, payload: any, opts: { badSig?: boolean; ts?: number; form?: boolean; url?: string } = {}) {
  const raw = opts.form ? new URLSearchParams(payload).toString() : typeof payload === "string" ? payload : JSON.stringify(payload);
  const ts = opts.ts ?? Math.floor(now() / 1000);
  const url = opts.url ?? `http://localhost/v1/webhooks/${platform}/${cid}`;
  const h: Record<string, string> = { "content-type": opts.form ? "application/x-www-form-urlencoded" : "application/json" };
  if (platform === "telegram") h["x-telegram-bot-api-secret-token"] = SECRETS.telegram.webhook_secret;
  if (platform === "slack") { h["x-slack-request-timestamp"] = String(ts); h["x-slack-signature"] = `v0=${hm("sha256", SECRETS.slack.signing_secret, `v0:${ts}:${raw}`)}`; }
  if (platform === "whatsapp") h["x-hub-signature-256"] = `sha256=${hm("sha256", SECRETS.whatsapp.app_secret, raw)}`;
  if (platform === "email") { h["svix-id"] = "msg_1"; h["svix-timestamp"] = String(ts); h["svix-signature"] = `v1,${hm("sha256", Buffer.from("resend-secret"), `msg_1.${ts}.${raw}`, "base64")}`; }
  if (platform === "imessage") { h["x-timestamp"] = String(ts); h["x-signature"] = hm("sha256", SECRETS.imessage.webhook_secret, `${ts}.${raw}`); }
  if (platform === "phone") { const p = new URLSearchParams(raw); h["x-twilio-signature"] = hm("sha1", SECRETS.phone.auth_token, url + [...p.keys()].sort().map((k) => k + p.get(k)).join(""), "base64"); }
  if (opts.badSig) for (const k of Object.keys(h)) if (/sig|token|secret/.test(k)) h[k] = "v0=bad";
  return new Request(url, { method: "POST", headers: h, body: raw });
}
/** Deliver a webhook and run the worker to quiescence. */
export async function deliver(platform: keyof typeof SECRETS, cid: string, payload: any, opts = {}) {
  const res = await handleWebhook(platform, cid, signed(platform, cid, payload, opts));
  await rt.drain();
  return res;
}
let seq = 1;
export const tg = (chatId: number, fromId: number, first: string, text: string, group = false) =>
  ({ update_id: seq++, message: { message_id: seq, chat: { id: chatId, type: group ? "group" : "private" }, from: { id: fromId, first_name: first }, text } });
export const slackMsg = (channelId: string, userId: string, text: string) =>
  ({ type: "event_callback", event_id: `Ev${seq++}`, event: { type: "message", channel: channelId, user: userId, text, ts: `${seq}.000`, channel_type: "channel" } });
export const imsg = (chatId: string, handle: string, name: string, text: string, group = false) =>
  ({ id: `im${seq++}`, chat_id: chatId, is_group: group, sender: { handle, name }, text });
export const inboundEmail = (from: string, subject: string, text: string) =>
  ({ type: "email.received", data: { email_id: `em${seq++}`, from, to: ["agent@agents.test"], subject, text } });
export function link(platform: string, externalId: string, userId: string) {
  exec("insert or replace into external_identities (platform, external_user_id, user_id, verified) values (?,?,?,1)", platform, externalId, userId);
}
