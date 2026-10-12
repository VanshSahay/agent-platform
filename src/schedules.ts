// Reminders and recurring jobs. tick() fires what is due; a "task" wakes the agent, a "message" is sent word for word.
import { sql, id, now, zoned, fromZoned, J } from "./db";
import { ToolError } from "./tools/index";

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export function describeSpec(sp: any) {
  if (sp.at) return "once";
  const at = `${sp.hour ?? 9}:${String(sp.minute ?? 0).padStart(2, "0")}`;
  return sp.days?.length ? `${sp.days.map((d: number) => DOW[d]).join("/")} at ${at}` : `${sp.every ?? "daily"} at ${at}`;
}
export function nextRecurring(sp: any, after: number) {
  const tz = sp.tz ?? "America/New_York";
  for (let i = 0; i < 400; i++) {
    const z = zoned(after + i * 864e5, tz), t = fromZoned(z.y, z.mo, z.d, sp.hour ?? 9, sp.minute ?? 0, tz);
    if (t <= after) continue;
    const ok = sp.days?.length ? sp.days.includes(z.dow) : sp.every === "weekdays" ? z.dow >= 1 && z.dow <= 5 : sp.every === "weekends" ? z.dow === 0 || z.dow === 6 : sp.every === "weekly" ? z.dow === (sp.day ?? zoned(after, tz).dow) : true;
    if (ok) return t;
  }
  return null;
}
export async function createSchedule(a: { roomId: string; userId: string; text: string; kind: "message" | "task"; when: any; tz: string; unlessReplyFrom?: string }) {
  const w = a.when, tz = a.tz;
  const [hh, mm] = String(w.time ?? "").match(/^(\d{1,2}):(\d{2})$/)?.slice(1).map(Number) ?? [9, 0];
  let spec: any, next: number | null;
  const oneOff = w.in_minutes != null || !!w.at; // a concrete time wins over a stray "every" the model also filled in
  if (!oneOff && (w.every || w.days?.length)) {
    spec = { every: w.every ?? "weekly", days: (w.days ?? []).map((d: string) => DOW.indexOf(d.slice(0, 3).toLowerCase())).filter((d: number) => d >= 0), hour: hh, minute: mm, tz, day: zoned(now(), tz).dow };
    next = nextRecurring(spec, now());
  } else {
    const m = String(w.at ?? "").match(/(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)/);
    const at = w.at ? (/[zZ]|[+-]\d\d:?\d\d$/.test(w.at) || !m ? Date.parse(w.at) : fromZoned(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], tz))
      : w.time ? (() => { const z = zoned(now(), tz); let t = fromZoned(z.y, z.mo, z.d, hh, mm, tz); if (t <= now()) t = fromZoned(z.y, z.mo, z.d + 1, hh, mm, tz); return t; })()
      : now() + (w.in_minutes ?? 60) * 6e4;
    if (!(at > now())) throw new ToolError("BUSINESS_RULE", "that time is in the past; pick a future time");
    spec = { at }; next = at;
  }
  if (a.unlessReplyFrom) spec.unless_reply_from = String(a.unlessReplyFrom).toLowerCase(), spec.since = now();
  const sid = id("sch");
  await sql`insert into schedules (id, room_id, user_id, text, kind, spec, next_at, created_at) values (${sid}, ${a.roomId}, ${a.userId}, ${a.text}, ${a.kind}, ${JSON.stringify(spec)}::text::jsonb, ${next}, ${now()})`;
  return { id: sid, next_at: next!, spec };
}

/** Fire what is due. `fire` delivers: a message to the room, or a request the agent works on. */
export async function tick(fire: (s: any, kind: "message" | "task", text: string) => Promise<void>, repliedSince: (userId: string, from: string, since: number) => Promise<boolean | null>) {
  const due = await sql`select * from schedules where status='active' and next_at<=${now()} order by next_at limit 20`;
  for (const s of due) {
    const sp = J(s.spec, {});
    const next = sp.at ? null : nextRecurring(sp, now());
    await sql`update schedules set next_at=${next}, status=${next ? "active" : "done"} where id=${s.id}`; // claim first: a crash mid-send never double-fires
    try {
      if (sp.unless_reply_from) {
        const replied = await repliedSince(s.user_id, sp.unless_reply_from, Number(sp.since ?? s.created_at));
        if (replied === true) { await fire(s, "message", `No reminder needed: ${sp.unless_reply_from} has replied since.`); continue; }
        if (replied === null) { await fire(s, "message", `${s.text}\n(I couldn't check whether ${sp.unless_reply_from} replied.)`); continue; }
      }
      await fire(s, s.kind, s.text);
    } catch (e: any) { console.error(`[schedule] ${s.id} failed: ${e.message}`); }
  }
}
