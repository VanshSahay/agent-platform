import { n, num, obj, s, str, type ToolDef } from "../kit.ts";
import { clip, notConnected, readableRooms } from "./shared.ts";

/** Fo's "knowledge" family: reading the world, the mailbox, Slack and WhatsApp, and the agent's own soul. */
export const KNOWLEDGE_TOOLS: ToolDef[] = [
  {
    spec: { name: "load_soul_document", description: "Your own identity, personality, values and operating principles, as the owner set them.", input_schema: obj({}) },
    family: "knowledge",
    labels: { running: "Reading the soul doc…", done: "Read the soul doc" },
    sideEffect: false,
    async run(_input, ctx) {
      return { ok: true, content: ctx.agent.soul };
    },
  },
  {
    spec: { name: "email_load_unprocessed", description: "New email in the assistant's own inbox that it has not dealt with yet.", input_schema: obj({}) },
    family: "knowledge",
    needs: "email",
    labels: { running: "Loading new email…", done: "Loaded new email" },
    sideEffect: false,
    async run(_input, ctx) {
      const msgs = await ctx.hands.email.unprocessed();
      if (!msgs.length) return { ok: true, content: "No new email." };
      await ctx.hands.email.markProcessed(msgs.map((m) => m.id));
      return { ok: true, content: msgs.map((m) => ({ ...m, text: clip(m.text, 3000) })), evidence: `email:unprocessed:${msgs.length}` };
    },
  },
  {
    spec: { name: "email_load_thread", description: "A whole email thread in the assistant's own inbox.", input_schema: obj({ threadId: str("The thread id.") }, ["threadId"]) },
    family: "knowledge",
    needs: "email",
    labels: { running: "Loading email thread…", done: "Loaded email thread" },
    sideEffect: false,
    async run(input, ctx) {
      const msgs = await ctx.hands.email.thread(s(input.threadId));
      if (!msgs.length) return { ok: false, content: "No such thread." };
      return { ok: true, content: msgs.map((m) => ({ ...m, text: clip(m.text, 3000) })) };
    },
  },
  {
    spec: {
      name: "slack_load_recent",
      description: "Recent messages in a Slack channel the workspace connected.",
      input_schema: obj({ channel: str("Channel id or #name."), limit: num("Messages, default 30.") }, ["channel"]),
    },
    family: "knowledge",
    needs: "slack",
    labels: { running: "Reading Slack…", done: "Read Slack" },
    sideEffect: false,
    async run(input, ctx) {
      if (!ctx.vault.has("slack")) return notConnected(ctx, "Slack");
      const channel = await slackChannelId(ctx, s(input.channel));
      if (!channel) return { ok: false, content: "No such channel." };
      const r = (await ctx.vault.use("slack", (t) => ctx.hands.slack.call(t, "conversations.history", { channel, limit: n(input.limit) ?? 30 }))) as
        | { ok?: boolean; messages?: { user?: string; text?: string; ts?: string }[]; error?: string }
        | undefined;
      if (!r?.ok) return { ok: false, content: `Slack said: ${r?.error ?? "no reply"}` };
      return {
        ok: true,
        content: (r.messages ?? []).map((m) => ({ user: m.user, text: clip(m.text ?? "", 800), at: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : undefined })),
        evidence: `slack:history:${channel}`,
      };
    },
  },
  {
    spec: { name: "slack_load_aggregates", description: "The Slack channels the workspace connected, with member counts and purposes.", input_schema: obj({}) },
    family: "knowledge",
    needs: "slack",
    labels: { running: "Reading Slack…", done: "Read Slack" },
    sideEffect: false,
    async run(_input, ctx) {
      if (!ctx.vault.has("slack")) return notConnected(ctx, "Slack");
      const r = (await ctx.vault.use("slack", (t) => ctx.hands.slack.call(t, "conversations.list", { limit: 200, exclude_archived: true }))) as
        | { ok?: boolean; channels?: { id: string; name: string; num_members?: number; purpose?: { value?: string } }[]; error?: string }
        | undefined;
      if (!r?.ok) return { ok: false, content: `Slack said: ${r?.error ?? "no reply"}` };
      return { ok: true, content: (r.channels ?? []).map((c) => ({ id: c.id, name: c.name, members: c.num_members, purpose: c.purpose?.value })), evidence: "slack:channels" };
    },
  },
  {
    spec: {
      name: "slack_search_messages",
      description: "Search messages in the connected Slack workspace.",
      input_schema: obj({ query: str("Search words."), limit: num("Results, default 20.") }, ["query"]),
    },
    family: "knowledge",
    needs: "slack",
    labels: { running: "Searching Slack…", done: "Searched Slack" },
    sideEffect: false,
    async run(input, ctx) {
      if (!ctx.vault.has("slack")) return notConnected(ctx, "Slack");
      const r = (await ctx.vault.use("slack", (t) => ctx.hands.slack.call(t, "search.messages", { query: s(input.query), count: n(input.limit) ?? 20 }))) as
        | { ok?: boolean; messages?: { matches?: { text?: string; channel?: { name?: string }; username?: string; ts?: string; permalink?: string }[] }; error?: string }
        | undefined;
      if (!r?.ok) return { ok: false, content: `Slack said: ${r?.error ?? "no reply"} (search needs a user token; with a bot token use slack_load_recent per channel)` };
      return {
        ok: true,
        content: (r.messages?.matches ?? []).map((m) => ({ channel: m.channel?.name, user: m.username, text: clip(m.text ?? "", 600), link: m.permalink })),
        evidence: `slack:search`,
        label: `Searched Slack: ${s(input.query).slice(0, 40)}`,
      };
    },
  },
  {
    spec: {
      name: "whatsapp_load_recent",
      description: "Recent messages across the WhatsApp chats the assistant is in (those the requester shares).",
      input_schema: obj({ limit: num("Messages per chat, default 20.") }),
    },
    family: "knowledge",
    labels: { running: "Reading WhatsApp…", done: "Read WhatsApp" },
    sideEffect: false,
    async run(input, ctx) {
      const rooms = readableRooms(ctx).filter((r) => r.channel === "whatsapp");
      if (!rooms.length) return { ok: true, content: "No WhatsApp chats connected. Set WHATSAPP through Photon Spectrum (see .env.example)." };
      return {
        ok: true,
        content: rooms.map((r) => ({
          roomId: r.id,
          name: r.name,
          messages: ctx.store
            .messagesForRoom(r.id, Math.min(100, Math.max(1, n(input.limit) ?? 20)))
            .filter((m) => m.role !== "system")
            .map((m) => ({ at: new Date(m.at).toISOString(), who: ctx.store.getPerson(m.authorId)?.displayName ?? ctx.agent.name, text: clip(m.text, 400) })),
        })),
      };
    },
  },
  {
    spec: {
      name: "whatsapp_load_conversation",
      description: "One WhatsApp chat in full (as far back as kept).",
      input_schema: obj({ roomId: str("The room id from whatsapp_load_recent."), limit: num("Messages, default 100.") }, ["roomId"]),
    },
    family: "knowledge",
    labels: { running: "Loading WhatsApp thread…", done: "Loaded WhatsApp thread" },
    sideEffect: false,
    async run(input, ctx) {
      const room = readableRooms(ctx).find((r) => r.id === s(input.roomId) && r.channel === "whatsapp");
      if (!room) return { ok: false, content: "Not a WhatsApp chat you can read." };
      return {
        ok: true,
        content: ctx.store
          .messagesForRoom(room.id, Math.min(300, Math.max(1, n(input.limit) ?? 100)))
          .filter((m) => m.role !== "system")
          .map((m) => ({ at: new Date(m.at).toISOString(), who: ctx.store.getPerson(m.authorId)?.displayName ?? ctx.agent.name, text: clip(m.text, 800) })),
      };
    },
  },
  {
    spec: {
      name: "whatsapp_get_summary",
      description: "A short summary of what a WhatsApp chat has been about lately.",
      input_schema: obj({ roomId: str("The room id.") }, ["roomId"]),
    },
    family: "knowledge",
    labels: { running: "Summarising WhatsApp…", done: "Summarised WhatsApp" },
    sideEffect: false,
    async run(input, ctx) {
      const room = readableRooms(ctx).find((r) => r.id === s(input.roomId) && r.channel === "whatsapp");
      if (!room) return { ok: false, content: "Not a WhatsApp chat you can read." };
      const lines = ctx.store
        .messagesForRoom(room.id, 80)
        .filter((m) => m.role !== "system")
        .map((m) => `${ctx.store.getPerson(m.authorId)?.displayName ?? ctx.agent.name}: ${m.text.slice(0, 300)}`)
        .join("\n");
      const summary = await ctx.model
        .complete({
          system: "Summarise this chat in under 120 words: what it is about, open questions, who owes what. Plain prose.",
          prompt: lines || "(empty)",
          effort: "low",
          maxTokens: 400,
        })
        .catch(() => "");
      return { ok: true, content: summary || "Nothing to summarise yet." };
    },
  },
];

async function slackChannelId(ctx: Parameters<ToolDef["run"]>[1], ref: string): Promise<string | undefined> {
  if (!ref.startsWith("#")) return ref;
  const name = ref.slice(1).toLowerCase();
  const r = (await ctx.vault.use("slack", (t) => ctx.hands.slack.call(t, "conversations.list", { limit: 500, exclude_archived: true }))) as
    | { channels?: { id: string; name: string }[] }
    | undefined;
  return r?.channels?.find((c) => c.name.toLowerCase() === name)?.id;
}
