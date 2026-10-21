import { askFirst, n, num, obj, s, str, type ToolDef } from "../../kit.ts";
import { CAL, fail, freeSlots, g, guard, list, who, gtool } from "./shared.ts";

const defs: ToolDef[] = [
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
      const timeMin = s(input.timeMin) || new Date(ctx.clock.now()).toISOString();
      const timeMax = s(input.timeMax) || new Date(ctx.clock.now() + 7 * 86_400_000).toISOString();
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
      const held = guard(ctx, `OK to create calendar "${s(input.name)}"?`, `On ${who(ctx)}'s Google account.`, ["create_calendar", s(input.name)]);
      if (held) return held;
      const r = await g<{ id: string }>(ctx, {
        method: "POST",
        url: `${CAL}/calendars`,
        body: { summary: s(input.name), timeZone: s(input.timeZone) || ctx.store.getPerson(ctx.accountOwnerId)?.timezone },
      });
      return { ok: true, content: { calendarId: r.id }, evidence: `google:calendar:${r.id}` };
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
      const id = s(input.calendarId) || "primary";
      const r = await g<{ calendars?: Record<string, { busy?: { start: string; end: string }[] }> }>(ctx, {
        method: "POST",
        url: `${CAL}/freeBusy`,
        body: { timeMin: s(input.timeMin), timeMax: s(input.timeMax), items: [{ id }] },
      });
      const busy = r.calendars?.[id]?.busy ?? [];
      return { ok: true, content: { free: busy.length === 0, busy }, evidence: "google:freebusy" };
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
      const emails = (Array.isArray(input.emails) ? input.emails : []).map((x) => s(x)).filter(Boolean);
      if (!emails.length) return { ok: false, content: "Give at least one calendar email." };
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
      const attendees = (Array.isArray(input.attendees) ? input.attendees : []).map((x) => s(x)).filter(Boolean);
      if (attendees.length) {
        const gate = ctx.gate({
          kind: "outreach_approval",
          title: `OK to invite ${attendees.join(", ")} to "${s(input.title)}"?`,
          detail: `${s(input.start)} to ${s(input.end)}${s(input.location) ? ` at ${s(input.location)}` : ""}. Google will email them the invitation.`,
          outreach: { who: attendees.join(", "), how: "email", contact: attendees.join(",") },
          key: ["create_event", s(input.title), s(input.start), attendees],
        });
        const held = askFirst(gate, "Waiting for the OK before inviting anyone.");
        if (held) return held;
      } else {
        const held = guard(ctx, `OK to add "${s(input.title)}" to your calendar?`, `${s(input.start)} to ${s(input.end)}.`, ["create_event", s(input.title), s(input.start)]);
        if (held) return held;
      }
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
      const r = await g<{ id: string }>(ctx, {
        method: "PATCH",
        url: `${CAL}/calendars/${encodeURIComponent(s(input.calendarId) || "primary")}/events/${encodeURIComponent(s(input.eventId))}`,
        body,
      });
      return { ok: true, content: { eventId: r.id }, evidence: `google:event:${r.id}:updated` };
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
      const held = guard(ctx, "OK to delete an event from your calendar?", `Event ${s(input.eventId)}.`, ["delete_event", s(input.eventId)]);
      if (held) return held;
      await g(ctx, { method: "DELETE", url: `${CAL}/calendars/${encodeURIComponent(s(input.calendarId) || "primary")}/events/${encodeURIComponent(s(input.eventId))}` });
      return { ok: true, content: "Deleted.", evidence: `google:event:${s(input.eventId)}:deleted` };
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
];
export const GOOGLE_CALENDAR_TOOLS = defs.map(gtool);
