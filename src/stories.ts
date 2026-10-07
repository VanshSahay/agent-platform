// The family story store: stories, recipes and the photos they go with, kept with provenance (who told it, where, when).
// A story told in a private chat stays there; one told in the family group belongs to the group. Search follows the same
// boundary: from a private chat you see your own and the family's, from the group only the group's.
import { all, one, exec, id, now, S, J } from "./db";
import * as rt from "./runtime";
import { familyRooms } from "./family";
import type { ToolDef } from "./tools";

export interface Story { id: string; workspace_id: string; room_id: string; told_by: string; title: string; text: string; people: string; when_text: string | null; where_text: string | null; file_id: string | null; created_at: number }

/** The rooms whose stories this person may read from here. */
export function visibleRooms(ctx: any): string[] {
  const rooms = [ctx.room.id];
  if (ctx.room.kind === "private") rooms.push(...familyRooms(ctx.agent.id, ctx.run.requested_by).map((r) => r.id));
  return rooms;
}
const view = (s: Story) => ({ id: s.id.slice(-6), title: s.title, story: s.text, people: J(s.people, []), when: s.when_text, where: s.where_text, told_by: rt.nameOf(s.told_by), told_on: new Date(s.created_at).toISOString().slice(0, 10),
  photo: s.file_id ? (one<any>("select name from files where id=?", s.file_id)?.name ?? null) : null });

export function registerStoryTools(def: (d: ToolDef) => void) {
  const obj = (p: any, required: string[] = []) => ({ type: "object", properties: p, required, additionalProperties: false });
  def({
    id: "story.add", description: "Keep a family story, memory or recipe as the person told it: title, the story in their own words (don't rewrite it), the people in it, roughly when and where. If they just sent a photo, attach it with the file name. Stays in this chat (private stays private; the family group's are the family's).",
    risk: "write_internal", idempotency: "safe", defaultApproval: "none",
    inputSchema: obj({ title: { type: "string" }, text: { type: "string", description: "their words, verbatim or lightly tidied" }, people: { type: "array", items: { type: "string" } }, when: { type: "string", description: "e.g. 'summer 1978', 'when Dad was 10'" }, where: { type: "string" }, photo: { type: "string", description: "file name of a photo sent in this chat" } }, ["title", "text"]),
    async execute(i, ctx) {
      const file = i.photo ? one<any>("select id, name from files where room_id=? and lower(name) like ? order by created_at desc limit 1", ctx.room.id, `%${String(i.photo).toLowerCase()}%`) : null;
      if (i.photo && !file) throw new Error(`no photo named ${i.photo} in this chat`);
      const s: Story = { id: id("sty"), workspace_id: ctx.run.workspace_id, room_id: ctx.room.id, told_by: ctx.run.requested_by, title: String(i.title).slice(0, 120), text: String(i.text).slice(0, 4000), people: S((i.people ?? []).map(String).slice(0, 20)),
        when_text: i.when ? String(i.when).slice(0, 80) : null, where_text: i.where ? String(i.where).slice(0, 120) : null, file_id: file?.id ?? null, created_at: now() };
      exec("insert into stories (id, workspace_id, room_id, told_by, title, text, people, when_text, where_text, file_id, created_at) values (?,?,?,?,?,?,?,?,?,?,?)", s.id, s.workspace_id, s.room_id, s.told_by, s.title, s.text, s.people, s.when_text, s.where_text, s.file_id, s.created_at);
      return { status: "SUCCEEDED", output: { kept: view(s), where_it_lives: ctx.room.kind === "private" ? "your private chat (use family.share to give it to the family)" : `the ${ctx.room.name} group` } };
    },
  });
  def({
    id: "story.search", description: "Find family stories, memories and recipes by words, a person, a place or a time. Returns the stories with who told them and when. Read what the person may see from here: their own, and the family group's.",
    risk: "read", idempotency: "safe", defaultApproval: "none",
    inputSchema: obj({ query: { type: "string", description: "words, a name, a place; empty for the latest" } }),
    async execute({ query }, ctx) {
      const rooms = visibleRooms(ctx), q = String(query ?? "").toLowerCase().trim();
      const rows = all<Story>(`select * from stories where room_id in (${rooms.map(() => "?").join(",")}) order by created_at desc limit 200`, ...rooms);
      const words = q.split(/\s+/).filter((w) => w.length > 1);
      const hits = words.length ? rows.filter((s) => { const hay = `${s.title} ${s.text} ${s.people} ${s.when_text ?? ""} ${s.where_text ?? ""}`.toLowerCase(); return words.some((w) => hay.includes(w)); }) : rows;
      return { status: "SUCCEEDED", output: { stories: hits.slice(0, 10).map(view), total: hits.length } };
    },
  });
}
