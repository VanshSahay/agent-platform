// The family boundary: each person owns what the agent knows about them. A sharing panel says what may reach the family
// by default; the bridge is the only way private-chat facts get into a family group, and it asks the person first unless the
// category is one they chose to share. Consent is checked against what the person actually typed, not what the model claims.
import { all, one, exec, emit, now, J, S } from "./db";
import * as rt from "./runtime";
import type { ToolDef } from "./tools";

export const CATEGORIES = ["appointments", "plans", "health", "money", "conversations"] as const;
export type Category = (typeof CATEGORIES)[number];
export interface Sharing { appointments: boolean; plans: boolean; health: boolean; money: boolean; conversations: boolean; alert_to: string[] }
export const DEFAULT_SHARING: Sharing = { appointments: false, plans: false, health: false, money: false, conversations: false, alert_to: [] };
export const LABELS: Record<Category, string> = { appointments: "my appointments", plans: "my plans and outings", health: "health matters", money: "money matters", conversations: "what I talk about with the agent" };

export function sharingOf(userId: string): Sharing {
  return { ...DEFAULT_SHARING, ...(J(one<any>("select sharing from users where id=?", userId)?.sharing, {}) ?? {}) };
}
export function setSharing(userId: string, patch: Partial<Sharing>) {
  const next = { ...sharingOf(userId) };
  for (const c of CATEGORIES) if (typeof (patch as any)[c] === "boolean") next[c] = (patch as any)[c];
  if (Array.isArray(patch.alert_to)) next.alert_to = patch.alert_to.map(String).slice(0, 10);
  exec("update users set sharing=? where id=?", S(next), userId);
  return next;
}
/** One line the agent reads in a person's private chat: what they share with the family by default. */
export function sharingLine(userId: string) {
  const s = sharingOf(userId), on = CATEGORIES.filter((c) => s[c]).map((c) => LABELS[c]), off = CATEGORIES.filter((c) => !s[c]).map((c) => LABELS[c]);
  return `[SHARING — what ${rt.nameOf(userId)} lets the family see by default]\n- shared: ${on.join(", ") || "nothing yet"}\n- private (ask first, every time): ${off.join(", ")}${s.alert_to.length ? `\n- may be alerted if something important is missed: ${s.alert_to.map((u) => rt.nameOf(u)).join(", ")}` : ""}`;
}

/** The family groups this person and agent are both in. */
export function familyRooms(agentId: string, userId: string) {
  return all<any>(`select r.* from rooms r join room_members a on a.room_id=r.id and a.principal_id=? join room_members h on h.room_id=r.id and h.principal_id=?
    where r.kind='shared' and r.mode!='test' order by r.created_at`, agentId, userId);
}
/** Did the person say yes in this private chat after the agent asked? Checked against their own words, not the model's claim. */
export function consentedSince(roomId: string, userId: string, sinceTs: number) {
  const last = one<any>("select data from events where room_id=? and type='message' and actor=? and ts>=? order by seq desc limit 1", roomId, userId, sinceTs);
  return !!last && /^(yes|yeah|yep|sure|ok(ay)?|please|do it|go ahead|ask them|ask the family|post it|send it|that's fine|fine)\b/i.test(String(J(last.data, {}).text ?? "").trim());
}

export function registerFamilyTools(def: (d: ToolDef) => void) {
  const obj = (p: any, required: string[] = []) => ({ type: "object", properties: p, required, additionalProperties: false });
  def({
    id: "family.share", description: "From a person's private chat, put something in front of the family group: a ride needed, a date to pick, a plan to confirm. Posts ONLY the text you give (the agreed facts, never the private conversation). If the category isn't one the person shares by default, the tool doesn't post: it tells you to ask them first (\"Want me to ask the family?\"); call again after they say yes. Categories: appointments, plans, health, money, conversations.",
    risk: "write_internal", idempotency: "safe", defaultApproval: "none",
    inputSchema: obj({ text: { type: "string", description: "exactly what the family will read" }, category: { type: "string", enum: [...CATEGORIES] }, group: { type: "string", description: "family group name, if the person is in several" } }, ["text", "category"]),
    async execute({ text, category, group }, ctx) {
      const room = ctx.room, userId = ctx.run.requested_by;
      if (room.kind !== "private") throw new Error("family.share is for a person's private chat; in the group, just say it");
      const rooms = familyRooms(ctx.agent.id, userId);
      const target = (group ? rooms.find((r) => r.name.toLowerCase().includes(String(group).toLowerCase())) : null) ?? (rooms.length === 1 ? rooms[0] : null);
      if (!target) throw new Error(rooms.length ? `several family groups — say which: ${rooms.map((r) => r.name).join(", ")}` : "this person isn't in a family group with you yet");
      const cat = (CATEGORIES as readonly string[]).includes(category) ? (category as Category) : "conversations";
      const allowed = sharingOf(userId)[cat];
      const asked = one<any>("select ts from events where room_id=? and type='SHARE_ASKED' and json_extract(data, '$.user')=? order by ts desc limit 1", room.id, userId);
      const consented = asked && consentedSince(room.id, userId, asked.ts);
      if (!allowed && !consented) {
        emit("SHARE_ASKED", { workspace_id: ctx.run.workspace_id, room_id: room.id, run_id: ctx.run.id, actor: ctx.agent.id, data: { user: userId, category: cat, text: String(text).slice(0, 500), group: target.name } });
        return { status: "SUCCEEDED", output: { posted: false, needs_ok: true, ask_them: `Want me to ask the family (${target.name})? I'd post exactly: "${String(text).slice(0, 300)}"`, note: "Don't post anything yourself. Ask the person in this chat and stop; when they say yes, call family.share again with the same text." } };
      }
      const ev = rt.postMessage(target.id, { sender: ctx.agent.id, text: String(text).slice(0, 1500), runId: ctx.run.id, targets: rt.replyTargets(target.id, null) });
      emit("SHARED_TO_FAMILY", { workspace_id: ctx.run.workspace_id, room_id: target.id, run_id: ctx.run.id, actor: ctx.agent.id, data: { user: userId, category: cat, by: allowed ? "default sharing" : "said yes", event_id: ev } });
      return { status: "SUCCEEDED", output: { posted: true, group: target.name, text: String(text).slice(0, 1500), via: allowed ? `${LABELS[cat]} is shared by default` : "the person said yes" } };
    },
  });
  def({
    id: "family.sharing", description: "Read or change what this person shares with the family by default (appointments, plans, health, money, conversations). Only the person themselves can change it, from their own chat.",
    risk: "write_internal", idempotency: "safe", defaultApproval: "none",
    inputSchema: obj({ set: obj({ appointments: { type: "boolean" }, plans: { type: "boolean" }, health: { type: "boolean" }, money: { type: "boolean" }, conversations: { type: "boolean" } }) }),
    async execute({ set }, ctx) {
      if (set && ctx.room.kind !== "private") throw new Error("sharing can only be changed from the person's own chat");
      const s = set ? setSharing(ctx.run.requested_by, set) : sharingOf(ctx.run.requested_by);
      return { status: "SUCCEEDED", output: { sharing: Object.fromEntries(CATEGORIES.map((c) => [LABELS[c], s[c] ? "shared" : "private"])) } };
    },
  });
}
