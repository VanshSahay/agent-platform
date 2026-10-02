// Channel layer (plan §5, §6, §20). External chats are interfaces into a Room, never the source of truth.
// Webhook -> verify -> dedupe -> persist -> 200. A worker later normalizes, resolves identities/rooms and signals the runtime.
import { createHmac, timingSafeEqual, randomInt } from "node:crypto";
import { all, one, exec, id, now, S, J, seal, unseal, emit } from "./db";
import * as rt from "./runtime";
import * as intake from "./intake";
import * as tpl from "./templates";

export type Platform = "web" | "telegram" | "slack" | "whatsapp" | "email" | "imessage" | "phone";
export interface InboundEvent {
  provider: Platform; providerEventId: string; conversationId: string; isGroup: boolean;
  senderId: string; senderName?: string; type: "message" | "button_clicked" | "email_received";
  text: string; data?: string; subject?: string;
}
interface Outbound { text: string; agentName?: string; buttons?: { label: string; data: string }[] }
interface Adapter {
  verify(raw: string, h: Headers, secret: any, url: string): boolean;
  parse(raw: string, ident: any): InboundEvent[];
  send(ident: any, secret: any, ep: any, msg: Outbound, idemKey: string): Promise<string | undefined>;
}

const hmac = (alg: string, key: string | Buffer, data: string, enc: "hex" | "base64" = "hex") => createHmac(alg, key).update(data).digest(enc);
const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const fresh = (tsSec: number) => Math.abs(now() / 1000 - tsSec) < 300; // replay window
const buttons = (m: Outbound) => m.buttons ?? [];
async function post(url: string, body: any, headers: Record<string, string> = {}) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: S(body) });
  if (!r.ok) throw new Error(`${url.split("?")[0]} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json().catch(() => ({}));
}

export const ADAPTERS: Record<string, Adapter> = {
  telegram: {
    verify: (_r, h, s) => !!s.webhook_secret && safeEq(h.get("x-telegram-bot-api-secret-token") ?? "", s.webhook_secret),
    parse(raw, ident) {
      const u = JSON.parse(raw), cfg = J(ident.config, {});
      if (u.callback_query) {
        const q = u.callback_query;
        return [{ provider: "telegram", providerEventId: `cb:${q.id}`, conversationId: String(q.message.chat.id), isGroup: q.message.chat.type !== "private",
          senderId: String(q.from.id), senderName: q.from.first_name, type: "button_clicked", text: "", data: q.data }];
      }
      const m = u.message ?? u.edited_message;
      if (!m?.text || m.from?.is_bot) return [];
      const text = cfg.username ? m.text.replace(new RegExp(`@${cfg.username}\\b`, "gi"), `@${ident.agent_name}`) : m.text;
      return [{ provider: "telegram", providerEventId: String(u.update_id), conversationId: String(m.chat.id), isGroup: m.chat.type !== "private",
        senderId: String(m.from.id), senderName: [m.from.first_name, m.from.last_name].filter(Boolean).join(" "), type: "message", text }];
    },
    async send(_i, s, ep, m) {
      const b = buttons(m);
      const r: any = await post(`https://api.telegram.org/bot${s.bot_token}/sendMessage`, { chat_id: ep.external_conversation_id, text: m.text,
        reply_markup: b.length ? { inline_keyboard: [b.map((x) => ({ text: x.label, callback_data: x.data }))] } : undefined });
      return String(r.result?.message_id ?? "");
    },
  },

  slack: {
    verify(raw, h, s) {
      const ts = Number(h.get("x-slack-request-timestamp"));
      return !!s.signing_secret && fresh(ts) && safeEq(h.get("x-slack-signature") ?? "", `v0=${hmac("sha256", s.signing_secret, `v0:${ts}:${raw}`)}`);
    },
    parse(raw, ident) {
      const cfg = J(ident.config, {});
      if (raw.startsWith("payload=")) { // Block Kit interactivity (approval buttons)
        const p = JSON.parse(new URLSearchParams(raw).get("payload")!);
        const a = p.actions?.[0];
        return a ? [{ provider: "slack", providerEventId: `act:${p.trigger_id ?? a.action_ts}`, conversationId: p.channel?.id ?? p.container?.channel_id,
          isGroup: true, senderId: p.user.id, senderName: p.user.name, type: "button_clicked", text: "", data: a.value }] : [];
      }
      const b = JSON.parse(raw), e = b.event;
      if (b.type !== "event_callback" || !e || e.bot_id || e.subtype || !["message", "app_mention"].includes(e.type)) return [];
      const text = cfg.bot_user_id ? e.text.replaceAll(`<@${cfg.bot_user_id}>`, `@${ident.agent_name}`) : e.text;
      // message + app_mention both fire for one post: dedupe on channel+ts.
      return [{ provider: "slack", providerEventId: `${e.channel}:${e.ts}`, conversationId: e.channel, isGroup: e.channel_type !== "im",
        senderId: e.user, senderName: e.user_profile?.real_name, type: "message", text }];
    },
    async send(_i, s, ep, m) {
      const b = buttons(m);
      const blocks = b.length ? [{ type: "section", text: { type: "mrkdwn", text: m.text } },
        { type: "actions", elements: b.map((x, i) => ({ type: "button", text: { type: "plain_text", text: x.label }, value: x.data, action_id: `apr_${i}`, style: i ? "danger" : "primary" })) }] : undefined;
      const r: any = await post("https://slack.com/api/chat.postMessage", { channel: ep.external_conversation_id, text: m.text, blocks }, { authorization: `Bearer ${s.bot_token}` });
      if (r.ok === false) throw new Error(`slack: ${r.error}`);
      return r.ts;
    },
  },

  whatsapp: {
    verify: (raw, h, s) => !!s.app_secret && safeEq(h.get("x-hub-signature-256") ?? "", `sha256=${hmac("sha256", s.app_secret, raw)}`),
    parse(raw) {
      const out: InboundEvent[] = [];
      for (const en of JSON.parse(raw).entry ?? []) for (const ch of en.changes ?? []) {
        const v = ch.value ?? {};
        for (const m of v.messages ?? []) {
          const name = v.contacts?.find((c: any) => c.wa_id === m.from)?.profile?.name;
          const base = { provider: "whatsapp" as const, providerEventId: m.id, conversationId: m.group_id ?? m.from, isGroup: !!m.group_id, senderId: m.from, senderName: name };
          if (m.type === "text") out.push({ ...base, type: "message", text: m.text.body });
          else if (m.type === "interactive" && m.interactive?.button_reply) out.push({ ...base, type: "button_clicked", text: "", data: m.interactive.button_reply.id });
        }
      }
      return out;
    },
    async send(i, s, ep, m) {
      const cfg = J(i.config, {}), b = buttons(m);
      const to = ep.is_group ? { recipient_type: "group", to: ep.external_conversation_id } : { to: ep.external_conversation_id };
      const body = b.length
        ? { messaging_product: "whatsapp", ...to, type: "interactive", interactive: { type: "button", body: { text: m.text.slice(0, 1024) }, action: { buttons: b.map((x) => ({ type: "reply", reply: { id: x.data, title: x.label } })) } } }
        : { messaging_product: "whatsapp", ...to, type: "text", text: { body: m.text } };
      const r: any = await post(`https://graph.facebook.com/v21.0/${cfg.phone_number_id}/messages`, body, { authorization: `Bearer ${s.access_token}` });
      return r.messages?.[0]?.id;
    },
  },

  email: { // agent-owned mailbox via Resend (inbound webhooks are Svix-signed)
    verify(raw, h, s) {
      const sid = h.get("svix-id") ?? "", ts = Number(h.get("svix-timestamp")), sig = h.get("svix-signature") ?? "";
      if (!s.webhook_secret || !fresh(ts)) return false;
      const expected = hmac("sha256", Buffer.from(s.webhook_secret.replace(/^whsec_/, ""), "base64"), `${sid}.${ts}.${raw}`, "base64");
      return sig.split(" ").some((p) => safeEq(p.split(",")[1] ?? "", expected));
    },
    parse(raw) {
      const e = JSON.parse(raw);
      if (e.type !== "email.received") return [];
      const d = e.data, from = (d.from.match(/<([^>]+)>/)?.[1] ?? d.from).toLowerCase();
      const body = String(d.text ?? (d.html ?? "").replace(/<[^>]+>/g, " ")).split(/\nOn .+wrote:\n|\n>/)[0].trim();
      return [{ provider: "email", providerEventId: d.email_id ?? d.id, conversationId: from, isGroup: false, senderId: from,
        senderName: d.from.replace(/<.*>/, "").trim() || from, type: "email_received", text: body || d.subject, subject: d.subject }];
    },
    async send(i, s, ep, m, idem) {
      const cfg = J(ep.config, {});
      const r: any = await post("https://api.resend.com/emails", { from: `${m.agentName} <${i.address}>`, to: [ep.external_conversation_id],
        subject: cfg.subject ? `Re: ${cfg.subject.replace(/^re:\s*/i, "")}` : `Message from ${m.agentName}`,
        text: m.buttons?.length ? `${m.text}\n\nReply with: ${m.buttons.map((b) => b.label.toLowerCase()).join(" / ")}` : m.text }, { authorization: `Bearer ${s.resend_api_key}`, "idempotency-key": idem });
      return r.id;
    },
  },

  imessage: {
    // ponytail: generic signed-webhook bridge for Photon (spectrum-ts runs as a sidecar and POSTs here / exposes POST /messages).
    // Swap parse/send for spectrum-ts's provider interface when wiring the real line.
    verify(raw, h, s) {
      const ts = Number(h.get("x-timestamp"));
      return !!s.webhook_secret && fresh(ts) && safeEq(h.get("x-signature") ?? "", hmac("sha256", s.webhook_secret, `${ts}.${raw}`));
    },
    parse(raw) {
      const m = JSON.parse(raw);
      if (!m.text || m.from_me) return [];
      return [{ provider: "imessage", providerEventId: m.id, conversationId: m.chat_id, isGroup: !!m.is_group, senderId: m.sender.handle, senderName: m.sender.name, type: "message", text: m.text }];
    },
    async send(_i, s, ep, m) {
      // iMessage has no buttons; text replies ("approve", "go") are parsed
      const r: any = await post(`${s.api_url}/messages`, { chat_id: ep.external_conversation_id, text: m.text }, { authorization: `Bearer ${s.api_key}` });
      return r.id;
    },
  },

  phone: { // Twilio voice; turns are handled synchronously in handlePhone()
    verify(raw, h, s, url) {
      const p = new URLSearchParams(raw);
      const data = url + [...p.keys()].sort().map((k) => k + p.get(k)).join("");
      return !!s.auth_token && safeEq(h.get("x-twilio-signature") ?? "", hmac("sha1", s.auth_token, data, "base64"));
    },
    parse: () => [],
    send: async () => undefined, // replies are spoken inline
  },
};

// ---------------- channel identities ----------------
export function addChannelIdentity(agentId: string, platform: Platform, address: string, secret: any, config: any = {}) {
  const cid = id("chi");
  exec("insert into channel_identities (id, agent_id, platform, address, secret_enc, config, created_at) values (?,?,?,?,?,?,?)",
    cid, agentId, platform, address, seal(secret ?? {}), S(config), now());
  return one<any>("select id, agent_id, platform, address, config from channel_identities where id=?", cid);
}
const identity = (cid: string) => one<any>("select ci.*, a.name agent_name from channel_identities ci join agents a on a.id=ci.agent_id where ci.id=?", cid);

// ---------------- inbound ----------------
export async function handleWebhook(platform: string, cid: string, req: Request): Promise<Response> {
  const ident = identity(cid);
  if (!ident || ident.platform !== platform) return new Response("unknown channel", { status: 404 });
  const secret = unseal(ident.secret_enc) ?? {};
  const url = new URL(req.url);
  if (req.method === "GET" && platform === "whatsapp") // Meta subscription handshake
    return url.searchParams.get("hub.verify_token") === secret.verify_token ? new Response(url.searchParams.get("hub.challenge")) : new Response("forbidden", { status: 403 });
  const raw = await req.text();
  const publicUrl = J(ident.config, {}).public_url ?? req.url;
  if (!ADAPTERS[platform]?.verify(raw, req.headers, secret, publicUrl)) {
    emit("WEBHOOK_REJECTED", { data: { platform, channel_identity_id: cid } });
    return new Response("bad signature", { status: 401 });
  }
  if (platform === "slack" && raw.startsWith("{") && JSON.parse(raw).type === "url_verification") return Response.json({ challenge: JSON.parse(raw).challenge });
  if (platform === "phone") return handlePhone(ident, raw, publicUrl);
  for (const e of ADAPTERS[platform].parse(raw, ident)) {
    // Dedupe by provider event id; ingestion is separate from processing (plan §21.6).
    exec("insert or ignore into inbound_events (id, provider, provider_event_id, channel_identity_id, raw, received_at) values (?,?,?,?,?,?)",
      id("inb"), platform, e.providerEventId, cid, S(e), now());
  }
  return new Response("ok");
}

export async function processInbound() {
  let n = 0;
  for (const row of all<any>("select * from inbound_events where status='queued' order by received_at limit 100")) {
    try { await processEvent(J(row.raw), identity(row.channel_identity_id)); exec("update inbound_events set status='processed' where id=?", row.id); }
    catch (e: any) { exec("update inbound_events set status='error', error=? where id=?", e.message, row.id); console.error("[inbound]", e); }
    n++;
  }
  return n;
}

/** external sender -> principal. Unknown senders become guests; linking is explicit and verified (plan §20.2). */
export function resolveSender(platform: string, externalId: string, displayName?: string) {
  const x = one<any>("select * from external_identities where platform=? and external_user_id=?", platform, externalId);
  if (x) return x.user_id as string;
  const uid = id("usr");
  exec("insert into users (id, name, guest, created_at) values (?,?,1,?)", uid, displayName || `${platform} ${externalId.slice(-4)}`, now());
  exec("insert into external_identities (platform, external_user_id, user_id, verified, display_name) values (?,?,?,0,?)", platform, externalId, uid, displayName ?? null);
  return uid;
}

/** external conversation -> Room. A linked user's DM lands in their private Room with the agent, whatever the channel. */
export function resolveRoom(e: InboundEvent, ident: any, senderId: string) {
  const ep = one<any>("select * from room_endpoints where platform=? and channel_identity_id=? and external_conversation_id=?", e.provider, ident.id, e.conversationId);
  if (ep) return ep;
  const agent = one<any>("select * from agents where id=?", ident.agent_id);
  const room = e.isGroup
    ? rt.createRoom({ workspace_id: agent.workspace_id, name: `${e.provider[0].toUpperCase() + e.provider.slice(1)} group`, kind: "shared", participation: "mention_only",
        members: [{ id: agent.id, kind: "agent" }] })
    : rt.privateRoomFor(senderId, agent);
  return attachEndpoint(room.id, e.provider, e.conversationId, ident.id, e.isGroup);
}
export function attachEndpoint(roomId: string, platform: string, conversationId: string, cid: string | null, isGroup = false) {
  const eid = id("rep");
  exec("insert into room_endpoints (id, room_id, platform, external_conversation_id, channel_identity_id, is_group, last_active_at) values (?,?,?,?,?,?,?)",
    eid, roomId, platform, conversationId, cid, isGroup ? 1 : 0, now());
  emit("ENDPOINT_LINKED", { room_id: roomId, data: { platform, conversation: conversationId } });
  return one<any>("select * from room_endpoints where id=?", eid);
}

const isMember = (ws: string, u: string) => !!one("select 1 from memberships where workspace_id=? and user_id=?", ws, u);

async function processEvent(e: InboundEvent, ident: any) {
  if (!ident) return;
  const agent = one<any>("select * from agents where id=?", ident.agent_id);
  const senderId = resolveSender(e.provider, e.senderId, e.senderName);
  const reply = async (text: string) => { const ep = resolveRoom(e, ident, resolveSender(e.provider, e.senderId)); await ADAPTERS[e.provider].send(ident, unseal(ident.secret_enc), ep, { text, agentName: agent.name }, id("idem")); };

  const link = e.text.trim().match(/^link (\d+)$/i);
  if (link) {
    // Brute-force guard: 5 misses per sender per hour.
    const misses = one<any>("select count(*) n from events where type='LINK_FAILED' and json_extract(data, '$.sender')=? and ts>?", `${e.provider}:${e.senderId}`, now() - 36e5).n;
    if (misses >= 5) return reply("Too many attempts. Try again in an hour.");
    if (linkIdentity(e.provider, e.senderId, link[1], ident)) return reply(`Linked. I'll recognize you here from now on.`);
    emit("LINK_FAILED", { data: { sender: `${e.provider}:${e.senderId}` } });
    return reply(`That code is invalid or expired.`);
  }

  if (e.type === "button_clicked") {
    const ep = resolveRoom(e, ident, senderId);
    const r = await pressButton(e.data ?? "", senderId, ep.room_id, ep.id);
    if ("error" in r) return reply(r.error!);
    if (r.say) return reply(r.say);
    return;
  }

  if (e.type === "email_received") {
    // EVENT wake condition: a run waiting on a reply from this address resumes (plan §33).
    if (rt.signalEvent(`email:${e.senderId}`, `Email from ${e.senderName} <${e.senderId}> — ${e.subject ?? ""}\n<untrusted origin="EMAIL">${e.text}</untrusted>`)) return;
  }

  const ep = resolveRoom(e, ident, senderId);
  if (e.subject) exec("update room_endpoints set config=json_set(config, '$.subject', ?) where id=?", e.subject, ep.id);
  const room = one<any>("select * from rooms where id=?", ep.room_id);
  await rt.ingestMessage({ roomId: ep.room_id, senderId, text: e.text, platform: e.provider, endpointId: ep.id, externalId: e.providerEventId,
    untrusted: !isMember(room.workspace_id, senderId) }); // external contacts are untrusted (plan §21.1)
}

/** Every card button (web or channel) lands here; a button only acts on objects in the room it was pressed in. */
export async function pressButton(data: string, userId: string, roomId: string, endpointId: string | null): Promise<{ ok?: boolean; error?: string; say?: string }> {
  const [kind, objId, action] = data.split(":");
  const roomOf = (sql: string) => one<any>(sql, objId)?.room_id;
  if (kind === "apr") {
    if (roomOf("select room_id from approvals where id=?") !== roomId) return { error: "that approval isn't in this conversation" };
    return rt.decideApproval(objId, userId, action === "approve" ? "approve" : "reject", {}, endpointId);
  }
  if (roomOf("select room_id from runs where id=?") !== roomId) return { error: "that task isn't in this conversation" };
  if (kind === "brf") return action === "go" ? intake.confirmBrief(objId, userId, endpointId) : action === "cancel" ? intake.cancelBrief(objId, userId) : { error: "unknown action" };
  if (kind === "skl") {
    if (action !== "save") return { ok: true };
    const r = await tpl.saveSkillFromRun(objId, userId);
    if ("error" in r) return r;
    const s = (r as any).skill;
    rt.postMessage(roomId, { sender: s.agent_id, text: `Saved skill "${s.name}". I'll follow it for similar requests.`, targets: endpointId ? [endpointId] : [] });
    return { ok: true };
  }
  return { error: "unknown button" };
}

// ---------------- identity linking ----------------
export function createLinkCode(userId: string) {
  const code = String(randomInt(10_000_000, 99_999_999));
  exec("insert into link_codes values (?,?,?)", code, userId, now() + 10 * 6e4);
  return code;
}
export function linkIdentity(platform: string, externalId: string, code: string, ident?: any) {
  const c = one<any>("select * from link_codes where code=? and expires_at>?", code, now());
  if (!c) return false;
  exec("delete from link_codes where code=?", code);
  const old = one<any>("select * from external_identities where platform=? and external_user_id=?", platform, externalId);
  exec("insert or replace into external_identities (platform, external_user_id, user_id, verified, display_name) values (?,?,?,1,?)", platform, externalId, c.user_id, old?.display_name ?? null);
  if (old && old.user_id !== c.user_id) {
    // Fold the guest into the real user: DM endpoints re-point to the user's own private Room; group memberships move over.
    if (ident) {
      const agent = one<any>("select * from agents where id=?", ident.agent_id);
      const target = rt.privateRoomFor(c.user_id, agent); // resolved before folding, so it's the user's own room
      for (const ep of all<any>(`select re.* from room_endpoints re join rooms r on r.id=re.room_id join room_members m on m.room_id=r.id
          where re.channel_identity_id=? and re.is_group=0 and r.kind='private' and m.principal_id=?`, ident.id, old.user_id)) {
        exec("update room_endpoints set room_id=? where id=?", target.id, ep.id);
        exec("update rooms set status='merged' where id=?", ep.room_id);
      }
    }
    for (const m of all<any>("select * from room_members where principal_id=?", old.user_id)) {
      exec("insert or ignore into room_members (room_id, principal_id, kind, role) values (?,?,?,?)", m.room_id, c.user_id, "human", null);
      exec("delete from room_members where room_id=? and principal_id=?", m.room_id, old.user_id);
    }
  }
  emit("IDENTITY_LINKED", { actor: c.user_id, data: { platform, external_user_id: externalId } });
  return true;
}

// ---------------- outbound ----------------
export function enqueue(endpointId: string, roomId: string, eventId: string, payload: Outbound) {
  exec("insert into outbox (id, endpoint_id, room_id, event_id, payload, created_at) values (?,?,?,?,?,?)", id("out"), endpointId, roomId, eventId, S(payload), now());
}
export async function flushOutbox() {
  let n = 0;
  for (const o of all<any>("select * from outbox where status='queued' and attempts<5 order by created_at limit 100")) {
    const ep = one<any>("select * from room_endpoints where id=?", o.endpoint_id);
    const ident = ep?.channel_identity_id ? identity(ep.channel_identity_id) : null;
    if (!ep || !ident || !ADAPTERS[ep.platform]) { exec("update outbox set status='skipped' where id=?", o.id); continue; }
    try {
      const ext = await ADAPTERS[ep.platform].send(ident, unseal(ident.secret_enc), ep, J(o.payload), o.id);
      exec("update outbox set status='sent', external_id=?, attempts=attempts+1 where id=?", ext ?? null, o.id);
      exec("update events set data=json_set(data, '$.delivery', json_array(json_object('platform', ?, 'external_id', ?))) where id=?", ep.platform, ext ?? null, o.event_id);
    } catch (e: any) {
      exec("update outbox set attempts=attempts+1, error=?, status=case when attempts+1>=5 then 'failed' else 'queued' end where id=?", e.message, o.id);
    }
    n++;
  }
  return n;
}

// ---------------- phone (Twilio <Gather> speech loop) ----------------
// ponytail: turn-based speech via TwiML; swap for LiveKit Agents + Twilio Media Streams when latency/barge-in matter.
const xml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const twiml = (say: string, url: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" action="${xml(url)}" speechTimeout="auto"><Say>${xml(say)}</Say></Gather></Response>`, { headers: { "content-type": "text/xml" } });
async function handlePhone(ident: any, raw: string, url: string) {
  const p = new URLSearchParams(raw), from = p.get("From") ?? "unknown", speech = p.get("SpeechResult");
  if (!speech) return twiml(`Hi, this is ${ident.agent_name}. How can I help?`, url);
  const e: InboundEvent = { provider: "phone", providerEventId: `${p.get("CallSid")}:${speech}`, conversationId: from, isGroup: false, senderId: from, type: "message", text: speech };
  const senderId = resolveSender("phone", from);
  const ep = resolveRoom(e, ident, senderId);
  const { eventId, started } = await rt.ingestMessage({ roomId: ep.room_id, senderId, text: speech, platform: "phone", endpointId: ep.id });
  for (let i = 0; i < 6 && started.some((r) => one<any>("select status from runs where id=?", r)?.status === "queued"); i++) await rt.tick();
  const seq = one<any>("select seq from events where id=?", eventId).seq;
  const said = all<any>("select data from events where room_id=? and type='message' and actor=? and seq>? order by seq", ep.room_id, ident.agent_id, seq).map((x) => J(x.data).text);
  exec("insert into usage (workspace_id, agent_id, kind, qty, ts) select workspace_id, ?, 'voice_turns', 1, ? from rooms where id=?", ident.agent_id, now(), ep.room_id);
  return twiml(said.join(" ") || "I'm working on it and will follow up by message.", url);
}
