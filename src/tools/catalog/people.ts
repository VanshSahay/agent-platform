import { newId } from "../../core/ids.ts";
import { n, num, obj, s, str, type ToolDef } from "../kit.ts";
import { notConnected, saveArtifact } from "./shared.ts";

/** Fo's "contacts", "voice", "calls" (the vendor variant) and "wajo" (own email) families. */
export const PEOPLE_TOOLS: ToolDef[] = [
  {
    spec: {
      name: "search_contacts",
      description: "Same as find_person: look up someone the assistant knows by name, email or phone.",
      input_schema: obj({ query: str("Name, email or phone.") }, ["query"]),
    },
    family: "contacts",
    labels: { running: "Looking up contacts…", done: "Looked up your contacts" },
    sideEffect: false,
    async run(input, ctx) {
      const { TOOL_INDEX } = await import("../registry.ts");
      return TOOL_INDEX.get("find_person")!.run(input, ctx);
    },
  },
  {
    spec: {
      name: "add_contact",
      description:
        "Remember a new person (a plumber, the cabin host, a friend of a friend) with their phone or email, so you can reach them later. They are not added to any chat.",
      input_schema: obj(
        { name: str("Their name."), phone: str("Phone in E.164 if known, e.g. +14085550100."), email: str("Email if known."), note: str("One line on who they are.") },
        ["name"],
      ),
    },
    family: "contacts",
    labels: { running: "Adding a contact…", done: "Added a contact" },
    sideEffect: false,
    async run(input, ctx) {
      const name = s(input.name).trim();
      if (!name) return { ok: false, content: "A name is needed." };
      const phone = s(input.phone).replace(/[^+\d]/g, "") || undefined;
      const existing = phone ? ctx.store.findPersonByPhone(phone) : undefined;
      if (existing) return { ok: true, content: `Already known as ${existing.displayName} (${existing.id}).` };
      const p = ctx.rooms.createPerson({
        displayName: name.slice(0, 80),
        timezone: ctx.store.getPerson(ctx.agent.ownerId)?.timezone ?? "UTC",
        phoneE164: phone,
        email: s(input.email) || undefined,
      });
      ctx.memory.write({
        agentId: ctx.agent.id,
        scope: "person",
        scopeId: p.id,
        type: "person",
        text: `${name}${s(input.note) ? `: ${s(input.note)}` : ""}${phone ? ` (phone ${phone})` : ""}${s(input.email) ? ` (email ${s(input.email)})` : ""}`,
        visibleToRooms: [ctx.room.id],
        sourceRunId: ctx.run.id,
      });
      return { ok: true, content: { id: p.id, name: p.displayName }, evidence: `person:${p.id}`, label: `Added ${name}` };
    },
  },
  {
    spec: {
      name: "text_to_speech",
      description: "Turn text into spoken audio (a voice note for the group, a reminder someone prefers to hear). Returns a link to the audio.",
      input_schema: obj({ text: str("What to say."), voiceId: str("Optional voice id.") }, ["text"]),
    },
    family: "voice",
    needs: "speech",
    labels: { running: "Recording…", done: "Recorded a voice note" },
    sideEffect: false,
    async run(input, ctx) {
      const pron = JSON.parse(ctx.store.getKv(`pronunciations:${ctx.agent.id}`) ?? "{}") as Record<string, string>;
      try {
        const r = await ctx.hands.speech.speak({ text: s(input.text).slice(0, 4000), voiceId: s(input.voiceId) || undefined, pronunciations: pron });
        const { id, url } = saveArtifact(ctx, {
          kind: "audio",
          title: `Voice note: ${s(input.text).slice(0, 60)}`,
          data: { base64: r.audioBase64, mimeType: r.mimeType, text: s(input.text) },
        });
        return { ok: true, content: { audioId: id, url }, evidence: r.evidence };
      } catch (e) {
        return { ok: false, content: `Could not record: ${String((e as Error).message).slice(0, 200)}` };
      }
    },
  },
  {
    spec: {
      name: "register_pronunciations",
      description: 'Teach the voice how to say names and words ("Nguyen" → "win"). Applies to every later voice note and call.',
      input_schema: obj(
        { entries: { type: "array", items: obj({ word: str("The word as written."), say: str("How to say it.") }, ["word", "say"]), description: "Words and how to say them." } },
        ["entries"],
      ),
    },
    family: "voice",
    needs: "speech",
    labels: { running: "Saving pronunciations…", done: "Saved pronunciations" },
    sideEffect: false,
    async run(input, ctx) {
      const key = `pronunciations:${ctx.agent.id}`;
      const cur = JSON.parse(ctx.store.getKv(key) ?? "{}") as Record<string, string>;
      for (const e of Array.isArray(input.entries) ? (input.entries as { word?: unknown; say?: unknown }[]) : []) if (s(e.word) && s(e.say)) cur[s(e.word)] = s(e.say);
      ctx.store.setKv(key, JSON.stringify(cur));
      return { ok: true, content: cur };
    },
  },
  {
    spec: { name: "list_sms_groups", description: "The text-message chats (iMessage, SMS, WhatsApp) the assistant is in, with their members.", input_schema: obj({}) },
    family: "voice",
    labels: { running: "Listing text groups…", done: "Listed text groups" },
    sideEffect: false,
    async run(_input, ctx) {
      const rooms = ctx.store.listRooms(ctx.agent.id).filter((r) => ["imessage", "sms", "whatsapp"].includes(r.channel));
      return {
        ok: true,
        content: rooms.map((r) => ({ roomId: r.id, name: r.name, channel: r.channel, members: ctx.rooms.memberIds(r.id).map((id) => ctx.store.getPerson(id)?.displayName ?? id) })),
      };
    },
  },
  {
    spec: {
      name: "place_vendor_call",
      description:
        "Call a business on the owner's behalf with a scripted objective: ask hours, prices, availability, book a slot, confirm an order. Asks first like place_call; the call follows the objective and reports back a summary. Use place_call for people, this for businesses.",
      input_schema: obj(
        {
          vendor: str("The business name."),
          phone: str("Phone in E.164."),
          objective: str("What to find out or arrange, in order, with any hard limits (budget, dates)."),
          language: str("Language to speak, optional."),
          maxMinutes: num("Hang up after this many minutes; default 8."),
        },
        ["vendor", "phone", "objective"],
      ),
    },
    family: "calls",
    needs: "phone",
    labels: { running: "Calling the business…", done: "Called the business", failed: "The call did not get through" },
    sideEffect: true,
    async run(input, ctx) {
      const to = s(input.phone).replace(/[^+\d]/g, "");
      if (!/^\+\d{8,15}$/.test(to)) return { ok: false, content: "Give the phone in E.164, like +14085550100." };
      const gate = ctx.gate({
        kind: "outreach_approval",
        title: `OK to call ${s(input.vendor)}?`,
        detail: `${ctx.agent.name} wants to call ${s(input.vendor)} (${to}) to: ${s(input.objective)}`,
        outreach: { who: s(input.vendor), how: "phone" },
        key: ["place_vendor_call", to, s(input.objective)],
      });
      if (!gate.granted) {
        if ("held" in gate) return { ok: true, content: gate.held, approach: "call", held: true };
        return { ok: true, content: "Waiting for the owner's go-ahead. Nothing has been dialed.", waitingOn: gate.item, roomNotice: gate.notice, approach: "call" };
      }
      const limit = Math.min(20, Math.max(1, n(input.maxMinutes) ?? 8));
      const r = await ctx.hands.phone.call({
        to,
        objective: `${s(input.objective)}\nBe brief and polite; you are calling on behalf of ${ctx.store.getPerson(ctx.agent.ownerId)?.displayName ?? "a customer"}. Hang up after ${limit} minutes.`,
        callerName: ctx.agent.name,
        language: s(input.language) || undefined,
      });
      if (r.status !== "completed")
        return {
          ok: true,
          content: `Call ${r.status}: ${r.summary}`,
          evidence: r.evidence,
          stall: `call ${r.status}`,
          approach: "call",
          label: `Called ${s(input.vendor)} (${r.status})`,
        };
      return {
        ok: true,
        content: { summary: r.summary, durationSeconds: r.durationSeconds, transcript: r.transcript?.slice(0, 40) },
        evidence: r.evidence,
        approach: "call",
        label: `Called ${s(input.vendor)}`,
      };
    },
  },
  {
    spec: {
      name: "send_agent_email",
      description:
        "Send an email from the assistant's own address (never from a person's). Use for vendors, bookings and replies to mail the assistant received; cc the person it is for. Asks first.",
      input_schema: obj(
        {
          to: { type: "array", items: { type: "string" }, description: "Recipients." },
          subject: str("Subject."),
          text: str("Plain-text body."),
          cc: { type: "array", items: { type: "string" }, description: "Cc, optional." },
          replyToMessageId: str("When replying to a received message."),
        },
        ["to", "subject", "text"],
      ),
    },
    family: "email",
    needs: "email",
    labels: { running: "Sending mail…", done: "Sent mail" },
    sideEffect: true,
    async run(input, ctx) {
      const to = (Array.isArray(input.to) ? input.to : []).map((x) => s(x).trim()).filter((x) => /^[^@\s]+@[^@\s]+$/.test(x));
      if (!to.length) return { ok: false, content: "Give at least one valid email address." };
      const cc = (Array.isArray(input.cc) ? input.cc : []).map((x) => s(x).trim()).filter(Boolean);
      const gate = ctx.gate({
        kind: "outreach_approval",
        title: `OK to email ${to.join(", ")}?`,
        detail: `From ${ctx.hands.email.address()}\nSubject: ${s(input.subject)}\n\n${s(input.text).slice(0, 1500)}`,
        outreach: { who: to.join(", "), how: "email" },
        key: ["send_agent_email", to, s(input.subject), s(input.text)],
      });
      if (!gate.granted) {
        if ("held" in gate) return { ok: true, content: gate.held, held: true };
        return { ok: true, content: "Waiting for the owner's go-ahead. Nothing was sent.", waitingOn: gate.item, roomNotice: gate.notice };
      }
      try {
        const r = await ctx.hands.email.send({
          to,
          cc,
          subject: s(input.subject).slice(0, 200),
          text: s(input.text).slice(0, 20_000),
          replyToMessageId: s(input.replyToMessageId) || undefined,
        });
        return {
          ok: true,
          content: `Sent from ${ctx.hands.email.address()} to ${to.join(", ")}.`,
          evidence: r.evidence,
          label: `Emailed ${to[0]}${to.length > 1 ? ` +${to.length - 1}` : ""}`,
        };
      } catch (e) {
        return { ok: false, content: `Could not send: ${String((e as Error).message).slice(0, 200)}` };
      }
    },
  },
];

export { newId as _newId, notConnected as _nc };
