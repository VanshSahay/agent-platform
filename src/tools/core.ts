// The agent's own tools: memory, reminders, its name, room instructions, skills, files, arithmetic, links.
import { def, obj, str, num, ToolError } from "./index";
import { sql, one, fmtLocal, J } from "../db";
import { remember, forget } from "../memory";
import { createSchedule, describeSpec } from "../schedules";
import { makeLink } from "../links";
import { readSkill } from "../skills";
import { revokeConsent } from "../rooms";

def({
  id: "remember", kind: "read", description: "Save something worth keeping: a preference, a fact about someone, a decision. scope private = only for this person (default in a DM, or when it is about the requester themselves); room = everyone in this chat (default in a group).",
  inputSchema: obj({ text: str("one sentence, third person"), scope: { type: "string", enum: ["private", "room"] } }, ["text"]),
  async execute({ text, scope }, ctx) {
    const s = scope ?? (ctx.room.kind === "private" ? "private" : "room");
    return { status: "SUCCEEDED", output: await remember(s, s === "private" ? ctx.requester.id : ctx.room.id, text, ctx.requester.id) };
  },
});
def({
  id: "forget", kind: "read", description: "Delete a saved memory by its id (from the memories shown to you).",
  inputSchema: obj({ memory_id: str() }, ["memory_id"]),
  async execute({ memory_id }) { await forget(memory_id); return { status: "SUCCEEDED", output: { forgotten: memory_id } }; },
});

const WHEN = { at: str("ISO datetime in the person's zone, e.g. 2026-10-14T09:00"), in_minutes: num(), every: { type: "string", enum: ["daily", "weekdays", "weekends", "weekly"] }, days: { type: "array", items: { type: "string", enum: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] } }, time: str("HH:MM 24h") };
def({
  id: "reminder.schedule", kind: "write", description: "Set a reminder or a recurring job in this chat, in the person's time zone. deliver=message sends the text word for word then. deliver=task wakes you up to do work then (a briefing, a check). unless_reply_from=email makes it a follow-up that only fires if that person hasn't emailed back. Confirm the returned time.",
  inputSchema: obj({ text: str(), deliver: { type: "string", enum: ["message", "task"] }, unless_reply_from: str(), ...WHEN }, ["text"]),
  summarize: (i) => `Reminder: "${i.text}" ${i.in_minutes != null ? `in ${i.in_minutes} min` : i.at ? `at ${i.at}` : i.every ? `${i.every}${i.time ? ` at ${i.time}` : ""}` : i.time ? `at ${i.time}` : ""}`.trim(), verify: (o) => o?.reminder_id ?? null,
  async execute(i, ctx) {
    const s = await createSchedule({ roomId: ctx.room.id, userId: ctx.requester.id, text: i.text, kind: i.deliver === "task" ? "task" : "message", when: i, tz: ctx.requester.tz, unlessReplyFrom: i.unless_reply_from });
    return { status: "SUCCEEDED", output: { reminder_id: s.id.slice(-6), next: fmtLocal(s.next_at, ctx.requester.tz), repeats: describeSpec(J(s.spec, {})) } };
  },
});
def({
  id: "reminder.list", kind: "read", description: "Active reminders and recurring jobs in this chat.", inputSchema: obj({}),
  async execute(_i, ctx) {
    const rows = await sql`select * from schedules where room_id=${ctx.room.id} and status='active' order by next_at`;
    return { status: "SUCCEEDED", output: { reminders: rows.map((r: any) => ({ id: r.id.slice(-6), text: r.text, next: fmtLocal(r.next_at, ctx.requester.tz), repeats: describeSpec(J(r.spec, {})) })) } };
  },
});
def({
  id: "reminder.cancel", kind: "read", description: "Cancel a reminder in this chat by its id (from reminder.list) or words from its text.",
  inputSchema: obj({ ref: str() }, ["ref"]),
  async execute({ ref }, ctx) {
    const rows = await sql`select * from schedules where room_id=${ctx.room.id} and status='active'`, q = String(ref).toLowerCase();
    const hits = rows.filter((r: any) => r.id.toLowerCase().endsWith(q) || (q.length > 2 && r.text.toLowerCase().includes(q)));
    if (hits.length !== 1) throw new ToolError("BUSINESS_RULE", hits.length ? `several match: ${hits.map((h: any) => h.text).join(" | ")}` : "no active reminder matches");
    await sql`update schedules set status='cancelled' where id=${hits[0].id}`;
    return { status: "SUCCEEDED", output: { cancelled: hits[0].text } };
  },
});

def({
  id: "agent.rename", kind: "read", description: "The person told you what to call you. Sets your name for them (and for groups they bring you into).",
  inputSchema: obj({ name: str() }, ["name"]),
  async execute({ name }, ctx) {
    name = String(name).trim().slice(0, 30);
    await sql`update users set agent_name=${name}, onboarded=true where id=${ctx.requester.id}`;
    return { status: "SUCCEEDED", output: { name } };
  },
});
def({
  id: "profile.update", kind: "read", description: "Record the person's own name or time zone when they tell you (IANA zone like America/Los_Angeles).",
  inputSchema: obj({ name: str(), tz: str() }),
  async execute({ name, tz }, ctx) {
    if (tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { throw new ToolError("BUSINESS_RULE", "unknown time zone"); } }
    await sql`update users set name=coalesce(${name ?? null}, name), tz=coalesce(${tz ?? null}, tz), onboarded=true where id=${ctx.requester.id}`;
    return { status: "SUCCEEDED", output: { name, tz } };
  },
});
def({
  id: "room.set_instructions", kind: "read", description: "In a group: the person who brought you in says what you should do here (topics to answer on, tone, what to leave alone). Replaces the earlier instructions.",
  inputSchema: obj({ instructions: str(), name: str("a name for this group chat") }, ["instructions"]),
  async execute({ instructions, name }, ctx) {
    if (ctx.room.kind !== "group") throw new ToolError("BUSINESS_RULE", "only group chats have room instructions");
    if (ctx.room.owner_id !== ctx.requester.id) throw new ToolError("PERMISSION", "only the person who brought you into this group can change what you do here");
    await sql`update rooms set instructions=${String(instructions).slice(0, 2000)}, name=coalesce(${name ?? null}, name) where id=${ctx.room.id}`;
    return { status: "SUCCEEDED", output: { instructions } };
  },
});
def({
  id: "consent.revoke", kind: "read", description: "The person no longer wants their accounts used in this group (\"stop using my accounts here\").", inputSchema: obj({}),
  async execute(_i, ctx) { await revokeConsent(ctx.room.id, ctx.requester.id); return { status: "SUCCEEDED", output: { revoked: true } }; },
});

def({
  id: "skill.read", kind: "read", description: "Read one of your skills (procedures) before a task of that kind. Names are listed in your instructions.",
  inputSchema: obj({ name: str() }, ["name"]),
  async execute({ name }) { const s = await readSkill(name); if (!s) throw new ToolError("BUSINESS_RULE", "no such skill"); return { status: "SUCCEEDED", output: { skill: s } }; },
});
def({
  id: "files.read", kind: "read", description: "Read the text of a file someone sent in this chat (by file id). offset pages through long files.",
  inputSchema: obj({ file_id: str(), offset: num() }, ["file_id"]),
  async execute({ file_id, offset = 0 }, ctx) {
    const f = await one(sql`select name, text from files where id=${file_id} and room_id=${ctx.room.id}`);
    if (!f) throw new ToolError("BUSINESS_RULE", "no such file in this chat");
    const text = String(f.text ?? "");
    return { status: "SUCCEEDED", untrusted: true, output: { name: f.name, text: text.slice(offset, offset + 6000), more: text.length > offset + 6000 } };
  },
});
def({
  id: "calc", kind: "read", description: "Exact arithmetic for splits, totals, percentages. Operators + - * / % ^ and parentheses; several expressions separated by ';'.",
  inputSchema: obj({ expressions: str() }, ["expressions"]),
  async execute({ expressions }) {
    const out: Record<string, number | string> = {};
    for (const e of String(expressions).split(";").map((s) => s.trim()).filter(Boolean)) {
      if (!/^[\d\s+\-*/%^().]+$/.test(e)) { out[e] = "only numbers and + - * / % ^ ( )"; continue; }
      try { out[e] = Function(`"use strict"; return (${e.replace(/\^/g, "**")})`)(); } catch { out[e] = "invalid"; }
    }
    return { status: "SUCCEEDED", output: out };
  },
});
def({
  id: "trace.link", kind: "read", description: "A personal link where the person can see what you did and why (every run, tool call and its proof).", inputSchema: obj({}),
  async execute(_i, ctx) { return { status: "SUCCEEDED", output: { link: await makeLink(ctx.requester.id, "trace") } }; },
});
def({
  id: "device.connect_link", kind: "read", description: "A personal link for the person to connect a device (an MCP server such as iphone-use running on their Mac) so you can use their phone.", inputSchema: obj({}),
  async execute(_i, ctx) { return { status: "SUCCEEDED", output: { link: await makeLink(ctx.requester.id, "mcp") } }; },
});
def({
  id: "google.connect_link", kind: "read", description: "A personal link for the person to connect Google (Gmail, Calendar, Contacts, Drive). Only when a task needs it.", inputSchema: obj({}),
  async execute(_i, ctx) { return { status: "SUCCEEDED", output: { link: await makeLink(ctx.requester.id, "google") } }; },
});
