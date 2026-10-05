// Email + outbox reliability (lessons from a sibling project): tokenised Reply-To, metadata-only webhooks, bounces,
// HTML-only replies, and claim-before-send so an interrupted send is never silently resent.
import { test, expect, beforeEach } from "bun:test";
import { setup, user, workspace, customAgent, channel, deliver, inboundEmail, scriptModel, net } from "./helpers";
import { one, all, exec, now, id } from "../src/db";
import * as ch from "../src/channels";
import * as rt from "../src/runtime";

let ws: string, ellie: string, agent: any, cid: string;
beforeEach(() => {
  setup();
  ellie = user("Ellie"); ws = workspace("Team", ellie);
  agent = customAgent(ws, ellie, [], {}, "Ava");
  cid = channel(agent.id, "email", "ava@agents.test").id;
  net.on(/api\.resend\.com\/emails$/, () => Response.json({ id: `re_${Math.random()}` }));
  scriptModel({ text: "On it." });
});
const sent = () => net.to(/api\.resend\.com\/emails$/).map((c) => c.body);

test("AC-E1 agent emails carry a per-conversation Reply-To token; a forwarded reply from another address lands in the same conversation", async () => {
  await deliver("email", cid, inboundEmail("bob@x.test", "Quote", "Can you send the quote?"));
  await ch.flushOutbox();
  const reply = sent()[0], ep = one<any>("select * from room_endpoints where external_conversation_id='bob@x.test'");
  expect(reply.reply_to[0]).toBe(`ava+r_${ep.reply_token}@agents.test`);
  await deliver("email", cid, { type: "email.received", data: { email_id: "fw1", from: "carol@y.test", to: [`ava+r_${ep.reply_token}@agents.test`], subject: "Fwd", text: "Bob asked me to follow up" } });
  expect(all<any>("select * from room_endpoints where channel_identity_id=?", cid)).toHaveLength(1); // no new conversation for carol
  const msgs = all<any>("select data from events where room_id=? and type='message'", ep.room_id).map((e) => JSON.parse(e.data).text);
  expect(msgs).toContain("Bob asked me to follow up");
});

test("AC-E2 metadata-only webhooks fetch the body; HTML-only mail becomes readable text", async () => {
  net.on(/emails\/receiving\/meta1/, () => Response.json({ html: "<p>Hello<br>there &amp; thanks</p><blockquote>old</blockquote>" }));
  await deliver("email", cid, { type: "email.received", data: { email_id: "meta1", from: "dan@x.test", to: ["ava@agents.test"], subject: "Hi" } });
  const ep = one<any>("select * from room_endpoints where external_conversation_id='dan@x.test'");
  const text = JSON.parse(one<any>("select data from events where room_id=? and type='message' order by seq limit 1", ep.room_id).data).text;
  expect(text).toBe("Hello\nthere & thanks"); // quoted history (blockquote) dropped
});

test("AC-E3 bounces and complaints stop further sends to that address", async () => {
  await deliver("email", cid, inboundEmail("bob@x.test", "Quote", "Can you send the quote?"));
  await ch.flushOutbox(); const before = sent().length;
  await deliver("email", cid, { type: "email.bounced", data: { email_id: "b1", to: ["bob@x.test"] } });
  const ep = one<any>("select * from room_endpoints where external_conversation_id='bob@x.test'");
  expect(ep.undeliverable).toBe(1);
  rt.postMessage(ep.room_id, { sender: agent.id, text: "Following up", targets: rt.replyTargets(ep.room_id, null) });
  await ch.flushOutbox();
  expect(sent().length).toBe(before);
  expect(one<any>("select status from outbox where payload like '%Following up%'")).toMatchObject({ status: "skipped" }); // by content: rows can share a millisecond
});

test("AC-E4 claim before send, confirm after: an interrupted send is parked as 'unconfirmed', never resent automatically", async () => {
  await deliver("email", cid, inboundEmail("bob@x.test", "Quote", "Can you send the quote?"));
  const o = one<any>("select * from outbox order by created_at desc limit 1"), before = sent().length;
  exec("update outbox set status='sending', claimed_at=? where id=?", now() - ch.SEND_CLAIM_STALE_MS - 1, o.id); // crashed mid-send
  await ch.flushOutbox();
  expect(one<any>("select status from outbox where id=?", o.id).status).toBe("unconfirmed");
  expect(sent()).toHaveLength(before); // not resent
  // a provider error (nothing sent) is retried normally
  net.on(/api\.resend\.com\/emails$/, () => new Response("nope", { status: 500 }));
  exec("update outbox set status='queued', attempts=0 where id=?", o.id);
  await ch.flushOutbox();
  expect(one<any>("select status, attempts from outbox where id=?", o.id)).toEqual({ status: "queued", attempts: 1 });
});
