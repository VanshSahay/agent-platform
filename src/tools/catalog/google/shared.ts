import type { ToolContext, ToolDef, ToolResult } from "../../kit.ts";
import { notConnected } from "../shared.ts";

/**
 * Fo's "google" family, 26 tools over one connection per person: Gmail, Calendar, Drive, Sheets,
 * Forms and Slides through the REST APIs. The credential (a refresh token the OAuth flow stored)
 * never reaches the model: every call runs inside vault.use.
 */
export const CAL = "https://www.googleapis.com/calendar/v3";
export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
export const DRIVE = "https://www.googleapis.com/drive/v3";
export const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
export const FORMS = "https://forms.googleapis.com/v1/forms";
export const SLIDES = "https://slides.googleapis.com/v1/presentations";

export type Req = Parameters<ToolContext["hands"]["google"]["request"]>[1];
export const list = (description: string) => ({ type: "array", items: { type: "string" }, description });

export async function g<T = unknown>(ctx: ToolContext, req: Req): Promise<T> {
  const out = await ctx.vault.use("google", (cred) => ctx.hands.google.request(cred, req));
  if (out === undefined) throw new Error("Google is not connected");
  return out as T;
}
export const connected = (ctx: ToolContext) => ctx.vault.has("google");
export const who = (ctx: ToolContext) => ctx.store.getPerson(ctx.accountOwnerId)?.displayName ?? "the account owner";

/** A write on someone's account by someone else asks that person first; on your own account it just happens. */
export function guard(ctx: ToolContext, title: string, detail: string, key: unknown[]): ToolResult | undefined {
  if (ctx.requesterId === ctx.accountOwnerId) return undefined;
  const gate = ctx.gate({ kind: "action", title, detail, key });
  if (gate.granted) return undefined;
  if ("held" in gate) return { ok: true, content: gate.held, held: true };
  return { ok: true, content: `Asked ${who(ctx)} before touching their account.`, waitingOn: gate.item, roomNotice: gate.notice };
}

export const fail = (e: unknown): ToolResult => ({ ok: false, content: `Google said: ${String((e as Error).message).slice(0, 300)}` });

/** Decode a Gmail message into plain text. */
export function gmailText(msg: { payload?: { mimeType?: string; body?: { data?: string }; parts?: unknown[] } }): string {
  const parts: string[] = [];
  const walk = (p: { mimeType?: string; body?: { data?: string }; parts?: unknown[] } | undefined) => {
    if (!p) return;
    if (p.mimeType === "text/plain" && p.body?.data) parts.push(Buffer.from(p.body.data, "base64url").toString("utf8"));
    for (const c of (p.parts ?? []) as (typeof p)[]) walk(c);
  };
  walk(msg.payload);
  if (!parts.length && msg.payload?.body?.data) parts.push(Buffer.from(msg.payload.body.data, "base64url").toString("utf8"));
  return parts.join("\n");
}
export const header = (msg: { payload?: { headers?: { name: string; value: string }[] } }, name: string) =>
  msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

export async function labelId(ctx: ToolContext, name: string, create: boolean): Promise<string | undefined> {
  const r = await g<{ labels?: { id: string; name: string }[] }>(ctx, { method: "GET", url: `${GMAIL}/labels` });
  const hit = r.labels?.find((l) => l.name.toLowerCase() === name.toLowerCase() || l.id === name);
  if (hit) return hit.id;
  if (!create) return undefined;
  const made = await g<{ id: string }>(ctx, { method: "POST", url: `${GMAIL}/labels`, body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } });
  return made.id;
}

/** Free slots inside a window where none of the calendars are busy. Pure, so it is testable. */
export function freeSlots(
  busy: { start: number; end: number }[],
  window: { start: number; end: number },
  minMinutes: number,
  hours = { start: 9, end: 18 },
  zone = "UTC",
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const merged = [...busy]
    .sort((a, b) => a.start - b.start)
    .reduce<{ start: number; end: number }[]>((acc, b) => {
      const last = acc.at(-1);
      if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
      else acc.push({ ...b });
      return acc;
    }, []);
  const hourOf = (t: number) => Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hour12: false }).format(new Date(t)));
  let cursor = window.start;
  const gaps = [...merged, { start: window.end, end: window.end }];
  for (const b of gaps) {
    if (b.start > cursor) out.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  const min = minMinutes * 60_000;
  const slots: { start: number; end: number }[] = [];
  for (const gap of out) {
    // Walk the gap in 30-minute steps and keep the stretches that fall in working hours.
    let t = gap.start;
    while (t + min <= gap.end) {
      const h = hourOf(t);
      if (h >= hours.start && h < hours.end && hourOf(t + min - 1) < hours.end) {
        slots.push({ start: t, end: t + min });
        t += min;
      } else t += 30 * 60_000;
      if (slots.length >= 10) return slots;
    }
  }
  return slots;
}

/**
 * Every Google tool needs the person's connection and turns a Google error into a plain answer;
 * the wrapper does both so the tool bodies hold only the call.
 */
export const gtool = (def: ToolDef): ToolDef => ({
  ...def,
  async run(input, ctx) {
    if (!connected(ctx)) return notConnected(ctx, "Google");
    try {
      return await def.run(input, ctx);
    } catch (e) {
      return fail(e);
    }
  },
});
