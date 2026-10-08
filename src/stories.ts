// The family story store: stories, recipes and the photos they go with, kept with provenance (who told it, where, when).
// A story told in a private chat stays there; one told in the family group belongs to the group. Search follows the same
// boundary: from a private chat you see your own and the family's, from the group only the group's.
import { all, one, exec, emit, id, now, S, J } from "./db";
import * as rt from "./runtime";
import { familyRooms } from "./family";
import { obj, type ToolDef } from "./tools";

export interface Story { id: string; workspace_id: string; room_id: string; told_by: string; title: string; text: string; people: string; when_text: string | null; where_text: string | null; file_id: string | null; created_at: number }

/** The rooms whose stories this person may read from here. */
export function visibleRooms(ctx: any): string[] {
  const rooms = [ctx.room.id];
  if (ctx.room.kind === "private") rooms.push(...familyRooms(ctx.agent.id, ctx.run.requested_by).map((r) => r.id));
  return rooms;
}
const view = (s: Story) => ({ id: s.id.slice(-6), title: s.title, story: s.text, people: J(s.people, []), when: s.when_text, where: s.where_text, told_by: rt.nameOf(s.told_by), told_on: new Date(s.created_at).toISOString().slice(0, 10),
  photo: s.file_id ? (one<any>("select name from files where id=?", s.file_id)?.name ?? null) : null });

/** The story interviewer's questions, in an order that starts easy. Asked one at a time; the answer is kept with story.add. */
export const QUESTIONS = [
  "Where did you grow up, and what did your street look like?", "What's the first meal you remember loving, and who made it?", "How did your parents meet?",
  "What was your first job, and what did it pay?", "Who was your best friend when you were ten?", "What's a song that takes you straight back to being young?",
  "How did you meet the person you married (or nearly married)?", "What was the first trip you took on your own?", "What did your grandmother's kitchen smell like?",
  "What's a family recipe we should never lose — and how do you actually make it?", "What was the hardest year of your life, and what got you through it?",
  "What's something your parents said that you still repeat?", "Which holiday tradition did you love most as a child?", "What did you want to be at sixteen?",
  "What's the best advice anyone ever gave you?", "What's a photo you wish you had taken?", "Who in the family do you think I most take after, and why?",
  "What was the house you were happiest in?", "What did you do on summer evenings before television?", "What's a story about me (or my parent) as a baby that I've never heard?",
  "What's a mistake you're glad you made?", "Which teacher changed your life?", "What was the first car you drove, and where did you go?",
  "What do you remember about the day your first child was born?", "What's a dish from your childhood that nobody makes anymore?", "What did your father do with his hands?",
  "What was a typical Sunday like when you were twelve?", "What's the proudest moment of your working life?", "Who do you wish the grandchildren could have met?",
  "If you could go back to one ordinary afternoon, which would it be?",
];

export function registerStoryTools(def: (d: ToolDef) => void) {
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
    id: "story.prompt", description: "The story interviewer: the next question to ask this person about their life (never one they've been asked). Ask it in your own warm words, one at a time, then keep their answer with story.add titled from the question. Use it for a standing weekly 'ask me about my life' job or when they ask for a prompt.",
    risk: "write_internal", idempotency: "safe", defaultApproval: "none",
    inputSchema: obj({}),
    async execute(_i, ctx) {
      const askedRows = all<any>("select data from events where type='STORY_PROMPTED' and room_id=?", ctx.room.id);
      const asked = new Set(askedRows.map((e) => Number(J(e.data, {}).q)));
      const k = QUESTIONS.findIndex((_, i) => !asked.has(i));
      if (k < 0) return { status: "SUCCEEDED", output: { question: null, note: "Every question in the bank has been asked here. Ask them what they'd like to tell next." } };
      emit("STORY_PROMPTED", { workspace_id: ctx.run.workspace_id, room_id: ctx.room.id, run_id: ctx.run.id, actor: ctx.agent.id, data: { q: k, user: ctx.run.requested_by } });
      return { status: "SUCCEEDED", output: { question: QUESTIONS[k], number: k + 1, of: QUESTIONS.length, then: "When they answer, call story.add with their words (title from the question)." } };
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
