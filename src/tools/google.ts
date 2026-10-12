// Gmail, Calendar, Contacts, Drive on the person's own Google account. OAuth lives in server.ts; tokens refresh here.
import { def, obj, str, num, ToolError, type Ctx } from "./index";
import { sql, seal, unseal, now, zoned, fromZoned, fmtLocal, J } from "../db";

const refreshing = new Map<string, Promise<void>>();
async function token(ctx: Ctx) {
  const c = ctx.connection!, cred = unseal<any>(c.cred_enc) ?? {};
  if (cred.expires_at && cred.expires_at < now() + 60_000 && cred.refresh_token) {
    if (!refreshing.has(c.id)) refreshing.set(c.id, (async () => {
      const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "", refresh_token: cred.refresh_token, grant_type: "refresh_token" }) });
      if (!r.ok) throw new ToolError("AUTH", "token refresh failed");
      const t: any = await r.json();
      c.cred_enc = seal({ ...cred, access_token: t.access_token, refresh_token: t.refresh_token ?? cred.refresh_token, expires_at: now() + t.expires_in * 1000 });
      await sql`update connections set cred_enc=${c.cred_enc} where id=${c.id}`;
    })().finally(() => refreshing.delete(c.id)));
    await refreshing.get(c.id);
  }
  return { authorization: `Bearer ${unseal<any>(c.cred_enc).access_token}`, "content-type": "application/json" };
}
/** Outbound HTTP with the failure taxonomy: a write with no clean answer is UNKNOWN, never retried blindly. */
async function call(url: string, init: RequestInit & { write?: boolean } = {}) {
  let r: Response;
  try { r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }); }
  catch (e: any) { throw new ToolError(init.write ? "UNKNOWN_SIDE_EFFECT" : "TRANSIENT", `network error: ${e.message}`); }
  if (r.status === 401 || r.status === 403) throw new ToolError("AUTH", `Google rejected the credentials (${r.status})`);
  if (r.status === 429) throw new ToolError("RATE_LIMIT", "rate limited");
  if (r.status >= 500) throw new ToolError(init.write ? "UNKNOWN_SIDE_EFFECT" : "TRANSIENT", `Google error (${r.status})`);
  if (!r.ok) throw new ToolError("BUSINESS_RULE", `Google returned ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r;
}
const b64url = (s: string) => Buffer.from(s).toString("base64url");
const tzOf = (ctx: Ctx) => ctx.requester?.tz ?? "America/New_York";

def({
  id: "email.search", kind: "read", connection: "google", description: "Search the person's Gmail (Gmail query syntax, e.g. 'from:dana newer_than:7d').",
  inputSchema: obj({ query: str(), max: num() }, ["query"]),
  async execute({ query, max = 10 }, ctx) {
    const h = await token(ctx);
    const list: any = await (await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(max, 20)}`, { headers: h })).json();
    const messages = [];
    for (const m of list.messages ?? []) {
      const g: any = await (await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: h })).json();
      const hd = Object.fromEntries((g.payload?.headers ?? []).map((x: any) => [x.name.toLowerCase(), x.value]));
      messages.push({ id: m.id, threadId: g.threadId, from: hd.from, subject: hd.subject, date: hd.date, snippet: g.snippet });
    }
    return { status: "SUCCEEDED", untrusted: true, output: { messages } };
  },
});

def({
  id: "email.draft", kind: "read", connection: "google", description: "Save a real draft in the person's Gmail (Drafts folder), ready for them to send. Use when they want to review or send it themselves, or when sending as them is switched off.",
  inputSchema: obj({ to: { type: "array", items: str() }, subject: str(), body: str(), thread_id: str() }, ["to", "subject", "body"]),
  async execute({ to, subject, body, thread_id }, ctx) {
    const raw = b64url(`To: ${to.join(", ")}\r\nSubject: ${String(subject).replace(/[\r\n]+/g, " ")}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
    const j: any = await (await call("https://gmail.googleapis.com/gmail/v1/users/me/drafts", { method: "POST", headers: await token(ctx), body: JSON.stringify({ message: { raw, threadId: thread_id } }) })).json();
    return { status: "SUCCEEDED", output: { draft_id: j.id, to, subject, where: "Gmail Drafts" } };
  },
});

def({
  id: "email.send", kind: "write", connection: "google", description: "Send an email from the person's Gmail, as them. Only works when they have switched on 'send email as me' for that account; otherwise save a draft with email.draft. The platform shows them the exact email and asks for their OK first; just call it with the final content.",
  inputSchema: obj({ to: { type: "array", items: str() }, subject: str(), body: str(), thread_id: str() }, ["to", "subject", "body"]),
  summarize: (i) => `Send email to ${i.to.join(", ")}: "${i.subject}"`,
  preview: (i) => `To: ${i.to.join(", ")}\nSubject: ${i.subject}\n\n${String(i.body).slice(0, 1500)}`,
  verify: (o) => o?.id ?? null,
  async execute({ to, subject, body, thread_id }, ctx) {
    if (!J(ctx.connection.config, {}).send_as_me) throw new ToolError("PERMISSION", "sending email as them is switched off (it's off until they turn it on under Connections → Google). Save a draft with email.draft instead and tell them where it is.");
    if (to.some((a: string) => !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(a))) throw new ToolError("BUSINESS_RULE", "invalid recipient address");
    subject = subject.replace(/[\r\n]+/g, " ");
    const msgId = `<${ctx.idempotencyKey.slice(0, 40)}@agent.mail>`; // lets us ask Gmail afterwards whether this exact email went out
    const raw = b64url(`To: ${to.join(", ")}\r\nSubject: ${subject}\r\nMessage-ID: ${msgId}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
    const h = await token(ctx);
    let r: any;
    try { r = await (await call("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", write: true, headers: h, body: JSON.stringify({ raw, threadId: thread_id }) })).json(); }
    catch (e: any) {
      if (!(e instanceof ToolError) || e.kind !== "UNKNOWN_SIDE_EFFECT") throw e;
      await new Promise((res) => setTimeout(res, 2000));
      const j: any = await (await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(`rfc822msgid:${msgId}`)}&maxResults=1`, { headers: h })).json().catch(() => null);
      if (!j) throw e;
      if (!j.messages?.length) throw new ToolError("TRANSIENT", `${e.message}; verified not sent`);
      r = { id: j.messages[0].id };
    }
    return r.id ? { status: "SUCCEEDED", output: { id: r.id, to, subject } } : { status: "UNKNOWN", output: r };
  },
});

def({
  id: "calendar.list_events", kind: "read", connection: "google", description: "Events on the person's Google Calendar for a day or range, in their time zone.",
  inputSchema: obj({ from: str("today | tomorrow | YYYY-MM-DD"), days: num("1-31"), query: str() }),
  async execute({ from = "today", days = 1, query }, ctx) {
    const tz = tzOf(ctx), z = zoned(now(), tz);
    const off = { today: 0, tomorrow: 1, yesterday: -1 }[String(from).toLowerCase() as "today"];
    const m = String(from).match(/(\d{4})-(\d\d)-(\d\d)/);
    const d = off !== undefined ? { y: z.y, mo: z.mo, d: z.d + off } : m ? { y: +m[1], mo: +m[2] - 1, d: +m[3] } : null;
    if (!d) throw new ToolError("BUSINESS_RULE", "from must be today, tomorrow or YYYY-MM-DD");
    const n = Math.min(31, Math.max(1, Math.round(days))), start = fromZoned(d.y, d.mo, d.d, 0, 0, tz), end = fromZoned(d.y, d.mo, d.d + n, 0, 0, tz);
    const qs = new URLSearchParams({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "50", ...(query ? { q: String(query) } : {}) });
    const j: any = await (await call(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${qs}`, { headers: await token(ctx) })).json();
    const events = (j.items ?? []).filter((e: any) => e.status !== "cancelled").map((e: any) => {
      const allDay = !e.start?.dateTime, s0 = Date.parse(e.start?.dateTime ?? `${e.start?.date}T00:00:00`), e0 = Date.parse(e.end?.dateTime ?? `${e.end?.date}T00:00:00`);
      return { id: e.id, summary: e.summary ?? "(no title)", start: allDay ? e.start?.date : fmtLocal(s0, tz), end: allDay ? e.end?.date : fmtLocal(e0, tz), past: !allDay && e0 < now(), location: e.location, attendees: e.attendees?.map((a: any) => a.email).slice(0, 10) };
    });
    return { status: "SUCCEEDED", untrusted: true, output: { time_zone: tz, range: `${fmtLocal(start, tz)} → ${fmtLocal(end - 1, tz)}`, events } };
  },
});

def({
  id: "calendar.create_event", kind: "write", connection: "google", description: "Create an event on the person's calendar (asks their OK first). start is an ISO datetime in their zone.",
  inputSchema: obj({ title: str(), start: str("ISO datetime"), duration_minutes: num(), attendees: { type: "array", items: str() }, location: str() }, ["title", "start"]),
  summarize: (i) => `Add "${i.title}" to the calendar at ${i.start}`, verify: (o) => o?.id ?? null,
  async execute({ title, start, duration_minutes = 30, attendees = [], location }, ctx) {
    const tz = tzOf(ctx), m = String(start).match(/(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)/);
    const s = /[zZ]|[+-]\d\d:?\d\d$/.test(start) || !m ? Date.parse(start) : fromZoned(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], tz);
    if (!s) throw new ToolError("BUSINESS_RULE", "start must be an ISO datetime");
    const body = { summary: title, location, start: { dateTime: new Date(s).toISOString() }, end: { dateTime: new Date(s + duration_minutes * 6e4).toISOString() }, attendees: attendees.map((email: string) => ({ email })), id: ctx.idempotencyKey.replace(/[^a-v0-9]/g, "").slice(0, 32) };
    const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", { method: "POST", headers: await token(ctx), body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (r.status === 409) return { status: "SUCCEEDED", output: { id: body.id, title, deduped: true } };
    if (!r.ok) throw new ToolError(r.status === 401 ? "AUTH" : r.status >= 500 ? "UNKNOWN_SIDE_EFFECT" : "BUSINESS_RULE", `calendar ${r.status}`);
    const j: any = await r.json();
    return { status: "SUCCEEDED", output: { id: j.id, title, start: fmtLocal(s, tz), link: j.htmlLink } };
  },
});

def({
  id: "calendar.cancel_event", kind: "write", connection: "google", description: "Delete a calendar event by id (asks their OK first).",
  inputSchema: obj({ event_id: str() }, ["event_id"]), summarize: (i) => `Cancel calendar event ${i.event_id}`, verify: (o) => o?.cancelled ?? null,
  async execute({ event_id }, ctx) {
    await call(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(event_id)}`, { method: "DELETE", write: true, headers: await token(ctx) });
    return { status: "SUCCEEDED", output: { cancelled: event_id } };
  },
});

def({
  id: "calendar.free_slots", kind: "read", connection: "google", description: "Open slots on the person's calendar (optionally also attendees' calendars) in a date range, working hours only.",
  inputSchema: obj({ from: str("YYYY-MM-DD (default today)"), days: num(), duration_minutes: num(), after_hour: num(), before_hour: num(), attendees: { type: "array", items: str() } }),
  async execute(i, ctx) {
    const tz = tzOf(ctx), z = zoned(now(), tz), m = String(i.from ?? "").match(/(\d{4})-(\d\d)-(\d\d)/);
    const start = Math.max(now(), m ? fromZoned(+m[1], +m[2] - 1, +m[3], 0, 0, tz) : now()), end = start + Math.min(60, i.days ?? 5) * 864e5;
    const j: any = await (await call("https://www.googleapis.com/calendar/v3/freeBusy", { method: "POST", headers: await token(ctx), body: JSON.stringify({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), items: [{ id: "primary" }, ...(i.attendees ?? []).slice(0, 20).map((id: string) => ({ id }))] }) })).json();
    const busy = Object.values(j.calendars ?? {}).flatMap((c: any) => (c.busy ?? []).map((x: any) => [Date.parse(x.start), Date.parse(x.end)]));
    const len = (i.duration_minutes ?? 30) * 6e4, after = i.after_hour ?? 9, before = i.before_hour ?? 18, slots: string[] = [];
    for (let t = start - (start % (30 * 6e4)) + 30 * 6e4; t + len <= end && slots.length < 12; t += 30 * 6e4) {
      const zz = zoned(t, tz); if (zz.h < after || zz.h + len / 36e5 > before || zz.dow === 0 || zz.dow === 6) continue;
      if (!busy.some(([b0, b1]) => b0 < t + len && b1 > t)) slots.push(fmtLocal(t, tz));
    }
    void z;
    return { status: "SUCCEEDED", output: { time_zone: tz, slots, duration_minutes: i.duration_minutes ?? 30 } };
  },
});

def({
  id: "contacts.search", kind: "read", connection: "google", description: "Look up people in the person's Google contacts by name or email.",
  inputSchema: obj({ query: str() }, ["query"]),
  async execute({ query }, ctx) {
    const j: any = await (await call(`https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(query)}&readMask=names,emailAddresses,phoneNumbers&pageSize=5`, { headers: await token(ctx) })).json();
    return { status: "SUCCEEDED", untrusted: true, output: { people: (j.results ?? []).map((r: any) => ({ name: r.person?.names?.[0]?.displayName, emails: (r.person?.emailAddresses ?? []).map((e: any) => e.value), phones: (r.person?.phoneNumbers ?? []).map((p: any) => p.value) })) } };
  },
});

def({
  id: "drive.search", kind: "read", connection: "google", description: "Search the person's Google Drive by text; returns file ids and links.",
  inputSchema: obj({ query: str() }, ["query"]),
  async execute({ query }, ctx) {
    const q = encodeURIComponent(`fullText contains '${String(query).replace(/['\\]/g, "")}' and trashed=false`);
    const j: any = await (await call(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=8&fields=files(id,name,mimeType,modifiedTime,webViewLink)`, { headers: await token(ctx) })).json();
    return { status: "SUCCEEDED", untrusted: true, output: { files: j.files ?? [] } };
  },
});

def({
  id: "drive.read", kind: "read", connection: "google", description: "Read a Drive file's text by id (Google Docs exported as plain text).",
  inputSchema: obj({ file_id: str() }, ["file_id"]),
  async execute({ file_id }, ctx) {
    const h = await token(ctx), fid = encodeURIComponent(file_id);
    const meta: any = await (await call(`https://www.googleapis.com/drive/v3/files/${fid}?fields=name,mimeType,webViewLink`, { headers: h })).json();
    const url = meta.mimeType?.startsWith("application/vnd.google-apps.") ? `https://www.googleapis.com/drive/v3/files/${fid}/export?mimeType=text/plain` : `https://www.googleapis.com/drive/v3/files/${fid}?alt=media`;
    return { status: "SUCCEEDED", untrusted: true, output: { name: meta.name, link: meta.webViewLink, text: (await (await call(url, { headers: h })).text()).slice(0, 20_000) } };
  },
});

/** Has `from` emailed this person since `since`? null when we can't tell. Used by follow-up reminders. */
export async function repliedSince(user: any, from: string, since: number): Promise<boolean | null> {
  const c = (await sql`select * from connections where user_id=${user.id} and provider='google' and status='active' limit 1`)[0];
  if (!c) return null;
  try {
    const h = await token({ connection: c, requester: user } as Ctx);
    const j: any = await (await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(`from:${from} after:${Math.floor(since / 1000)}`)}&maxResults=1`, { headers: h })).json();
    return (j.messages?.length ?? 0) > 0;
  } catch { return null; }
}
