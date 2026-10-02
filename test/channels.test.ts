import { test, expect, beforeEach } from "bun:test";
import { one, all, J, now } from "../src/db";
import * as rt from "../src/runtime";
import { handleWebhook, createLinkCode } from "../src/channels";
import { setup, user, workspace, customAgent, googleConnection, scriptModel, call, net, channel, signed, deliver, tg, slackMsg, imsg, inboundEmail, link, runsIn, lastFrom, pendingApprovals, SECRETS } from "./helpers";

let ellie: string, ws: string, agent: any;
beforeEach(() => { setup(); ellie = user("Ellie"); ws = workspace("WS", ellie); agent = customAgent(ws, ellie, ["email-drafting", "web-research"], {}, "Ava"); });

const PLATFORMS: [keyof typeof SECRETS, any][] = [
  ["telegram", tg(1, 1, "E", "hi")], ["slack", slackMsg("C", "U", "hi")], ["imessage", imsg("c", "h", "E", "hi")],
  ["whatsapp", { entry: [{ changes: [{ value: { messages: [{ id: "wamid.x", from: "15551234", type: "text", text: { body: "hi" } }] } }] }] }],
  ["email", inboundEmail("e@x.test", "s", "hi")],
];

test("AC-C1 every webhook verifies its signature; forged and replayed requests are rejected", async () => {
  for (const [p, payload] of PLATFORMS) {
    const c = channel(agent.id, p);
    expect((await handleWebhook(p, c.id, signed(p, c.id, payload, { badSig: true }))).status).toBe(401);
    if (["slack", "imessage", "email"].includes(p))
      expect((await handleWebhook(p, c.id, signed(p, c.id, payload, { ts: Math.floor(now() / 1000) - 3600 }))).status).toBe(401);
    expect((await handleWebhook(p, c.id, signed(p, c.id, payload))).status).toBe(200);
  }
  expect(all("select * from events where type='WEBHOOK_REJECTED'").length).toBe(8);
  expect((await handleWebhook("telegram", "chi_nope", signed("telegram", "x", PLATFORMS[0][1]))).status).toBe(404);
});

test("AC-C2 provider retries are deduplicated and ingestion is separate from processing", async () => {
  const c = channel(agent.id, "telegram");
  const u = tg(7, 7, "Ellie", "hello");
  scriptModel({ text: "hi" });
  await handleWebhook("telegram", c.id, signed("telegram", c.id, u));
  await handleWebhook("telegram", c.id, signed("telegram", c.id, u));
  expect(all("select * from inbound_events")).toHaveLength(1);
  expect(all("select * from runs")).toHaveLength(0); // nothing processed in the webhook request itself
  await rt.drain();
  expect(all("select * from runs")).toHaveLength(1);
});

test("AC-C3 WhatsApp handshake, Slack url_verification, Slack event duplicates (message + app_mention)", async () => {
  const w = channel(agent.id, "whatsapp", "", { phone_number_id: "PN1" });
  const ok = await handleWebhook("whatsapp", w.id, new Request(`http://x/v1/webhooks/whatsapp/${w.id}?hub.mode=subscribe&hub.verify_token=wa-verify&hub.challenge=42`));
  expect(await ok.text()).toBe("42");
  const s = channel(agent.id, "slack", "", { bot_user_id: "UB" });
  const v = await handleWebhook("slack", s.id, signed("slack", s.id, { type: "url_verification", challenge: "abc" }));
  expect(await v.json()).toEqual({ challenge: "abc" });
  const m = slackMsg("C9", "U1", "<@UB> hi");
  await handleWebhook("slack", s.id, signed("slack", s.id, m));
  await handleWebhook("slack", s.id, signed("slack", s.id, { ...m, event_id: "Ev2", event: { ...m.event, type: "app_mention" } }));
  expect(all("select * from inbound_events where provider='slack'")).toHaveLength(1);
});

test("AC-C4 unknown senders become guests; linking is explicit; guest DMs move into the user's room", async () => {
  const c = channel(agent.id, "telegram", "ava_bot", { username: "ava_bot" });
  scriptModel({ text: "Hello stranger" });
  await deliver("telegram", c.id, tg(99, 99, "Ellie", "hi there"));
  const guest = one<any>("select * from external_identities where external_user_id='99'");
  expect(guest.user_id).not.toBe(ellie);
  expect(one<any>("select guest from users where id=?", guest.user_id).guest).toBe(1);
  const guestRoom = one<any>("select room_id from room_endpoints where external_conversation_id='99'").room_id;
  // An external sender is untrusted: its runs are tainted
  expect(runsIn(guestRoom)[0].tainted).toBe(1);

  const web = rt.privateRoomFor(ellie, agent);
  const code = createLinkCode(ellie);
  await deliver("telegram", c.id, tg(99, 99, "Ellie", `link ${code}`));
  expect(one<any>("select * from external_identities where external_user_id='99'")).toMatchObject({ user_id: ellie, verified: 1 });
  expect(one<any>("select room_id from room_endpoints where external_conversation_id='99'").room_id).toBe(web.id);
  expect(net.to(/sendMessage/).at(-1)!.body.text).toMatch(/Linked/);
  await deliver("telegram", c.id, tg(99, 99, "Ellie", `link ${code}`)); // codes are single-use
  expect(net.to(/sendMessage/).at(-1)!.body.text).toMatch(/invalid or expired/);
});

test("AC-C5 approvals render natively per channel and can be decided by button", async () => {
  googleConnection(ws, ellie, [agent.id]);
  const t = channel(agent.id, "telegram"), s = channel(agent.id, "slack"), w = channel(agent.id, "whatsapp", "", { phone_number_id: "PN1" });
  link("telegram", "5", ellie); link("slack", "UE", ellie); link("whatsapp", "1555", ellie);
  scriptModel(call("email.send", { to: ["a@b.test"], subject: "s", body: "b" }), { text: "sent" });
  await deliver("telegram", t.id, tg(5, 5, "Ellie", "send it"));
  const card = net.to(/sendMessage/).at(-1)!.body;
  expect(card.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(["Approve", "Reject"]);
  const data = card.reply_markup.inline_keyboard[0][0].callback_data;
  await deliver("telegram", t.id, { update_id: 999, callback_query: { id: "cb1", data, from: { id: 5, first_name: "Ellie" }, message: { chat: { id: 5, type: "private" } } } });
  expect(net.to(/messages\/send/)).toHaveLength(1);
  expect(net.to(/sendMessage/).at(-1)!.body.text).toBe("sent");

  scriptModel(call("email.send", { to: ["c@d.test"], subject: "s", body: "b" }), { text: "sent2" });
  await deliver("slack", s.id, slackMsg("D1", "UE", "Ava send another"));
  const blocks = net.to(/chat\.postMessage/).at(-1)!.body.blocks;
  expect(blocks[1].elements.map((e: any) => e.text.text)).toEqual(["Approve", "Reject"]);
  const value = blocks[1].elements[1].value;
  await deliver("slack", s.id, `payload=${encodeURIComponent(JSON.stringify({ type: "block_actions", trigger_id: "t1", user: { id: "UE", name: "ellie" }, channel: { id: "D1" }, actions: [{ value }] }))}`);
  expect(one<any>("select status from approvals where tool_id='email.send' order by created_at desc").status).toBe("rejected");

  scriptModel(call("email.send", { to: ["e@f.test"], subject: "s", body: "b" }), { text: "sent3" });
  await deliver("whatsapp", w.id, { entry: [{ changes: [{ value: { messages: [{ id: "wamid.2", from: "1555", type: "text", text: { body: "send" } }] } }] }] });
  const wa = net.to(/graph\.facebook\.com/).at(-1)!.body;
  expect(wa.type).toBe("interactive");
  expect(wa.interactive.action.buttons).toHaveLength(2);
});

test("AC-C6 agent-owned mailbox: inbound email maps to a room and replies thread by subject", async () => {
  const m = channel(agent.id, "email", "ava@agents.test");
  scriptModel({ text: "Happy to help." });
  await deliver("email", m.id, inboundEmail("Bob Smith <bob@corp.test>", "Quarterly sync", "Can we move our sync?\n\nOn Tue, Ellie wrote:\n> old stuff"));
  const sent = net.to(/api\.resend\.com\/emails/).at(-1)!;
  expect(sent.body).toMatchObject({ to: ["bob@corp.test"], subject: "Re: Quarterly sync", from: "Ava <ava@agents.test>" });
  expect(sent.headers["idempotency-key"]).toBeTruthy();
  const room = one<any>("select room_id from room_endpoints where platform='email'").room_id;
  expect(J(one<any>("select data from events where room_id=? and type='message' order by seq limit 1", room).data).text).toBe("Can we move our sync?"); // quoted text stripped
});

test("AC-C7 phone: Twilio speech turns run through the same agent and room", async () => {
  const p = channel(agent.id, "phone", "+15550100", { public_url: "https://voice.test/hook" });
  const greet = await handleWebhook("phone", p.id, signed("phone", p.id, { CallSid: "CA1", From: "+1555" }, { form: true, url: "https://voice.test/hook" }));
  expect(await greet.text()).toContain("Hi, this is Ava");
  scriptModel({ text: "You have two meetings tomorrow." });
  const r = await handleWebhook("phone", p.id, signed("phone", p.id, { CallSid: "CA1", From: "+1555", SpeechResult: "what's tomorrow look like" }, { form: true, url: "https://voice.test/hook" }));
  const xml = await r.text();
  expect(xml).toContain("<Say>You have two meetings tomorrow.</Say>");
  expect(xml).toContain("<Gather");
  const bad = await handleWebhook("phone", p.id, signed("phone", p.id, { CallSid: "CA1", From: "+1555" }, { form: true, url: "https://evil.test/hook" }));
  expect(bad.status).toBe(401);
});

test("AC-C8 failed deliveries retry and give up after 5 attempts without blocking the run", async () => {
  const t = channel(agent.id, "telegram");
  link("telegram", "8", ellie);
  net.on(/api\.telegram\.org/, () => new Response("down", { status: 502 }));
  scriptModel({ text: "hello" });
  await deliver("telegram", t.id, tg(8, 8, "Ellie", "hi"));
  for (let i = 0; i < 6; i++) await rt.tick();
  expect(one<any>("select * from outbox")).toMatchObject({ status: "failed", attempts: 5 });
  expect(runsIn(one<any>("select room_id from room_endpoints").room_id)[0].status).toBe("completed");
});
