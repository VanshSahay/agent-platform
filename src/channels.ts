// Channel layer (plan §5, §6, §20). External chats are interfaces into a Room, never the source of truth.
// Webhook -> verify -> dedupe -> persist -> 200. A worker later normalizes, resolves identities/rooms and signals the runtime.
import { createHmac, timingSafeEqual, randomInt, randomBytes } from "node:crypto";
import { all, one, exec, id, now, S, J, seal, unseal, emit, recordUsage, patchJson, tx } from "./db";
import * as rt from "./runtime";
import * as intake from "./intake";
import * as tpl from "./templates";
import { photonEnabled, photonSend, photonTyping } from "./photon";
import * as media from "./media";

export type Platform = "web" | "telegram" | "slack" | "whatsapp" | "email" | "imessage" | "phone";
export interface InboundEvent {
  provider: Platform; providerEventId: string; conversationId: string; isGroup: boolean;
  senderId: string; senderName?: string; type: "message" | "button_clicked" | "email_received" | "email_undeliverable";
  text: string; data?: string; subject?: string; to?: string[]; emailId?: string;
  attachments?: string[];                          // stored file ids (photos, voice notes, files)
  reaction?: { emoji: string; targetId: string };  // tapback on one of our messages
}
interface Outbound { text: string; agentName?: string; agentAlias?: string; buttons?: { label: string; data: string }[] }
interface Adapter {
  verify(raw: string, h: Headers, secret: any, url: string): boolean;
  parse(raw: string, ident: any): InboundEvent[];
  send(ident: any, secret: any, ep: any, msg: Outbound, idemKey: string): Promise<string | undefined>;
  typing?(ident: any, secret: any, ep: any): Promise<void>;
}

// ---------------- outbound text shaping ----------------
// Models write markdown; chat apps don't render it. iMessage/SMS get plain text, WhatsApp its own *bold*, Slack mrkdwn.
const PLAIN = ["imessage", "whatsapp", "telegram", "phone"];
export function formatFor(platform: string, t: string) {
  if (platform === "slack") return t.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>").replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
  if (!PLAIN.includes(platform)) return t; // web renders markdown; email has its own formatting
  const bold = platform === "whatsapp" ? "*$1*" : "$1";
  return t
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, "$1")
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, "")                 // table separator rows
    .replace(/^\s*\|(.+)\|\s*$/gm, (_, row) => row.split("|").map((c: string) => c.trim()).filter(Boolean).join(" · ")) // table rows
    .replace(/^#{1,6}\s+(.+)$/gm, bold)
    .replace(/\*\*(.+?)\*\*/g, bold).replace(/__(.+?)__/g, "$1").replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[?\[([^\]]+)\]\((https?:[^)\s]+)\)\]?/g, (_, label, url) => (/^(source|link|here|\d+)$/i.test(label.trim()) || url.toLowerCase().includes(label.trim().toLowerCase().replace(/^www\./, "")) ? url : `${label} (${url})`))
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n").trim();
}
/** Long replies become several normal-sized texts, split at paragraph, then line, then sentence boundaries. */
export function splitMessage(t: string, max: number) {
  if (t.length <= max) return [t];
  const out: string[] = [];
  let cur = "";
  const pieces = t.split(/(\n\n)/).flatMap((p) => (p.length > max ? p.split(/(?<=\n)|(?<=[.!?] )/) : [p]));
  for (const piece of pieces) {
    if ((cur + piece).length > max && cur.trim()) { out.push(cur.trim()); cur = ""; }
    for (let x = piece; x.length; x = x.slice(max)) { if (x.length > max) out.push(x.slice(0, max)); else { cur += x; break; } } // a single run-on chunk: hard cut
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const SPLIT_AT: Record<string, number> = { imessage: 900, whatsapp: 1200, telegram: 1500, phone: 900 };
/** A shared line keeps one route per (conversation, agent); extra agents in the same 1:1 thread use `conv~agentId`. */
const baseConv = (c: string) => c.replace(/~agt_[\w-]+$/, "");

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
    async typing(_i, s, ep) { await post(`https://api.telegram.org/bot${s.bot_token}/sendChatAction`, { chat_id: ep.external_conversation_id, action: "typing" }); },
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
      const text = cfg.bot_user_id && ident.agent_name ? e.text.replaceAll(`<@${cfg.bot_user_id}>`, `@${ident.agent_name}`) : e.text;
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
      const e = JSON.parse(raw), d = e.data ?? {};
      const addrs = (xs: any) => [].concat(xs ?? []).map((x: string) => (x.match(/<([^>]+)>/)?.[1] ?? x).toLowerCase());
      // Bounces/complaints: stop writing to that address instead of retrying into a wall.
      if (e.type === "email.bounced" || e.type === "email.complained")
        return [{ provider: "email", providerEventId: `${d.email_id ?? d.id}:${e.type}`, conversationId: "", isGroup: false, senderId: "", type: "email_undeliverable", text: e.type, to: addrs(d.to) }];
      if (e.type !== "email.received") return [];
      const from = (d.from.match(/<([^>]+)>/)?.[1] ?? d.from).toLowerCase();
      const body = emailText(d.text, d.html);
      return [{ provider: "email", providerEventId: d.email_id ?? d.id, conversationId: from, isGroup: false, senderId: from,
        senderName: d.from.replace(/<.*>/, "").trim() || from, type: "email_received", text: body || d.subject, subject: d.subject, to: addrs(d.to),
        ...(d.text == null && d.html == null ? { emailId: d.email_id ?? d.id } : {}) }]; // webhook carried metadata only: fetch the body before processing
    },
    async send(i, s, ep, m, idem) {
      const cfg = J(ep.config, {});
      const from = i.agent_id ? i.address : `${(m as any).agentAlias ?? "agent"}@${i.address}`;
      // Tokenised Reply-To: a reply finds this exact conversation even if it's forwarded or sent from another address.
      let token = ep.reply_token;
      if (!token && ep.id) { token = randomBytes(10).toString("hex"); exec("update room_endpoints set reply_token=? where id=?", token, ep.id); }
      const [local, domain] = from.split("@");
      const r: any = await post("https://api.resend.com/emails", { from: `${m.agentName} <${from}>`, to: [String(ep.external_conversation_id).split("|")[0]],
        ...(token ? { reply_to: [`${local}+r_${token}@${domain}`] } : {}),
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
      if (m.from_me) return [];
      // Bridge payload: text, and optionally attachments [{name, mime_type, data_base64}] or a tapback {emoji, target_id}.
      const attachments = (m.attachments ?? []).filter((a: any) => a?.data_base64).map((a: any) => media.storeMedia({ kind: "file", name: a.name ?? "attachment", mime: a.mime_type ?? "application/octet-stream", data: new Uint8Array(Buffer.from(a.data_base64, "base64")) }));
      const reaction = m.reaction?.target_id ? { emoji: String(m.reaction.emoji ?? ""), targetId: String(m.reaction.target_id) } : undefined;
      if (!m.text && !attachments.length && !reaction) return [];
      return [{ provider: "imessage", providerEventId: m.id, conversationId: m.chat_id, isGroup: !!m.is_group, senderId: m.sender.handle, senderName: m.sender.name,
        type: "message", text: m.text ?? "", ...(attachments.length ? { attachments } : {}), ...(reaction ? { reaction } : {}) }];
    },
    async send(i, s, ep, m) {
      // iMessage has no buttons: the text says how to answer, and a 👍/👎 tapback on the message works too (see processEvent).
      const b = buttons(m);
      const text = b.length >= 2 ? `${m.text}\n(👍 or "${b[0].label.toLowerCase()}" · 👎 or "${b[1].label.toLowerCase()}")` : m.text;
      if (!i.agent_id && photonEnabled()) return photonSend(ep.external_conversation_id, text);
      const r: any = await post(`${s.api_url}/messages`, { chat_id: ep.external_conversation_id, text }, { authorization: `Bearer ${s.api_key}` });
      return r.id;
    },
    async typing(i, s, ep) {
      if (!i.agent_id && photonEnabled()) return photonTyping(ep.external_conversation_id);
      await post(`${s.api_url}/typing`, { chat_id: ep.external_conversation_id }, { authorization: `Bearer ${s.api_key}` }).catch(() => {}); // optional on bridges
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

/** Plain text of an email: prefer text, else strip HTML (HTML-only replies must not come out empty), drop the quoted history. */
export function emailText(text?: string | null, html?: string | null) {
  const t = text ?? (html ?? "").replace(/<blockquote[\s\S]*?<\/blockquote>|<div class="gmail_quote"[\s\S]*$/gi, "").replace(/<(br|\/p|\/div)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return String(t).split(/\nOn .+wrote:\n|\n>/)[0].replace(/[ \t]+/g, " ").trim();
}

// ---------------- channel identities ----------------
export function addChannelIdentity(agentId: string, platform: Platform, address: string, secret: any, config: any = {}) {
  const cid = id("chi");
  exec("insert into channel_identities (id, agent_id, platform, address, secret_enc, config, created_at) values (?,?,?,?,?,?,?)",
    cid, agentId, platform, address, seal(secret ?? {}), S(config), now());
  return one<any>("select id, agent_id, platform, address, config from channel_identities where id=?", cid);
}
const identity = (cid: string) => one<any>("select ci.*, a.name agent_name from channel_identities ci left join agents a on a.id=ci.agent_id where ci.id=?", cid);

// ---------------- platform-owned shared lines (one-click deploy) ----------------
// One iMessage line / WhatsApp number / Telegram bot / email domain serves every agent. A conversation is bound to an
// agent by a deploy code ("start 12345678") sent from the user's phone; groups are bound the same way ("join 12345678").
export const SHARED_ENV: Record<string, { id: string; address: () => string | undefined; secret: () => any; config: () => any }> = {
  imessage: { id: "chi_shared_imessage", address: () => process.env.SHARED_IMESSAGE_LINE,
    secret: () => ({ api_url: process.env.SHARED_IMESSAGE_API_URL, api_key: process.env.SHARED_IMESSAGE_API_KEY, webhook_secret: process.env.SHARED_IMESSAGE_WEBHOOK_SECRET }), config: () => ({}) },
  whatsapp: { id: "chi_shared_whatsapp", address: () => process.env.SHARED_WHATSAPP_NUMBER,
    secret: () => ({ access_token: process.env.SHARED_WHATSAPP_ACCESS_TOKEN, app_secret: process.env.SHARED_WHATSAPP_APP_SECRET, verify_token: process.env.SHARED_WHATSAPP_VERIFY_TOKEN }),
    config: () => ({ phone_number_id: process.env.SHARED_WHATSAPP_PHONE_NUMBER_ID }) },
  telegram: { id: "chi_shared_telegram", address: () => process.env.SHARED_TELEGRAM_BOT_USERNAME,
    secret: () => ({ bot_token: process.env.SHARED_TELEGRAM_BOT_TOKEN, webhook_secret: process.env.SHARED_TELEGRAM_WEBHOOK_SECRET }), config: () => ({ username: process.env.SHARED_TELEGRAM_BOT_USERNAME }) },
  email: { id: "chi_shared_email", address: () => process.env.SHARED_EMAIL_DOMAIN,
    secret: () => ({ resend_api_key: process.env.RESEND_API_KEY, webhook_secret: process.env.RESEND_WEBHOOK_SECRET }), config: () => ({}) },
};
export function ensureSharedIdentities() {
  for (const [platform, s] of Object.entries(SHARED_ENV)) {
    if (!s.address()) continue;
    exec(`insert into channel_identities (id, agent_id, platform, address, secret_enc, config, created_at) values (?, null, ?, ?, ?, ?, ?)
      on conflict(id) do update set address=excluded.address, secret_enc=excluded.secret_enc, config=excluded.config`, s.id, platform, s.address()!, seal(s.secret()), S({ ...s.config(), shared: true }), now());
  }
}
export const sharedIdentity = (platform: string) => one<any>("select * from channel_identities where id=? and agent_id is null", SHARED_ENV[platform]?.id ?? "-");

export function createDeployCode(agentId: string, userId: string, platform: string, kind: "dm" | "group") {
  const code = String(randomInt(10_000_000, 99_999_999));
  exec("insert into deploy_codes values (?,?,?,?,?,?,null)", code, agentId, userId, platform, kind, now() + 7 * 864e5);
  return code;
}

/** "start CODE" (DM) / "join CODE" (group): link the sender to the code's owner and bind this conversation to the agent. */
function redeemDeploy(code: string, e: InboundEvent, ident: any): { ok: true; agent: any; ep: any; group: boolean } | { error: string } {
  const c = one<any>("select * from deploy_codes where code=? and expires_at>? and used_at is null", code, now());
  if (!c) return { error: "That code is invalid or expired. Get a new one from the agent's Deploy page." };
  // A code only works where and how it was issued: this platform, DM vs group.
  if (c.platform !== e.provider) return { error: "That code is for a different app. Get one for this app from the agent's Deploy page." };
  if ((c.kind === "group") !== e.isGroup) return { error: c.kind === "group" ? "That code is for adding the agent to a group — send it in the group chat." : "That code is for a direct chat — send it in a 1:1 conversation." };
  const agent = one<any>("select * from agents where id=?", c.agent_id);
  if (!agent || agent.status === "deleted") return { error: "That agent no longer exists." };
  // Never re-assign a phone/handle that already belongs to a different real account.
  if (!e.isGroup) {
    const linked = one<any>("select x.user_id, u.guest from external_identities x join users u on u.id=x.user_id where x.platform=? and x.external_user_id=?", e.provider, e.senderId);
    if (linked && linked.user_id !== c.user_id && !linked.guest) return { error: "This number is already linked to a different account. Unlink it there first." };
  }
  exec("update deploy_codes set used_at=? where code=?", now(), code);
  let ep = one<any>("select * from room_endpoints where platform=? and channel_identity_id=? and external_conversation_id=?", e.provider, ident.id, e.conversationId);
  if (e.isGroup) {
    // Whoever posts the code in a group is linked to the code's owner only for DMs; group senders stay as they are.
    if (ep) {
      const room = one<any>("select * from rooms where id=?", ep.room_id);
      if (room.workspace_id !== agent.workspace_id) return { error: "This group is already connected to another workspace." };
      rt.addMember(room.id, agent.id, "agent");
    } else {
      const room = rt.createRoom({ workspace_id: agent.workspace_id, name: `${PLATFORM_NAME[e.provider] ?? e.provider} group`, kind: "shared", participation: "mention_only",
        members: [{ id: c.user_id, kind: "human" }, { id: agent.id, kind: "agent" }] });
      ep = attachEndpoint(room.id, e.provider, e.conversationId, ident.id, true, agent.id);
    }
    return { ok: true, agent, ep, group: true }; // posting a group code links nobody's identity
  }
  if (!linkIdentityTo(e.provider, e.senderId, c.user_id, null)) return { error: "This number is already linked to a different account. Unlink it there first." };
  const room = rt.privateRoomFor(c.user_id, agent);
  if (ep && ep.agent_id && ep.agent_id !== agent.id && one("select 1 from agents where id=? and status!='deleted'", ep.agent_id)) {
    // This thread already talks to another agent: add this one alongside (its own route) and make it the current one.
    const mine = threadEps(ident.id, e.conversationId).find((x) => x.agent_id === agent.id)
      ?? attachEndpoint(room.id, e.provider, `${e.conversationId}~${agent.id}`, ident.id, false, agent.id);
    patchJson("room_endpoints", "config", ep.id, (cfg) => ({ ...cfg, current: agent.id }));
    return { ok: true, agent, ep: mine, group: false };
  }
  if (ep) exec("update room_endpoints set room_id=?, agent_id=? where id=?", room.id, agent.id, ep.id);
  else ep = attachEndpoint(room.id, e.provider, e.conversationId, ident.id, false, agent.id);
  return { ok: true, agent, ep: one<any>("select * from room_endpoints where id=?", ep.id), group: false };
}
const PLATFORM_NAME: Record<string, string> = { imessage: "iMessage", whatsapp: "WhatsApp", telegram: "Telegram", slack: "Slack", email: "Email", phone: "Phone" };

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

/** Slack's single Events/Interactivity URL for the platform app: route to the installing team's identity. */
export async function handleSlackApp(req: Request): Promise<Response> {
  const raw = await req.text();
  if (!process.env.SLACK_SIGNING_SECRET || !ADAPTERS.slack.verify(raw, req.headers, { signing_secret: process.env.SLACK_SIGNING_SECRET }, req.url)) return new Response("bad signature", { status: 401 });
  const body = raw.startsWith("payload=") ? JSON.parse(new URLSearchParams(raw).get("payload")!) : JSON.parse(raw);
  if (body.type === "url_verification") return Response.json({ challenge: body.challenge });
  const team = body.team_id ?? body.team?.id;
  const ident = one<any>("select * from channel_identities where id=?", `chi_slack_${team}`);
  if (!ident) return new Response("unknown team", { status: 404 });
  for (const e of ADAPTERS.slack.parse(raw, { ...ident, agent_name: null }))
    exec("insert or ignore into inbound_events (id, provider, provider_event_id, channel_identity_id, raw, received_at) values (?,?,?,?,?,?)", id("inb"), "slack", e.providerEventId, ident.id, S(e), now());
  return new Response("ok");
}

export async function processInbound() {
  let n = 0;
  for (const row of all<any>("select * from inbound_events where status='queued' order by received_at limit 100")) {
    try {
      const e: InboundEvent = J(row.raw), ident = identity(row.channel_identity_id);
      if (e.emailId && ident) { // Resend's webhook may carry metadata only: fetch the message (stored event first, so nothing is lost if this fails)
        const r: any = await (await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(e.emailId)}`, { headers: { authorization: `Bearer ${unseal<any>(ident.secret_enc)?.resend_api_key}` } })).json();
        e.text = emailText(r.text, r.html) || e.text;
      }
      await processEvent(e, ident); exec("update inbound_events set status='processed' where id=?", row.id);
    }
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
  // Phone-number "names" (all iMessage gives us) read badly in a group: show "someone (…1234)" until they tell us.
  const name = displayName && !/^[+\d\s()\-.]{7,}$|@/.test(displayName) ? displayName : `someone (…${externalId.replace(/\D/g, "").slice(-4) || externalId.slice(-4)})`;
  exec("insert into users (id, name, guest, created_at) values (?,?,1,?)", uid, name, now());
  exec("insert into external_identities (platform, external_user_id, user_id, verified, display_name) values (?,?,?,0,?)", platform, externalId, uid, displayName ?? null);
  return uid;
}

/** external conversation -> Room. A linked user's DM lands in their private Room with the agent, whatever the channel. */
export function resolveRoom(e: InboundEvent, ident: any, senderId: string, agentId = ident.agent_id) {
  const ep = one<any>("select * from room_endpoints where platform=? and channel_identity_id=? and external_conversation_id=?", e.provider, ident.id, e.conversationId);
  if (ep) return ep;
  const agent = one<any>("select * from agents where id=?", agentId);
  const room = e.isGroup
    ? rt.createRoom({ workspace_id: agent.workspace_id, name: `${e.provider[0].toUpperCase() + e.provider.slice(1)} group`, kind: "shared", participation: "mention_only",
        members: [{ id: agent.id, kind: "agent" }] })
    : rt.privateRoomFor(senderId, agent);
  return attachEndpoint(room.id, e.provider, e.conversationId, ident.id, e.isGroup, agent.id);
}
export function attachEndpoint(roomId: string, platform: string, conversationId: string, cid: string | null, isGroup = false, agentId: string | null = null) {
  const eid = id("rep");
  exec("insert into room_endpoints (id, room_id, platform, external_conversation_id, channel_identity_id, is_group, last_active_at, agent_id) values (?,?,?,?,?,?,?,?)",
    eid, roomId, platform, conversationId, cid, isGroup ? 1 : 0, now(), agentId);
  emit("ENDPOINT_LINKED", { room_id: roomId, data: { platform, conversation: conversationId } });
  return one<any>("select * from room_endpoints where id=?", eid);
}

const isMember = (ws: string, u: string) => !!one("select 1 from memberships where workspace_id=? and user_id=?", ws, u);

async function processEvent(e: InboundEvent, ident: any) {
  if (!ident) return;
  if (e.type === "email_undeliverable") {
    for (const to of e.to ?? []) exec("update room_endpoints set undeliverable=1 where platform='email' and channel_identity_id=? and (external_conversation_id=? or external_conversation_id like ?)", ident.id, to, `${to}|%`);
    emit("EMAIL_UNDELIVERABLE", { data: { to: e.to, reason: e.text } }); return;
  }
  const token = e.provider === "email" ? (e.to ?? []).map((t) => t.match(/\+r_([a-f0-9]{16,})@/i)?.[1]).find(Boolean) : undefined;
  const byToken = token ? one<any>("select * from room_endpoints where reply_token=? and channel_identity_id=?", token, ident.id) : null;
  if (byToken) e.conversationId = byToken.external_conversation_id; // the reply goes back to the conversation that sent it
  // Shared email: the recipient alias picks the agent, and each (sender, alias) pair is its own conversation.
  const alias = !ident.agent_id && e.provider === "email" ? one<any>("select id, email_alias from agents where email_alias in (" + (e.to ?? []).map(() => "?").join(",") + ") and status!='deleted'", ...(e.to ?? []).map((t) => t.split("@")[0].split("+")[0])) : null;
  if (!ident.agent_id && e.provider === "email" && !byToken) { if (!alias) return; e.conversationId = `${e.senderId}|${alias.email_alias}`; }
  const existing = one<any>("select * from room_endpoints where platform=? and channel_identity_id=? and external_conversation_id=?", e.provider, ident.id, e.conversationId);
  // A shared line's 1:1 thread can hold several of the person's agents: "@Ava …" switches (and sticks), "agents" lists them.
  const dm = !ident.agent_id && existing && !e.isGroup && e.provider !== "email" && e.type === "message" ? dmThread(e, ident, existing) : null;
  // Shared lines carry no agent: the conversation's binding (or the email recipient alias) decides.
  const agentId = ident.agent_id ?? alias?.id ?? dm?.ep.agent_id ?? existing?.agent_id ?? (existing ? rt.roomAgents(existing.room_id)[0]?.id : null);
  const senderId = resolveSender(e.provider, e.senderId, e.senderName);
  const raw = (text: string) => ADAPTERS[e.provider].send(ident, unseal(ident.secret_enc), existing ?? { external_conversation_id: e.conversationId, is_group: e.isGroup ? 1 : 0, config: "{}" },
    { text, agentName: one<any>("select name from agents where id=?", agentId)?.name ?? "Agents" }, id("idem"));

  const start = e.text.trim().match(/^\/?(?:start|join)(?:@\w+)?\s+(\d{8})$/i) ?? e.text.trim().match(/^@\S+\s+join\s+(\d{8})$/i);
  if (start && !ident.agent_id && e.provider !== "email") { // email senders can be forged: no code redemption over email
    const misses = one<any>("select count(*) n from events where type='LINK_FAILED' and json_extract(data, '$.sender')=? and ts>?", `${e.provider}:${e.senderId}`, now() - 36e5).n;
    const global = one<any>("select count(*) n from events where type='LINK_FAILED' and ts>?", now() - 6e4).n; // spray across many senders
    if (misses >= 5 || global >= 30) return raw("Too many attempts. Try again later.");
    const r = redeemDeploy(start[1], e, ident);
    if ("error" in r) { emit("LINK_FAILED", { data: { sender: `${e.provider}:${e.senderId}` } }); return raw(r.error); }
    emit("AGENT_DEPLOYED", { workspace_id: r.agent.workspace_id, room_id: r.ep.room_id, actor: r.agent.id, data: { platform: e.provider, group: r.group } });
    const hello = r.group ? `${r.agent.name} joined this group. Mention @${r.agent.name} when you need me.` : `Hi, I'm ${r.agent.name}. You're all set — text me here anytime.`;
    rt.postMessage(r.ep.room_id, { sender: r.agent.id, text: hello, targets: [r.ep.id] });
    return;
  }
  if (!agentId) {
    // Unbound conversation on a shared line: explain once a day how to connect, don't guess an agent.
    if (!one("select 1 from events where type='SHARED_LINE_HELP' and json_extract(data, '$.conv')=? and ts>?", `${e.provider}:${e.conversationId}`, now() - 864e5)) {
      emit("SHARED_LINE_HELP", { data: { conv: `${e.provider}:${e.conversationId}` } });
      return raw("Hi! To talk to an agent here, open it on the platform → Deploy, and tap the button for this app (or send the code it shows).");
    }
    return;
  }
  const agent = one<any>("select * from agents where id=?", agentId);
  if (!ident.agent_id && e.provider === "slack" && J(ident.config, {}).bot_user_id) e.text = e.text.replaceAll(`<@${J(ident.config, {}).bot_user_id}>`, `@${agent.name}`);
  const reply = async (text: string) => { const ep = dm?.ep ?? resolveRoom(e, ident, resolveSender(e.provider, e.senderId), agentId); await ADAPTERS[e.provider].send(ident, unseal(ident.secret_enc), { ...ep, external_conversation_id: baseConv(ep.external_conversation_id) }, { text: formatFor(e.provider, text), agentName: agent.name }, id("idem")); };

  const link = e.text.trim().match(/^link (\d+)$/i);
  if (link) {
    // Brute-force guard: 5 misses per sender per hour.
    const misses = one<any>("select count(*) n from events where type='LINK_FAILED' and json_extract(data, '$.sender')=? and ts>?", `${e.provider}:${e.senderId}`, now() - 36e5).n;
    if (misses >= 5) return reply("Too many attempts. Try again in an hour.");
    if (linkIdentity(e.provider, e.senderId, link[1], ident)) return reply(`Linked. I'll recognize you here from now on.`);
    emit("LINK_FAILED", { data: { sender: `${e.provider}:${e.senderId}` } });
    return reply(`That code is invalid or expired.`);
  }

  if (dm?.note) return reply(dm.note);
  if (dm?.switched) return reply(`Hi, it's ${agent.name}. What can I do for you?`);

  // Tapback on one of our messages: 👍/❤️/‼️ = the message's first button (approve, go), 👎 = the second (reject, cancel).
  if (e.reaction) {
    const o = one<any>("select o.* from outbox o join room_endpoints r on r.id=o.endpoint_id where o.external_id=? and r.channel_identity_id=?", e.reaction.targetId, ident.id);
    const btns = o ? J(one<any>("select data from events where id=?", o.event_id)?.data, {}).buttons ?? [] : [];
    const pick = /^(👍|❤️|♥️|‼️|like|love|emphasi[sz]e|thumbs_?up)$/i.test(e.reaction.emoji) ? btns[0] : /^(👎|dislike|thumbs_?down)$/i.test(e.reaction.emoji) ? btns[1] : null;
    if (!pick) return; // other tapbacks (😂, ❓) aren't messages to the agent
    const r = await pressButton(pick.data, senderId, o.room_id, o.endpoint_id);
    if ("error" in r) return reply(r.error!);
    if (r.say) return reply(r.say);
    return;
  }

  if (e.type === "button_clicked") {
    const ep = resolveRoom(e, ident, senderId, agentId);
    const r = await pressButton(e.data ?? "", senderId, ep.room_id, ep.id);
    if ("error" in r) return reply(r.error!);
    if (r.say) return reply(r.say);
    return;
  }

  if (e.type === "email_received") {
    // EVENT wake condition: a run waiting on a reply from this address resumes (plan §33).
    const ws = one<any>("select workspace_id from agents where id=?", agentId)?.workspace_id;
    if (agentId && rt.signalEvent(`email:${ws}:${e.senderId}`, `Email from ${e.senderName} <${e.senderId}> — ${e.subject ?? ""}\n<untrusted origin="EMAIL">${e.text}</untrusted>`)) return;
  }

  const ep = dm?.ep ?? resolveRoom(e, ident, senderId, agentId);
  if (e.subject) patchJson("room_endpoints", "config", ep.id, (c) => ({ ...c, subject: e.subject }));
  const room = one<any>("select * from rooms where id=?", ep.room_id);
  learnName(senderId, e.text);
  if (e.attachments?.length) { // photos described, voice notes transcribed, files read — then it's an ordinary message
    const said: string[] = [];
    for (const f of e.attachments) said.push(await media.describe(f, { workspaceId: room.workspace_id, roomId: room.id, userId: senderId, sender: rt.nameOf(senderId) ?? "someone" }));
    e.text = [e.text, ...said].filter(Boolean).join("\n");
  }
  if (!e.text.trim()) return;
  await rt.ingestMessage({ roomId: ep.room_id, senderId, text: e.text, platform: e.provider, endpointId: ep.id, externalId: e.providerEventId,
    untrusted: !isMember(room.workspace_id, senderId) }); // external contacts are untrusted (plan §21.1)
}

const threadEps = (identId: string, conv: string) =>
  all<any>("select * from room_endpoints where channel_identity_id=? and (external_conversation_id=? or external_conversation_id like ?) order by last_active_at", identId, conv, `${conv}~%`);
function dmThread(e: InboundEvent, ident: any, primary: any): { ep: any; note?: string; switched?: boolean } {
  const eps = threadEps(ident.id, primary.external_conversation_id);
  const current = eps.find((x) => x.agent_id === J(primary.config, {}).current) ?? primary;
  const user = one<any>("select x.user_id from external_identities x join users u on u.id=x.user_id where x.platform=? and x.external_user_id=? and u.guest=0", e.provider, e.senderId)?.user_id;
  if (!user) return { ep: current };
  const mine = all<any>("select a.* from agents a join memberships m on m.workspace_id=a.workspace_id where m.user_id=? and a.status='active' order by a.created_at", user);
  const t = e.text.trim();
  if (/^\/?(agents|who'?s here\??)$/i.test(t)) {
    const names = mine.map((a) => (a.id === current.agent_id ? `${a.name} (talking now)` : a.name));
    return { ep: current, note: `Your agents: ${names.join(", ")}. Start a message with @Name to talk to another one — I'll stay with them until you switch.` };
  }
  const m = t.match(/^(?:switch to|talk to)\s+@?([\w-]+)/i) ?? t.match(/^@([\w-]+)/) ?? t.match(/^([\w-]+)[,:]\s/);
  const target = m ? mine.find((a) => a.name.toLowerCase() === m[1].toLowerCase()) : null;
  if (!target || target.id === current.agent_id) return { ep: current };
  let ep = eps.find((x) => x.agent_id === target.id);
  if (!ep) ep = attachEndpoint(rt.privateRoomFor(user, target).id, e.provider, `${primary.external_conversation_id}~${target.id}`, ident.id, false, target.id);
  patchJson("room_endpoints", "config", primary.id, (c) => ({ ...c, current: target.id }));
  return { ep, switched: /^(switch to|talk to)\s+@?[\w-]+[.!]?$/i.test(t) };
}

// People on iMessage arrive as phone numbers. Pick up a name when they say it ("I'm Maria", "call me Maria", "this is Maria").
// ponytail: pattern-based; a model pass could catch "Maria here" etc. if it matters.
const NOT_NAMES = /^(not|good|fine|here|late|out|in|on|back|home|sorry|down|up|done|ok|okay|sure|so|just|the|sick|hungry|free|busy|tired|excited|ready|coming|leaving|going|running|almost|still|also|off|there|new|super|very|really|glad|happy|great|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|me|him|her|us|them|over|fair|true|real|cool|fun|worth|time|possible|easy|hard|amazing|awesome)$/i;
export function learnName(userId: string, text: string) {
  const u = one<any>("select name, guest from users where id=?", userId);
  if (!u?.guest || !/^someone \(/.test(u.name)) return;
  const m = text.match(/\b(?:[Mm]y name is|[Cc]all me|[Tt]his is|[Ii]t'?s)\s+([A-Z][a-z]{1,19})\b/) ?? text.match(/^(?:(?:[Hh]i|[Hh]ey|[Hh]ello)[,!]?\s+)?(?:I'?m|I am|i'?m)\s+([A-Z][a-z]{1,19})\b/);
  if (!m || NOT_NAMES.test(m[1])) return;
  exec("update users set name=? where id=?", m[1], userId);
  exec("update external_identities set display_name=? where user_id=?", m[1], userId);
}

/** "…is typing" in the chat a run came from, while the agent works (at most every 4s per chat). */
const typedAt = new Map<string, number>();
export function typing(endpointId: string | null | undefined) {
  const ep = endpointId ? one<any>("select * from room_endpoints where id=?", endpointId) : null;
  const ad = ep && ADAPTERS[ep.platform];
  if (!ep || !ad?.typing || !ep.channel_identity_id || Date.now() - (typedAt.get(ep.id) ?? 0) < 4000) return;
  typedAt.set(ep.id, Date.now());
  const ident = identity(ep.channel_identity_id);
  if (ident) ad.typing(ident, unseal(ident.secret_enc), { ...ep, external_conversation_id: baseConv(ep.external_conversation_id) }).catch(() => {});
}

/** Every card button (web or channel) lands here; a button only acts on objects in the room it was pressed in. */
export async function pressButton(data: string, userId: string, roomId: string, endpointId: string | null): Promise<{ ok?: boolean; error?: string; say?: string }> {
  const [kind, objId, action] = data.split(":");
  const roomOf = (sql: string) => one<any>(sql, objId)?.room_id;
  if (kind === "apr") {
    if (roomOf("select room_id from approvals where id=?") !== roomId) return { error: "that approval isn't in this conversation" };
    // A button that names the exact action ("Confirm") is a deliberate confirmation.
    return rt.decideApproval(objId, userId, action === "approve" ? "approve" : "reject", { confirm: action === "approve" }, endpointId);
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
  return linkIdentityTo(platform, externalId, c.user_id, ident); // false: the number already belongs to another real account
}
/** Bind an external identity (phone, handle) to a user. Refuses — before writing anything — when it already belongs to a
 *  different real (non-guest) account; a guest is folded into the user. All-or-nothing. */
function linkIdentityTo(platform: string, externalId: string, userId: string, ident?: any): boolean {
  const old = one<any>("select * from external_identities where platform=? and external_user_id=?", platform, externalId);
  if (old && old.user_id !== userId && !one<any>("select guest from users where id=?", old.user_id)?.guest) {
    emit("IDENTITY_LINK_REFUSED", { actor: userId, data: { platform, owner: old.user_id } });
    return false;
  }
  tx(() => foldIdentity(platform, externalId, userId, old, ident));
  return true;
}
function foldIdentity(platform: string, externalId: string, userId: string, old: any, ident?: any) {
  const c = { user_id: userId };
  exec("insert or replace into external_identities (platform, external_user_id, user_id, verified, display_name) values (?,?,?,1,?)", platform, externalId, c.user_id, old?.display_name ?? null);
  if (old && old.user_id !== c.user_id) {
    // Fold the guest into the real user: DM endpoints re-point to the user's own private Room; group memberships move over.
    if (ident?.agent_id) {
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
}

// ---------------- outbound ----------------
export function enqueue(endpointId: string, roomId: string, eventId: string, payload: Outbound) {
  exec("insert into outbox (id, endpoint_id, room_id, event_id, payload, created_at) values (?,?,?,?,?,?)", id("out"), endpointId, roomId, eventId, S(payload), now());
}
export const SEND_CLAIM_STALE_MS = 10 * 60_000;
export async function flushOutbox() {
  let n = 0;
  // A claim that never got confirmed means we crashed mid-send: it may or may not have gone out. Never auto-resend (Castellum
  // learned a timeout-driven resend double-sends); park it as 'unconfirmed' for a human to check.
  exec("update outbox set status='unconfirmed', error='send was interrupted; check before resending' where status='sending' and claimed_at<?", now() - SEND_CLAIM_STALE_MS);
  for (const o of all<any>("select * from outbox where status='queued' and attempts<5 order by created_at limit 100")) {
    const ep = one<any>("select * from room_endpoints where id=?", o.endpoint_id);
    const ident = ep?.channel_identity_id ? identity(ep.channel_identity_id) : null;
    if (!ep || !ident || !ADAPTERS[ep.platform]) { exec("update outbox set status='skipped' where id=?", o.id); continue; }
    if (ep.undeliverable) { exec("update outbox set status='skipped', error='address bounced or complained' where id=?", o.id); continue; }
    // Claim before sending, confirm after: two separate writes, so an interruption is visible instead of silent.
    if (!exec("update outbox set status='sending', claimed_at=? where id=? and status='queued'", now(), o.id).changes) continue;
    try {
      const p = J(o.payload);
      p.text = formatFor(ep.platform, String(p.text ?? ""));
      if (!ident.agent_id) { // shared line: say who's talking (groups, or a 1:1 thread with several agents); email needs the alias
        const a = one<any>("select name, email_alias from agents where name=? and workspace_id=(select workspace_id from rooms where id=?)", p.agentName, o.room_id);
        const shared1to1 = !ep.is_group && one<any>("select count(*) n from room_endpoints where channel_identity_id=? and (external_conversation_id=? or external_conversation_id like ?)",
          ident.id, baseConv(ep.external_conversation_id), `${baseConv(ep.external_conversation_id)}~%`).n > 1;
        if ((ep.is_group || shared1to1) && p.agentName && ep.platform !== "email") p.text = `${p.agentName}: ${p.text}`;
        p.agentAlias = a?.email_alias;
      }
      const target = { ...ep, external_conversation_id: baseConv(ep.external_conversation_id) };
      const parts = SPLIT_AT[ep.platform] ? splitMessage(p.text, SPLIT_AT[ep.platform]) : [p.text];
      let ext: string | undefined;
      for (const [i, text] of parts.entries()) // buttons ride on the last part; the stored id is the last part's (tapbacks target it)
        ext = await ADAPTERS[ep.platform].send(ident, unseal(ident.secret_enc), target, { ...p, text, buttons: i === parts.length - 1 ? p.buttons : undefined }, parts.length > 1 ? `${o.id}:${i}` : o.id);
      exec("update outbox set status='sent', external_id=?, attempts=attempts+1 where id=?", ext ?? null, o.id);
      patchJson("events", "data", o.event_id, (d) => ({ ...d, delivery: [{ platform: ep.platform, external_id: ext ?? null }] }));
    } catch (e: any) { // the provider said no: nothing went out, so it's safe to retry
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
  recordUsage({ workspace_id: one<any>("select workspace_id from rooms where id=?", ep.room_id).workspace_id, agent_id: ident.agent_id, kind: "voice_turns", qty: 1 });
  return twiml(said.join(" ") || "I'm working on it and will follow up by message.", url);
}
