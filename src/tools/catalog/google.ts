import { n, num, obj, s, str, type ToolContext, type ToolDef, type ToolResult } from "../kit.ts";
import { clip, notConnected } from "./shared.ts";

/**
 * Fo's "google" family, 26 tools over one connection per person: Gmail, Calendar, Drive, Sheets,
 * Forms and Slides through the REST APIs. The credential (a refresh token the OAuth flow stored)
 * never reaches the model: every call runs inside vault.use.
 */
const CAL = "https://www.googleapis.com/calendar/v3";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE = "https://www.googleapis.com/drive/v3";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const FORMS = "https://forms.googleapis.com/v1/forms";
const SLIDES = "https://slides.googleapis.com/v1/presentations";

type Req = Parameters<ToolContext["hands"]["google"]["request"]>[1];
const list = (description: string) => ({ type: "array", items: { type: "string" }, description });

async function g<T = unknown>(ctx: ToolContext, req: Req): Promise<T> {
  const out = await ctx.vault.use("google", (cred) => ctx.hands.google.request(cred, req));
  if (out === undefined) throw new Error("Google is not connected");
  return out as T;
}
const connected = (ctx: ToolContext) => ctx.vault.has("google");
const who = (ctx: ToolContext) => ctx.store.getPerson(ctx.accountOwnerId)?.displayName ?? "the account owner";

/** A write on someone's account by someone else asks that person first; on your own account it just happens. */
function guard(ctx: ToolContext, title: string, detail: string, key: unknown[]): ToolResult | undefined {
  if (ctx.requesterId === ctx.accountOwnerId) return undefined;
  const gate = ctx.gate({ kind: "action", title, detail, key });
  if (gate.granted) return undefined;
  if ("held" in gate) return { ok: true, content: gate.held, held: true };
  return { ok: true, content: `Asked ${who(ctx)} before touching their account.`, waitingOn: gate.item, roomNotice: gate.notice };
}

const fail = (e: unknown): ToolResult => ({ ok: false, content: `Google said: ${String((e as Error).message).slice(0, 300)}` });

/** Decode a Gmail message into plain text. */
function gmailText(msg: { payload?: { mimeType?: string; body?: { data?: string }; parts?: unknown[] } }): string {
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
const header = (msg: { payload?: { headers?: { name: string; value: string }[] } }, name: string) =>
  msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

async function labelId(ctx: ToolContext, name: string, create: boolean): Promise<string | undefined> {
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

export const GOOGLE_TOOLS: ToolDef[] = [
  // ---------------------------------------------------------------- Calendar
  {
    spec: {
      name: "list_events",
      description: "Events on the person's Google Calendar in a window.",
      input_schema: obj({
        timeMin: str("ISO start, default now."),
        timeMax: str("ISO end, default +7 days."),
        query: str("Optional text match."),
        calendarId: str("Default primary."),
      }),
    },
    family: "google",
    labels: { running: "Reading your calendar…", done: "Read your calendar" },
    sideEffect: false,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const timeMin = s(input.timeMin) || new Date(ctx.clock.now()).toISOString();
      const timeMax = s(input.timeMax) || new Date(ctx.clock.now() + 7 * 86_400_000).toISOString();
      try {
        const r = await g<{
          items?: {
            id: string;
            summary?: string;
            start?: { dateTime?: string; date?: string };
            end?: { dateTime?: string; date?: string };
            location?: string;
            attendees?: { email: string }[];
          }[];
        }>(ctx, {
          method: "GET",
          url: `${CAL}/calendars/${encodeURIComponent(s(input.calendarId) || "primary")}/events`,
          query: { timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "50", q: s(input.query) || undefined },
        });
        return {
          ok: true,
          content: (r.items ?? []).map((e) => ({
            id: e.id,
            title: e.summary,
            start: e.start?.dateTime ?? e.start?.date,
            end: e.end?.dateTime ?? e.end?.date,
            location: e.location,
            attendees: e.attendees?.map((a) => a.email),
          })),
          evidence: "google:calendar:list",
        };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "create_calendar",
      description: 'Make a new Google Calendar (e.g. "Tahoe trip") on the person\'s account.',
      input_schema: obj({ name: str("Calendar name."), timeZone: str("IANA zone, optional.") }, ["name"]),
    },
    family: "google",
    labels: { running: "Creating a calendar…", done: "Created a calendar" },
    sideEffect: true,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const held = guard(ctx, `OK to create calendar "${s(input.name)}"?`, `On ${who(ctx)}'s Google account.`, ["create_calendar", s(input.name)]);
      if (held) return held;
      try {
        const r = await g<{ id: string }>(ctx, {
          method: "POST",
          url: `${CAL}/calendars`,
          body: { summary: s(input.name), timeZone: s(input.timeZone) || ctx.store.getPerson(ctx.accountOwnerId)?.timezone },
        });
        return { ok: true, content: { calendarId: r.id }, evidence: `google:calendar:${r.id}` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "check_availability",
      description: "Is the person free between two times? Returns the busy blocks in that window.",
      input_schema: obj({ timeMin: str("ISO start."), timeMax: str("ISO end."), calendarId: str("Default primary.") }, ["timeMin", "timeMax"]),
    },
    family: "google",
    labels: { running: "Checking availability…", done: "Checked availability" },
    sideEffect: false,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      try {
        const id = s(input.calendarId) || "primary";
        const r = await g<{ calendars?: Record<string, { busy?: { start: string; end: string }[] }> }>(ctx, {
          method: "POST",
          url: `${CAL}/freeBusy`,
          body: { timeMin: s(input.timeMin), timeMax: s(input.timeMax), items: [{ id }] },
        });
        const busy = r.calendars?.[id]?.busy ?? [];
        return { ok: true, content: { free: busy.length === 0, busy }, evidence: "google:freebusy" };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "find_mutual_availability",
      description: "Find times when several people are all free, from their Google calendars (they must share free/busy with the person).",
      input_schema: obj(
        {
          emails: list("Calendar emails to check, including the person's own."),
          timeMin: str("ISO start."),
          timeMax: str("ISO end."),
          minutes: num("Slot length, default 60."),
          workStart: num("Working hours start, default 9."),
          workEnd: num("Working hours end, default 18."),
        },
        ["emails", "timeMin", "timeMax"],
      ),
    },
    family: "google",
    labels: { running: "Finding a time…", done: "Found a time" },
    sideEffect: false,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const emails = (Array.isArray(input.emails) ? input.emails : []).map((x) => s(x)).filter(Boolean);
      if (!emails.length) return { ok: false, content: "Give at least one calendar email." };
      try {
        const r = await g<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>(ctx, {
          method: "POST",
          url: `${CAL}/freeBusy`,
          body: { timeMin: s(input.timeMin), timeMax: s(input.timeMax), items: emails.map((id) => ({ id })) },
        });
        const busy = Object.values(r.calendars ?? {}).flatMap((c) => (c.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })));
        const unreadable = Object.entries(r.calendars ?? {})
          .filter(([, c]) => c.errors?.length)
          .map(([k]) => k);
        const zone = ctx.store.getPerson(ctx.accountOwnerId)?.timezone ?? "UTC";
        const slots = freeSlots(
          busy,
          { start: Date.parse(s(input.timeMin)), end: Date.parse(s(input.timeMax)) },
          n(input.minutes) ?? 60,
          { start: n(input.workStart) ?? 9, end: n(input.workEnd) ?? 18 },
          zone,
        );
        return {
          ok: true,
          content: { slots: slots.map((x) => ({ start: new Date(x.start).toISOString(), end: new Date(x.end).toISOString() })), unreadable },
          evidence: "google:freebusy",
        };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "create_event",
      description: "Put an event on the person's Google Calendar. Inviting attendees emails them, so that asks first.",
      input_schema: obj(
        {
          title: str("Title."),
          start: str("ISO start."),
          end: str("ISO end."),
          location: str("Optional."),
          description: str("Optional."),
          attendees: list("Emails to invite, optional."),
          calendarId: str("Default primary."),
        },
        ["title", "start", "end"],
      ),
    },
    family: "google",
    labels: { running: "Adding to the calendar…", done: "Added to the calendar" },
    sideEffect: true,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const attendees = (Array.isArray(input.attendees) ? input.attendees : []).map((x) => s(x)).filter(Boolean);
      if (attendees.length) {
        const gate = ctx.gate({
          kind: "outreach_approval",
          title: `OK to invite ${attendees.join(", ")} to "${s(input.title)}"?`,
          detail: `${s(input.start)} to ${s(input.end)}${s(input.location) ? ` at ${s(input.location)}` : ""}. Google will email them the invitation.`,
          outreach: { who: attendees.join(", "), how: "email", contact: attendees.join(",") },
          key: ["create_event", s(input.title), s(input.start), attendees],
        });
        if (!gate.granted) {
          if ("held" in gate) return { ok: true, content: gate.held, held: true };
          return { ok: true, content: "Waiting for the OK before inviting anyone.", waitingOn: gate.item, roomNotice: gate.notice };
        }
      } else {
        const held = guard(ctx, `OK to add "${s(input.title)}" to your calendar?`, `${s(input.start)} to ${s(input.end)}.`, ["create_event", s(input.title), s(input.start)]);
        if (held) return held;
      }
      try {
        const zone = ctx.store.getPerson(ctx.accountOwnerId)?.timezone;
        const r = await g<{ id: string; htmlLink?: string }>(ctx, {
          method: "POST",
          url: `${CAL}/calendars/${encodeURIComponent(s(input.calendarId) || "primary")}/events`,
          query: attendees.length ? { sendUpdates: "all" } : undefined,
          body: {
            summary: s(input.title),
            location: s(input.location) || undefined,
            description: s(input.description) || undefined,
            start: { dateTime: s(input.start), timeZone: zone },
            end: { dateTime: s(input.end), timeZone: zone },
            attendees: attendees.map((email) => ({ email })),
          },
        });
        return { ok: true, content: { eventId: r.id, link: r.htmlLink }, evidence: `google:event:${r.id}`, label: `Added "${s(input.title).slice(0, 40)}"` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "update_event",
      description: "Change an event's title, time, place or description.",
      input_schema: obj(
        {
          eventId: str("Event id."),
          title: str("New title."),
          start: str("New ISO start."),
          end: str("New ISO end."),
          location: str("New location."),
          description: str("New description."),
          calendarId: str("Default primary."),
        },
        ["eventId"],
      ),
    },
    family: "google",
    labels: { running: "Updating the event…", done: "Updated the event" },
    sideEffect: true,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const held = guard(
        ctx,
        "OK to change an event on your calendar?",
        `Event ${s(input.eventId)}: ${[s(input.title), s(input.start), s(input.location)].filter(Boolean).join(", ")}`,
        ["update_event", s(input.eventId), input],
      );
      if (held) return held;
      const zone = ctx.store.getPerson(ctx.accountOwnerId)?.timezone;
      const body: Record<string, unknown> = {};
      if (s(input.title)) body.summary = s(input.title);
      if (s(input.location)) body.location = s(input.location);
      if (s(input.description)) body.description = s(input.description);
      if (s(input.start)) body.start = { dateTime: s(input.start), timeZone: zone };
      if (s(input.end)) body.end = { dateTime: s(input.end), timeZone: zone };
      try {
        const r = await g<{ id: string }>(ctx, {
          method: "PATCH",
          url: `${CAL}/calendars/${encodeURIComponent(s(input.calendarId) || "primary")}/events/${encodeURIComponent(s(input.eventId))}`,
          body,
        });
        return { ok: true, content: { eventId: r.id }, evidence: `google:event:${r.id}:updated` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "delete_event",
      description: "Remove an event from the person's calendar.",
      input_schema: obj({ eventId: str("Event id."), calendarId: str("Default primary.") }, ["eventId"]),
    },
    family: "google",
    labels: { running: "Removing the event…", done: "Removed the event" },
    sideEffect: true,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const held = guard(ctx, "OK to delete an event from your calendar?", `Event ${s(input.eventId)}.`, ["delete_event", s(input.eventId)]);
      if (held) return held;
      try {
        await g(ctx, { method: "DELETE", url: `${CAL}/calendars/${encodeURIComponent(s(input.calendarId) || "primary")}/events/${encodeURIComponent(s(input.eventId))}` });
        return { ok: true, content: "Deleted.", evidence: `google:event:${s(input.eventId)}:deleted` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "move_events",
      description: "Move events to another of the person's calendars.",
      input_schema: obj({ eventIds: list("Event ids."), fromCalendarId: str("Default primary."), toCalendarId: str("Destination calendar id.") }, ["eventIds", "toCalendarId"]),
    },
    family: "google",
    labels: { running: "Moving events…", done: "Moved events" },
    sideEffect: true,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const ids = (Array.isArray(input.eventIds) ? input.eventIds : []).map((x) => s(x)).filter(Boolean);
      const held = guard(ctx, `OK to move ${ids.length} events?`, `To calendar ${s(input.toCalendarId)}.`, ["move_events", ids, s(input.toCalendarId)]);
      if (held) return held;
      const moved: string[] = [];
      try {
        for (const id of ids.slice(0, 50)) {
          await g(ctx, {
            method: "POST",
            url: `${CAL}/calendars/${encodeURIComponent(s(input.fromCalendarId) || "primary")}/events/${encodeURIComponent(id)}/move`,
            query: { destination: s(input.toCalendarId) },
          });
          moved.push(id);
        }
        return { ok: true, content: { moved }, evidence: `google:events:moved:${moved.length}` };
      } catch (e) {
        return { ...fail(e), content: `${fail(e).content} (moved ${moved.length} first)` };
      }
    },
  },
  // ---------------------------------------------------------------- Gmail
  {
    spec: {
      name: "search_emails",
      description: "Search the person's Gmail (Gmail query syntax: from:, subject:, newer_than:7d…).",
      input_schema: obj({ query: str("Gmail search."), limit: num("Default 10.") }, ["query"]),
    },
    family: "google",
    labels: { running: "Searching your inbox…", done: "Searched your inbox" },
    sideEffect: false,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      try {
        const r = await g<{ messages?: { id: string; threadId: string }[] }>(ctx, {
          method: "GET",
          url: `${GMAIL}/messages`,
          query: { q: s(input.query), maxResults: String(n(input.limit) ?? 10) },
        });
        const out = [];
        for (const m of (r.messages ?? []).slice(0, 20)) {
          const full = await g<{ id: string; threadId: string; snippet?: string; payload?: { headers?: { name: string; value: string }[] } }>(ctx, {
            method: "GET",
            url: `${GMAIL}/messages/${m.id}`,
            query: { format: "metadata", metadataHeaders: "From" },
          });
          const meta = await g<{ payload?: { headers?: { name: string; value: string }[] } }>(ctx, {
            method: "GET",
            url: `${GMAIL}/messages/${m.id}`,
            query: { format: "metadata" },
          }).catch(() => full);
          out.push({
            id: m.id,
            threadId: m.threadId,
            from: header(meta, "From") ?? header(full, "From"),
            subject: header(meta, "Subject"),
            date: header(meta, "Date"),
            snippet: full.snippet,
          });
        }
        return { ok: true, content: out, evidence: "google:gmail:search", label: `Searched inbox: ${s(input.query).slice(0, 40)}` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: { name: "get_email_content", description: "Read one email in full.", input_schema: obj({ messageId: str("Message id.") }, ["messageId"]) },
    family: "google",
    labels: { running: "Reading email…", done: "Read email" },
    sideEffect: false,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      try {
        const m = await g<{
          id: string;
          threadId: string;
          payload?: { headers?: { name: string; value: string }[]; mimeType?: string; body?: { data?: string }; parts?: unknown[] };
        }>(ctx, { method: "GET", url: `${GMAIL}/messages/${encodeURIComponent(s(input.messageId))}`, query: { format: "full" } });
        return {
          ok: true,
          content: {
            id: m.id,
            threadId: m.threadId,
            from: header(m, "From"),
            to: header(m, "To"),
            subject: header(m, "Subject"),
            date: header(m, "Date"),
            text: clip(gmailText(m), 12_000),
          },
          evidence: `google:gmail:${m.id}`,
        };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "label_email",
      description: "Add a label to an email (created if it does not exist).",
      input_schema: obj({ messageId: str("Message id."), label: str("Label name.") }, ["messageId", "label"]),
    },
    family: "google",
    labels: { running: "Labelling email…", done: "Labelled email" },
    sideEffect: true,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const held = guard(ctx, `OK to label an email "${s(input.label)}"?`, `Message ${s(input.messageId)}.`, ["label_email", s(input.messageId), s(input.label)]);
      if (held) return held;
      try {
        const id = await labelId(ctx, s(input.label), true);
        await g(ctx, { method: "POST", url: `${GMAIL}/messages/${encodeURIComponent(s(input.messageId))}/modify`, body: { addLabelIds: [id] } });
        return { ok: true, content: `Labelled "${s(input.label)}".`, evidence: `google:gmail:label:${id}` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: { name: "archive_email", description: "Archive an email (remove it from the inbox).", input_schema: obj({ messageId: str("Message id.") }, ["messageId"]) },
    family: "google",
    labels: { running: "Archiving email…", done: "Archived email" },
    sideEffect: false,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const held = guard(ctx, "OK to archive an email?", `Message ${s(input.messageId)}.`, ["archive_email", s(input.messageId)]);
      if (held) return held;
      try {
        await g(ctx, { method: "POST", url: `${GMAIL}/messages/${encodeURIComponent(s(input.messageId))}/modify`, body: { removeLabelIds: ["INBOX"] } });
        return { ok: true, content: "Archived.", evidence: `google:gmail:archived:${s(input.messageId)}` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "remove_email_label",
      description: "Remove a label from an email.",
      input_schema: obj({ messageId: str("Message id."), label: str("Label name or id.") }, ["messageId", "label"]),
    },
    family: "google",
    labels: { running: "Removing a label…", done: "Removed a label" },
    sideEffect: true,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const held = guard(ctx, "OK to remove a label from an email?", `Message ${s(input.messageId)}, label ${s(input.label)}.`, [
        "remove_email_label",
        s(input.messageId),
        s(input.label),
      ]);
      if (held) return held;
      try {
        const id = await labelId(ctx, s(input.label), false);
        if (!id) return { ok: false, content: "No such label." };
        await g(ctx, { method: "POST", url: `${GMAIL}/messages/${encodeURIComponent(s(input.messageId))}/modify`, body: { removeLabelIds: [id] } });
        return { ok: true, content: "Label removed.", evidence: `google:gmail:unlabel:${id}` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "send_email_as_user",
      description:
        "Send an email from the person's own Gmail, as them. Only when they have switched on \"send as me\" in Settings; otherwise use send_agent_email (from the assistant's address, cc them). Asks first every time.",
      input_schema: obj(
        { to: list("Recipients."), subject: str("Subject."), text: str("Plain-text body."), cc: list("Cc, optional."), threadId: str("Reply in this Gmail thread, optional.") },
        ["to", "subject", "text"],
      ),
    },
    family: "google",
    labels: { running: "Sending from your Gmail…", done: "Sent from your Gmail" },
    sideEffect: true,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const person = ctx.store.getPerson(ctx.accountOwnerId);
      if (!person?.sendAsMe)
        return {
          ok: false,
          content: `${person?.displayName ?? "The account owner"} has not allowed sending as them (Settings → Connections → "Send email as me"). Use send_agent_email instead, with them in cc.`,
        };
      const to = (Array.isArray(input.to) ? input.to : []).map((x) => s(x).trim()).filter((x) => /^[^@\s]+@[^@\s]+$/.test(x));
      if (!to.length) return { ok: false, content: "Give at least one valid email address." };
      const cc = (Array.isArray(input.cc) ? input.cc : []).map((x) => s(x).trim()).filter((x) => /^[^@\s]+@[^@\s]+$/.test(x));
      const everyone = [...to, ...cc];
      const gate = ctx.gate({
        kind: "outreach_approval",
        title: `OK to email ${everyone.join(", ")} as you?`,
        detail: `From your Gmail\nSubject: ${s(input.subject)}\n\n${s(input.text).slice(0, 1500)}`,
        outreach: { who: everyone.join(", "), how: "email", contact: everyone.join(",") },
        key: ["send_email_as_user", to, cc, s(input.subject), s(input.text)],
      });
      if (!gate.granted) {
        if ("held" in gate) return { ok: true, content: gate.held, held: true };
        return { ok: true, content: "Waiting for the go-ahead. Nothing was sent.", waitingOn: gate.item, roomNotice: gate.notice };
      }
      // Headers, one blank line, then the body as given: a body that starts with "Bcc:" stays body.
      const headers = [
        `To: ${to.join(", ")}`,
        cc.length ? `Cc: ${cc.join(", ")}` : "",
        `Subject: ${s(input.subject).replace(/[\r\n]/g, " ")}`,
        "Content-Type: text/plain; charset=utf-8",
      ].filter(Boolean);
      const mime = [...headers, "", s(input.text)].join("\r\n");
      try {
        const r = await g<{ id: string }>(ctx, {
          method: "POST",
          url: `${GMAIL}/messages/send`,
          body: { raw: Buffer.from(mime).toString("base64url"), threadId: s(input.threadId) || undefined },
        });
        return { ok: true, content: `Sent as ${person.displayName}.`, evidence: `google:gmail:sent:${r.id}`, label: `Emailed ${to[0]} as ${person.displayName}` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  // ---------------------------------------------------------------- Drive
  {
    spec: {
      name: "find_files",
      description: "Search the person's Google Drive by name or content.",
      input_schema: obj({ query: str("Words to search for."), limit: num("Default 10.") }, ["query"]),
    },
    family: "google",
    labels: { running: "Searching Drive…", done: "Searched Drive" },
    sideEffect: false,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const q = s(input.query).replace(/'/g, "\\'");
      try {
        const r = await g<{ files?: { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string }[] }>(ctx, {
          method: "GET",
          url: `${DRIVE}/files`,
          query: {
            q: `(name contains '${q}' or fullText contains '${q}') and trashed = false`,
            pageSize: String(n(input.limit) ?? 10),
            fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
          },
        });
        return { ok: true, content: r.files ?? [], evidence: "google:drive:search", label: `Searched Drive: ${s(input.query).slice(0, 40)}` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "list_in_folder",
      description: "List what is in a Drive folder.",
      input_schema: obj({ folderId: str("Folder id, or 'root'."), limit: num("Default 50.") }, ["folderId"]),
    },
    family: "google",
    labels: { running: "Listing a folder…", done: "Listed a folder" },
    sideEffect: false,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      try {
        const r = await g<{ files?: unknown[] }>(ctx, {
          method: "GET",
          url: `${DRIVE}/files`,
          query: {
            q: `'${s(input.folderId).replace(/'/g, "")}' in parents and trashed = false`,
            pageSize: String(n(input.limit) ?? 50),
            fields: "files(id,name,mimeType,modifiedTime,webViewLink,size)",
          },
        });
        return { ok: true, content: r.files ?? [], evidence: "google:drive:list" };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "get_metadata",
      description: "Details of a Drive file: owner, size, when changed, who it is shared with.",
      input_schema: obj({ fileId: str("File id.") }, ["fileId"]),
    },
    family: "google",
    labels: { running: "Reading file metadata…", done: "Read file metadata" },
    sideEffect: false,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      try {
        const r = await g(ctx, {
          method: "GET",
          url: `${DRIVE}/files/${encodeURIComponent(s(input.fileId))}`,
          query: { fields: "id,name,mimeType,size,createdTime,modifiedTime,owners,permissions,webViewLink,parents" },
        });
        return { ok: true, content: r, evidence: `google:drive:${s(input.fileId)}` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "share",
      description: "Share a Drive file with someone (Google emails them). Asks first.",
      input_schema: obj(
        {
          fileId: str("File id."),
          email: str("Who to share with."),
          role: { type: "string", enum: ["reader", "commenter", "writer"], description: "Default reader." },
          message: str("Optional note in the email."),
        },
        ["fileId", "email"],
      ),
    },
    family: "google",
    labels: { running: "Sharing a file…", done: "Shared a file" },
    sideEffect: true,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const gate = ctx.gate({
        kind: "outreach_approval",
        title: `OK to share a file with ${s(input.email)}?`,
        detail: `File ${s(input.fileId)} as ${s(input.role) || "reader"}. Google will email them.`,
        outreach: { who: s(input.email), how: "email", contact: s(input.email) },
        key: ["share", s(input.fileId), s(input.email), s(input.role)],
      });
      if (!gate.granted) {
        if ("held" in gate) return { ok: true, content: gate.held, held: true };
        return { ok: true, content: "Waiting for the OK before sharing.", waitingOn: gate.item, roomNotice: gate.notice };
      }
      try {
        await g(ctx, {
          method: "POST",
          url: `${DRIVE}/files/${encodeURIComponent(s(input.fileId))}/permissions`,
          query: { sendNotificationEmail: "true", emailMessage: s(input.message) || undefined },
          body: { type: "user", role: s(input.role) || "reader", emailAddress: s(input.email) },
        });
        return { ok: true, content: `Shared with ${s(input.email)}.`, evidence: `google:drive:shared:${s(input.fileId)}` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "create_form",
      description: "Make a Google Form (a poll for the group, an RSVP, a sign-up) with questions. Returns the link to fill it in.",
      input_schema: obj(
        {
          title: str("Form title."),
          questions: {
            type: "array",
            items: obj({ text: str("The question."), options: list("Choices; empty for a text answer."), required: { type: "boolean" } }, ["text"]),
            description: "Questions in order.",
          },
        },
        ["title"],
      ),
    },
    family: "google",
    labels: { running: "Making a form…", done: "Made a form" },
    sideEffect: true,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const held = guard(ctx, `OK to create a form "${s(input.title)}" on your Drive?`, "", ["create_form", s(input.title)]);
      if (held) return held;
      try {
        const form = await g<{ formId: string; responderUri?: string }>(ctx, { method: "POST", url: FORMS, body: { info: { title: s(input.title) } } });
        const qs = Array.isArray(input.questions) ? (input.questions as { text?: unknown; options?: unknown; required?: unknown }[]) : [];
        const requests = qs.slice(0, 30).map((q, i) => {
          const options = (Array.isArray(q.options) ? q.options : []).map((o) => s(o)).filter(Boolean);
          return {
            createItem: {
              location: { index: i },
              item: {
                title: s(q.text),
                questionItem: {
                  question: {
                    required: !!q.required,
                    ...(options.length ? { choiceQuestion: { type: "RADIO", options: options.map((value) => ({ value })) } } : { textQuestion: {} }),
                  },
                },
              },
            },
          };
        });
        if (requests.length) await g(ctx, { method: "POST", url: `${FORMS}/${form.formId}:batchUpdate`, body: { requests } });
        const again = await g<{ responderUri?: string }>(ctx, { method: "GET", url: `${FORMS}/${form.formId}` }).catch(() => form);
        return {
          ok: true,
          content: { formId: form.formId, fillInUrl: again.responderUri ?? form.responderUri },
          evidence: `google:form:${form.formId}`,
          label: `Made form "${s(input.title).slice(0, 40)}"`,
        };
      } catch (e) {
        return fail(e);
      }
    },
  },
  // ---------------------------------------------------------------- Sheets
  {
    spec: {
      name: "get_spreadsheet",
      description: "Read cells from a Google Sheet.",
      input_schema: obj({ spreadsheetId: str("Spreadsheet id."), range: str("A1 range, e.g. Sheet1!A1:D50; default the first sheet.") }, ["spreadsheetId"]),
    },
    family: "google",
    labels: { running: "Reading spreadsheet…", done: "Read spreadsheet" },
    sideEffect: false,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      try {
        const range = s(input.range) || "A1:Z200";
        const r = await g<{ values?: unknown[][] }>(ctx, { method: "GET", url: `${SHEETS}/${encodeURIComponent(s(input.spreadsheetId))}/values/${encodeURIComponent(range)}` });
        return { ok: true, content: { range, values: (r.values ?? []).slice(0, 500) }, evidence: `google:sheet:${s(input.spreadsheetId)}` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "update_spreadsheet",
      description: "Write cells into a Google Sheet (rows of values at an A1 range).",
      input_schema: obj(
        {
          spreadsheetId: str("Spreadsheet id."),
          range: str("A1 range to write at, e.g. Sheet1!A2."),
          values: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Rows of cells." },
        },
        ["spreadsheetId", "range", "values"],
      ),
    },
    family: "google",
    labels: { running: "Updating spreadsheet…", done: "Updated spreadsheet" },
    sideEffect: true,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const held = guard(ctx, "OK to write to your spreadsheet?", `${s(input.spreadsheetId)} at ${s(input.range)}.`, [
        "update_spreadsheet",
        s(input.spreadsheetId),
        s(input.range),
        input.values,
      ]);
      if (held) return held;
      try {
        const r = await g<{ updatedCells?: number }>(ctx, {
          method: "PUT",
          url: `${SHEETS}/${encodeURIComponent(s(input.spreadsheetId))}/values/${encodeURIComponent(s(input.range))}`,
          query: { valueInputOption: "USER_ENTERED" },
          body: { values: Array.isArray(input.values) ? input.values : [] },
        });
        return { ok: true, content: { updatedCells: r.updatedCells }, evidence: `google:sheet:${s(input.spreadsheetId)}:updated` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: { name: "search_user_spreadsheets", description: "Find the person's Google Sheets by name.", input_schema: obj({ query: str("Part of the name; empty for recent.") }) },
    family: "google",
    labels: { running: "Searching spreadsheets…", done: "Searched spreadsheets" },
    sideEffect: false,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const q = s(input.query).replace(/'/g, "\\'");
      try {
        const r = await g<{ files?: unknown[] }>(ctx, {
          method: "GET",
          url: `${DRIVE}/files`,
          query: {
            q: `mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false${q ? ` and name contains '${q}'` : ""}`,
            orderBy: "modifiedTime desc",
            pageSize: "20",
            fields: "files(id,name,modifiedTime,webViewLink)",
          },
        });
        return { ok: true, content: r.files ?? [], evidence: "google:drive:sheets" };
      } catch (e) {
        return fail(e);
      }
    },
  },
  // ---------------------------------------------------------------- Slides
  {
    spec: {
      name: "get_slide_thumbnail",
      description: "A picture of one slide of a Google Slides deck.",
      input_schema: obj({ presentationId: str("Presentation id."), pageObjectId: str("Slide id; empty for the first slide.") }, ["presentationId"]),
    },
    family: "google",
    labels: { running: "Fetching a slide…", done: "Fetched a slide" },
    sideEffect: false,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      try {
        let page = s(input.pageObjectId);
        if (!page) {
          const deck = await g<{ slides?: { objectId: string }[] }>(ctx, {
            method: "GET",
            url: `${SLIDES}/${encodeURIComponent(s(input.presentationId))}`,
            query: { fields: "slides(objectId)" },
          });
          page = deck.slides?.[0]?.objectId ?? "";
        }
        const r = await g<{ contentUrl?: string }>(ctx, {
          method: "GET",
          url: `${SLIDES}/${encodeURIComponent(s(input.presentationId))}/pages/${encodeURIComponent(page)}/thumbnail`,
        });
        return { ok: true, content: { pageObjectId: page, imageUrl: r.contentUrl }, evidence: `google:slides:${page}` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "append_slides",
      description: "Add slides (title and body text each) to the end of a Google Slides deck.",
      input_schema: obj(
        {
          presentationId: str("Presentation id."),
          slides: { type: "array", items: obj({ title: str("Slide title."), body: str("Body text.") }, ["title"]), description: "Slides to add." },
        },
        ["presentationId", "slides"],
      ),
    },
    family: "google",
    labels: { running: "Adding slides…", done: "Added slides" },
    sideEffect: false,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const held = guard(ctx, "OK to add slides to your deck?", s(input.presentationId), ["append_slides", s(input.presentationId), input.slides]);
      if (held) return held;
      const slides = Array.isArray(input.slides) ? (input.slides as { title?: unknown; body?: unknown }[]) : [];
      const requests: unknown[] = [];
      const ids: string[] = [];
      slides.slice(0, 20).forEach((sl, i) => {
        const id = `s_${Date.now().toString(36)}_${i}`;
        ids.push(id);
        requests.push({
          createSlide: {
            objectId: id,
            slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
            placeholderIdMappings: [
              { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: `${id}_t` },
              { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: `${id}_b` },
            ],
          },
        });
        requests.push({ insertText: { objectId: `${id}_t`, text: s(sl.title) } });
        if (s(sl.body)) requests.push({ insertText: { objectId: `${id}_b`, text: s(sl.body) } });
      });
      try {
        await g(ctx, { method: "POST", url: `${SLIDES}/${encodeURIComponent(s(input.presentationId))}:batchUpdate`, body: { requests } });
        return { ok: true, content: { slideIds: ids }, evidence: `google:slides:added:${ids.length}` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "replace_slide",
      description: "Replace one slide's content with a new title and body.",
      input_schema: obj({ presentationId: str("Presentation id."), pageObjectId: str("Slide id to replace."), title: str("New title."), body: str("New body.") }, [
        "presentationId",
        "pageObjectId",
        "title",
      ]),
    },
    family: "google",
    labels: { running: "Updating slide…", done: "Updated slide" },
    sideEffect: false,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const held = guard(ctx, "OK to change a slide in your deck?", s(input.pageObjectId), ["replace_slide", s(input.presentationId), s(input.pageObjectId), s(input.title)]);
      if (held) return held;
      const id = `s_${Date.now().toString(36)}`;
      try {
        const deck = await g<{ slides?: { objectId: string }[] }>(ctx, {
          method: "GET",
          url: `${SLIDES}/${encodeURIComponent(s(input.presentationId))}`,
          query: { fields: "slides(objectId)" },
        });
        const index = Math.max(
          0,
          (deck.slides ?? []).findIndex((x) => x.objectId === s(input.pageObjectId)),
        );
        await g(ctx, {
          method: "POST",
          url: `${SLIDES}/${encodeURIComponent(s(input.presentationId))}:batchUpdate`,
          body: {
            requests: [
              {
                createSlide: {
                  objectId: id,
                  insertionIndex: index,
                  slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
                  placeholderIdMappings: [
                    { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: `${id}_t` },
                    { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: `${id}_b` },
                  ],
                },
              },
              { insertText: { objectId: `${id}_t`, text: s(input.title) } },
              ...(s(input.body) ? [{ insertText: { objectId: `${id}_b`, text: s(input.body) } }] : []),
              { deleteObject: { objectId: s(input.pageObjectId) } },
            ],
          },
        });
        return { ok: true, content: { slideId: id }, evidence: `google:slides:replaced:${s(input.pageObjectId)}` };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    spec: {
      name: "delete_slide",
      description: "Delete one slide from a deck.",
      input_schema: obj({ presentationId: str("Presentation id."), pageObjectId: str("Slide id.") }, ["presentationId", "pageObjectId"]),
    },
    family: "google",
    labels: { running: "Removing slide…", done: "Removed slide" },
    sideEffect: false,
    async run(input, ctx) {
      if (!connected(ctx)) return notConnected(ctx, "Google");
      const held = guard(ctx, "OK to delete a slide from your deck?", s(input.pageObjectId), ["delete_slide", s(input.presentationId), s(input.pageObjectId)]);
      if (held) return held;
      try {
        await g(ctx, {
          method: "POST",
          url: `${SLIDES}/${encodeURIComponent(s(input.presentationId))}:batchUpdate`,
          body: { requests: [{ deleteObject: { objectId: s(input.pageObjectId) } }] },
        });
        return { ok: true, content: "Deleted.", evidence: `google:slides:deleted:${s(input.pageObjectId)}` };
      } catch (e) {
        return fail(e);
      }
    },
  },
];
