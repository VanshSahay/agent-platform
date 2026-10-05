// iMessage on the shared line, the way people actually use it: plain-text replies, split long answers, names instead of
// phone numbers, 👍 on an approval, several agents in one thread, photos/files, "…is typing".
import { test, expect, beforeEach } from "bun:test";
import { one, all, J, exec } from "../src/db";
import * as rt from "../src/runtime";
import * as ch from "../src/channels";
import { setup, user, workspace, installAgent, googleConnection, scriptModel, call, net, deliver, imsg, SECRETS, channel, tg, link } from "./helpers";

let ellie: string, ws: string;
const LINE = "chi_shared_imessage";
beforeEach(() => {
  setup();
  Object.assign(process.env, { SHARED_IMESSAGE_LINE: "+15550001000", SHARED_IMESSAGE_API_URL: "https://photon.test", SHARED_IMESSAGE_API_KEY: "ph", SHARED_IMESSAGE_WEBHOOK_SECRET: SECRETS.imessage.webhook_secret });
  ch.ensureSharedIdentities();
  ellie = user("Ellie"); ws = workspace("Home", ellie);
});
const text = (chat: string, handle: string, body: string, group = false, extra: any = {}) => deliver("imessage", LINE, { ...imsg(chat, handle, "", body, group), ...extra });
const sent = (chat: string) => net.to(/photon\.test\/messages/).map((c) => c.body).filter((b) => b.chat_id === chat).map((b) => b.text as string);
async function dm(agent: any, handle = "+15551110000", chat = "chat-ellie") {
  await text(chat, handle, `start ${ch.createDeployCode(agent.id, ellie, "imessage", "dm")}`);
}

test("AC-IM1 replies are plain text on iMessage (no markdown), WhatsApp gets *bold*, Slack mrkdwn; long replies split into normal texts", async () => {
  const md = "## Options\n**Osteria Nove** — 7pm\n- Lupa\n| Place | Time |\n|---|---|\n| Via Carota | 8pm |\n[[Source](https://a.example/x)] and [menu](https://b.example)";
  const plain = ch.formatFor("imessage", md);
  expect(plain).not.toMatch(/\*\*|^##|\|---|\[Source\]/m);
  expect(plain).toContain("Osteria Nove — 7pm");
  expect(plain).toContain("• Lupa");
  expect(plain).toContain("Via Carota · 8pm");
  expect(plain).toContain("https://a.example/x");
  expect(plain).toContain("menu (https://b.example)");
  expect(ch.formatFor("whatsapp", "**hi**")).toBe("*hi*");
  expect(ch.formatFor("slack", "**hi** [x](https://c.example)")).toBe("*hi* <https://c.example|x>");
  expect(ch.formatFor("web", md)).toBe(md);

  const ava = installAgent("ava-executive-assistant", ws, ellie);
  await dm(ava);
  const para = (n: number) => `Paragraph ${n}. ` + "Lorem ipsum dolor sit amet. ".repeat(28);
  scriptModel({ text: [1, 2, 3, 4].map(para).join("\n\n") });
  await text("chat-ellie", "+15551110000", "tell me a long story");
  const parts = sent("chat-ellie").slice(1); // after the welcome
  expect(parts.length).toBeGreaterThanOrEqual(3);
  expect(parts.every((p) => p.length <= 900)).toBe(true);
  expect(parts.join(" ")).toContain("Paragraph 4.");
});

test("AC-IM2 group members show as 'someone (…1234)' until they say their name; the agent is told to ask", async () => {
  const tab = installAgent("tab-split-expenses", ws, ellie);
  await text("grp", "+15551110000", `join ${ch.createDeployCode(tab.id, ellie, "imessage", "group")}`, true);
  const seen = scriptModel({ text: "Hi! What should I call you?" });
  await text("grp", "+15552221234", "@Tab I paid 30 for pizza", true);
  const guest = one<any>("select u.* from external_identities x join users u on u.id=x.user_id where x.external_user_id='+15552221234'");
  expect(guest.name).toBe("someone (…1234)");
  expect(seen[0].system).toContain("someone (…1234)");
  expect(seen[0].system).toMatch(/haven't told you their name/);
  await text("grp", "+15552221234", "hey I'm Maria", true);
  expect(one<any>("select name from users where id=?", guest.id).name).toBe("Maria");
  await text("grp", "+15552221234", "I'm Late again lol", true); // only the first, default name is replaced; "Late" was never a name
  expect(one<any>("select name from users where id=?", guest.id).name).toBe("Maria");
});

test("AC-IM3 a 👍 tapback on the approval message approves it (👎 rejects); other tapbacks and other people's do nothing", async () => {
  const ava = installAgent("ava-executive-assistant", ws, ellie);
  googleConnection(ws, ellie, [ava.id]);
  await dm(ava);
  scriptModel(call("email.send", { to: ["sam@example.com"], subject: "Dinner", body: "Friday?" }), { text: "Sent." });
  await text("chat-ellie", "+15551110000", "email sam@example.com about dinner friday");
  const apr = one<any>("select * from approvals where status='pending'");
  expect(apr).toBeTruthy();
  const card = one<any>("select o.* from outbox o join events e on e.id=o.event_id where json_extract(e.data, '$.buttons') is not null order by o.created_at desc limit 1");
  expect(sent("chat-ellie").at(-1)).toMatch(/👍 or "approve"/);
  await text("chat-ellie", "+15551110000", "", false, { id: "tb1", reaction: { emoji: "😂", target_id: card.external_id } });
  expect(one<any>("select status from approvals where id=?", apr.id).status).toBe("pending");
  await text("chat-ellie", "+15551110000", "", false, { id: "tb2", reaction: { emoji: "love", target_id: card.external_id } });
  expect(one<any>("select status from approvals where id=?", apr.id).status).toBe("approved");
  expect(net.to(/gmail/)).toHaveLength(1);
});

test("AC-IM4 several agents share one 1:1 thread: a second code adds (not replaces); @Name switches and sticks; each agent's messages still arrive, labeled", async () => {
  const ava = installAgent("ava-executive-assistant", ws, ellie), reese = installAgent("reese-reservations", ws, ellie);
  await dm(ava);
  await dm(reese); // same thread, second agent
  expect(sent("chat-ellie").at(-1)).toMatch(/Hi, I'm Reese/);
  const seen = scriptModel((r) => ({ text: r.system.includes("You are Ava") ? "Ava here" : "Reese here" }));
  await text("chat-ellie", "+15551110000", "what's good friday?");
  expect(sent("chat-ellie").at(-1)).toBe("Reese: Reese here"); // the newest agent is current; labeled since the thread is shared
  await text("chat-ellie", "+15551110000", "@Ava what's on my calendar?");
  expect(sent("chat-ellie").at(-1)).toBe("Ava: Ava here");
  await text("chat-ellie", "+15551110000", "and tomorrow?"); // sticks with Ava
  expect(sent("chat-ellie").at(-1)).toBe("Ava: Ava here");
  // Reese's own messages (a reminder firing in Reese's room) still reach the same chat
  rt.postMessage(rt.privateRoomFor(ellie, reese).id, { sender: reese.id, text: "Your table is at 7", targets: rt.replyTargets(rt.privateRoomFor(ellie, reese).id, null) });
  await rt.drain();
  expect(sent("chat-ellie").at(-1)).toBe("Reese: Your table is at 7");
  await text("chat-ellie", "+15551110000", "agents");
  expect(sent("chat-ellie").at(-1)).toMatch(/Ava \(talking now\), Reese/);
  expect(seen.length).toBe(3);
});

test("AC-IM5 photos, voice notes and files become text the agent can use; without a media model it says so honestly", async () => {
  const ava = installAgent("ava-executive-assistant", ws, ellie);
  await dm(ava);
  const seen = scriptModel({ text: "Got it." });
  await text("chat-ellie", "+15551110000", "here's the agenda", false,
    { attachments: [{ name: "agenda.txt", mime_type: "text/plain", data_base64: Buffer.from("1. Budget 2. Hiring").toString("base64") }] });
  expect(seen.at(-1)!.messages.map((m) => m.content).join("\n")).toMatch(/sent a file "agenda.txt".*1\. Budget 2\. Hiring/);
  await text("chat-ellie", "+15551110000", "", false, { id: "ph1", attachments: [{ name: "IMG_1.jpg", mime_type: "image/jpeg", data_base64: Buffer.from([255, 216, 255]).toString("base64") }] });
  expect(seen.at(-1)!.messages.map((m) => m.content).join("\n")).toMatch(/sent a photo — I can't see photos right now/);
  expect(one<any>("select count(*) n from files where workspace_id=?", ws).n).toBe(2); // kept, so files.read works later
});

test("AC-IM6 the chat shows '…is typing' while the agent works (iMessage bridge, Telegram)", async () => {
  const ava = installAgent("ava-executive-assistant", ws, ellie);
  await dm(ava);
  scriptModel({ text: "hi" });
  await text("chat-ellie", "+15551110000", "hello there friend");
  expect(net.to(/photon\.test\/typing/).length).toBeGreaterThanOrEqual(1);
  const t = channel(ava.id, "telegram");
  link("telegram", "77", ellie);
  await deliver("telegram", t.id, tg(77, 77, "Ellie", "hello again friend"));
  expect(net.to(/sendChatAction/).length).toBeGreaterThanOrEqual(1);
});
