// Regression tests for the third review (shared lines, deploy codes, reservations, orders, MCP, run robustness).
import { test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { one, all, J, S, exec, now, advance, patchJson } from "../src/db";
import * as rt from "../src/runtime";
import * as ch from "../src/channels";
import { resolver } from "../src/tools";
import { releaseAt, SANDBOX_VENUES, ymd } from "../src/reservations";
import { serve, worker, attempts } from "../src/server";
import { setup, user, workspace, installAgent, customAgent, realFetch, net, signed, imsg, inboundEmail, SECRETS, scriptModel, call, say, link } from "./helpers";

let server: ReturnType<typeof serve>;
beforeAll(() => { server = serve(0); });
afterAll(() => server.stop(true));
beforeEach(() => {
  setup(); attempts.clear();
  Object.assign(process.env, { SHARED_IMESSAGE_LINE: "+15550001000", SHARED_IMESSAGE_API_URL: "https://photon.test", SHARED_IMESSAGE_API_KEY: "ph", SHARED_IMESSAGE_WEBHOOK_SECRET: SECRETS.imessage.webhook_secret,
    SHARED_EMAIL_DOMAIN: "agents.test", RESEND_API_KEY: "re", RESEND_WEBHOOK_SECRET: SECRETS.email.webhook_secret, SLACK_CLIENT_ID: "cid", SLACK_CLIENT_SECRET: "cs", SLACK_SIGNING_SECRET: SECRETS.slack.signing_secret });
  ch.ensureSharedIdentities();
});
const settle = async () => { await worker(); await rt.drain(); };
const text = async (handle: string, chat: string, body: string, group = false) => {
  await ch.handleWebhook("imessage", "chi_shared_imessage", signed("imessage", "chi_shared_imessage", imsg(chat, handle, "X", body, group))); await settle();
};
const last = (chat: string) => net.to(/photon\.test/).filter((c) => c.body.chat_id === chat).at(-1)?.body.text as string;

test("AC-S18 deploy codes can't take over a linked account, only work where issued, and group codes link nobody", async () => {
  const bob = user("Bob"), alice = user("Alice"), wsB = workspace("B", bob), wsA = workspace("A", alice);
  const bobAgent = customAgent(wsB, bob, [], {}, "Bobbot"), aliceAgent = customAgent(wsA, alice, [], {}, "Alicebot");
  await text("+1555bob", "c-bob", `start ${ch.createDeployCode(bobAgent.id, bob, "imessage", "dm")}`);
  expect(one<any>("select user_id from external_identities where external_user_id='+1555bob'").user_id).toBe(bob);
  await text("+1555bob", "c-bob2", `start ${ch.createDeployCode(aliceAgent.id, alice, "imessage", "dm")}`);
  expect(last("c-bob2")).toMatch(/already linked to a different account/);
  expect(one<any>("select user_id from external_identities where external_user_id='+1555bob'").user_id).toBe(bob);
  expect(one("select 1 from room_members where principal_id=? and room_id=(select room_id from room_endpoints where external_conversation_id='c-bob')", alice)).toBeUndefined();
  // wrong kind / wrong app
  await text("+1555carl", "c-carl", `start ${ch.createDeployCode(aliceAgent.id, alice, "imessage", "group")}`);
  expect(last("c-carl")).toMatch(/for adding the agent to a group/);
  await text("+1555carl", "c-carl", `start ${ch.createDeployCode(aliceAgent.id, alice, "telegram", "dm")}`);
  expect(last("c-carl")).toMatch(/different app/);
  // group join links nobody
  await text("+1555dan", "g-1", `join ${ch.createDeployCode(aliceAgent.id, alice, "imessage", "group")}`, true);
  expect(one<any>("select u.guest from external_identities x join users u on u.id=x.user_id where x.external_user_id='+1555dan'").guest).toBe(1);
  // email can't redeem codes (From can be forged)
  exec("update agents set email_alias='alicebot' where id=?", aliceAgent.id);
  await ch.handleWebhook("email", "chi_shared_email", signed("email", "chi_shared_email", { type: "email.received", data: { email_id: "e1", from: "bob@x.test", to: ["alicebot@agents.test"], subject: "s", text: `start ${ch.createDeployCode(aliceAgent.id, alice, "email", "dm")}` } })); await settle();
  expect(one<any>("select user_id from external_identities where platform='email' and external_user_id='bob@x.test'")?.user_id).not.toBe(alice);
});

test("AC-S19 shared email routes by recipient alias: the same sender writing two workspaces' agents reaches each one", async () => {
  const a = user("A"), b = user("B"), wsA = workspace("WA", a), wsB = workspace("WB", b);
  const agA = customAgent(wsA, a, [], {}, "Aa"), agB = customAgent(wsB, b, [], {}, "Bb");
  exec("update agents set email_alias='aa' where id=?", agA.id); exec("update agents set email_alias='bb' where id=?", agB.id);
  const mail = async (to: string, t: string) => { await ch.handleWebhook("email", "chi_shared_email", signed("email", "chi_shared_email", { type: "email.received", data: { email_id: `m${Math.random()}`, from: "x@ext.test", to: [to], subject: "hi", text: t } })); await settle(); };
  await mail("aa@agents.test", "for A"); await mail("bb@agents.test", "for B");
  const roomOf = (t: string) => one<any>("select r.workspace_id from events e join rooms r on r.id=e.room_id where e.type='message' and json_extract(e.data,'$.text')=?", t).workspace_id;
  expect(roomOf("for A")).toBe(wsA); expect(roomOf("for B")).toBe(wsB);
  expect(net.to(/api\.resend\.com/).every((c) => c.body.to[0] === "x@ext.test")).toBe(true);
});

test("AC-S20 a pre-approval covers only its own watch, person and conversation", async () => {
  const ellie = user("Ellie"), ws = workspace("W", ellie);
  const reese = installAgent("reese-reservations", ws, ellie);
  const room = rt.privateRoomFor(ellie, reese);
  const target = new Date(now()); target.setDate(target.getDate() + 20); const date = ymd(target);
  await say(room.id, ellie, `Watch Lumen on ${date} for 2 between 7 and 9pm and book it if you can get it`);
  const apr = all<any>("select * from approvals where status='pending'")[0];
  rt.decideApproval(apr.id, ellie, "approve", { confirm: true }); await rt.drain();
  const st = one<any>("select * from standing_approvals");
  expect(J(st.constraints)).toMatchObject({ room_id: room.id, venue: "Lumen" });
  // Someone else, elsewhere, booking the same slot shape with this agent gets no free pass.
  const guest = user("Guest"), other = rt.createRoom({ workspace_id: ws, name: "G", participation: "manager", members: [{ id: guest, kind: "human" }, { id: reese.id, kind: "agent" }] });
  scriptModel(call("reservations.book", { venue_id: "sb-lumen", venue: "Lumen", date, time: "19:30", party_size: 2, watch_id: one<any>("select id from reservation_watches").id }), { text: "ok" });
  await say(other.id, guest, "book lumen");
  expect(J(all<any>("select data from events where type='PERMISSION_DECISION' order by seq desc limit 1")[0].data).decision).not.toBe("ALLOW");
  expect(one<any>("select uses from standing_approvals").uses).toBe(0);
  // ...and not even inside the same group chat: only the person who granted it.
  const grp = rt.createRoom({ workspace_id: ws, name: "Dinner crew", participation: "manager", members: [{ id: ellie, kind: "human" }, { id: guest, kind: "human" }, { id: reese.id, kind: "agent" }] });
  for (const r of all<any>("select id from standing_approvals")) patchJson("standing_approvals", "constraints", r.id, (c) => ({ ...c, room_id: grp.id }));
  exec("update reservation_watches set room_id=?", grp.id);
  scriptModel(call("reservations.book", { venue_id: "sb-lumen", venue: "Lumen", date, time: "19:30", party_size: 2, watch_id: one<any>("select id from reservation_watches").id }), { text: "ok" });
  await say(grp.id, guest, "book lumen");
  expect(J(all<any>("select data from events where type='PERMISSION_DECISION' order by seq desc limit 1")[0].data).decision).not.toBe("ALLOW");
  expect(one<any>("select uses from standing_approvals").uses).toBe(0);
});

test("AC-S21 a watch offers each opening once (no re-prompting after a no), and test mode creates no real watches", async () => {
  const ellie = user("Ellie"), ws = workspace("W", ellie);
  const reese = installAgent("reese-reservations", ws, ellie);
  const room = rt.privateRoomFor(ellie, reese);
  const target = new Date(now()); target.setDate(target.getDate() + 40); const date = ymd(target);
  await say(room.id, ellie, `Watch Kinjo on ${date} for 2 between 7 and 9pm and tell me when something opens`);
  advance(releaseAt(SANDBOX_VENUES.find((v) => v.id === "sb-kinjo")!, date) - now() + 1000); await rt.drain();
  expect(all("select * from approvals where tool_id='reservations.book'")).toHaveLength(1);
  rt.decideApproval(all<any>("select id from approvals where status='pending'")[0].id, ellie, "reject"); await rt.drain();
  for (let i = 0; i < 4; i++) { advance(6000); await rt.drain(); }
  expect(all("select * from approvals where tool_id='reservations.book'")).toHaveLength(1);
  expect(one<any>("select status from reservation_watches").status).toBe("paused");
  await say(room.id, ellie, "keep watching Kinjo");
  expect(one<any>("select status from reservation_watches").status).toBe("active");
  const test = rt.createRoom({ workspace_id: ws, name: "T", kind: "private", mode: "test", participation: "manager", members: [{ id: ellie, kind: "human" }, { id: reese.id, kind: "agent" }] });
  await say(test.id, ellie, `Watch Lumen on ${date} for 2 between 7 and 9pm`);
  expect(all("select * from reservation_watches where room_id=?", test.id)).toHaveLength(0);
  scriptModel(call("memory.remember", { text: "test fact", scope: "user_private" }), { text: "ok" });
  await say(test.id, ellie, "remember this");
  expect(all("select * from memories where text='test fact'")).toHaveLength(0);
});

test("AC-S22 a crash inside a run fails that run and doesn't block the conversation", async () => {
  const ellie = user("Ellie"), ws = workspace("W", ellie);
  const a = customAgent(ws, ellie, [], {}, "Ava");
  const room = rt.privateRoomFor(ellie, a);
  scriptModel({ toolCalls: "boom" as any });
  await say(room.id, ellie, "first");
  expect(all<any>("select status from runs").map((r) => r.status)).toEqual(["failed_terminal"]);
  scriptModel({ text: "still here" });
  await say(room.id, ellie, "second");
  expect(all<any>("select status from runs order by created_at").map((r) => r.status)).toEqual(["failed_terminal", "completed"]);
});

test("AC-S23 group orders: no competing order while one is open, and outsiders can't open one", async () => {
  const maria = user("Maria"), ws = workspace("W", maria);
  const pool = installAgent("pool-group-buying", ws, maria);
  link("imessage", "+1555maria", maria);
  const g = rt.createRoom({ workspace_id: ws, name: "G", members: [{ id: maria, kind: "human" }, { id: pool.id, kind: "agent" }] });
  await say(g.id, maria, "@Pool let's do a group order of coffee $45 each, venmo @maria");
  const eve = user("Eve");
  await say(g.id, eve, "@Pool let's do a group order of coffee $45 each, venmo @eve-scam");
  expect(all<any>("select payment_handle from group_orders").map((o) => o.payment_handle)).toEqual(["venmo:maria"]);
  const ben = user("Ben"); exec("insert into memberships values (?,?,'member',null)", ws, ben); // even a teammate can't start a competing order
  await say(g.id, ben, "@Pool let's do a group order of coffee $45 each, venmo @ben");
  expect(all<any>("select payment_handle from group_orders").map((o) => o.payment_handle)).toEqual(["venmo:maria"]);
  const g2 = rt.createRoom({ workspace_id: ws, name: "G2", members: [{ id: eve, kind: "human" }, { id: pool.id, kind: "agent" }] });
  await say(g2.id, eve, "@Pool let's do a group order of tea $10 each, venmo @eve-scam");
  expect(all("select * from group_orders where room_id=?", g2.id)).toHaveLength(0);
});

test("AC-S24 MCP calls re-check the address every time and never follow redirects", async () => {
  const r: any = await (await realFetch(new URL("/v1/auth/signup", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "E", email: "e@x.test", password: "password123" }) })).json();
  const ws = one<any>("select workspace_id from memberships where user_id=?", r.user.id).workspace_id;
  let privateNow = false;
  resolver.lookup = async (h: string) => [{ address: h === "flip.example" && privateNow ? "169.254.169.254" : "93.184.216.34" }];
  net.on(/flip\.example/, (_q, b) => b.method === "initialize" ? Response.json({ jsonrpc: "2.0", id: b.id, result: {} }) : b.method === "tools/list"
    ? Response.json({ jsonrpc: "2.0", id: b.id, result: { tools: [{ name: "peek", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] } }) : new Response(null, { status: 202 }));
  const c: any = await (await realFetch(new URL("/v1/connections", server.url), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${r.token}` },
    body: JSON.stringify({ workspace_id: ws, provider: "mcp", url: "https://flip.example/mcp" }) })).json();
  expect(c.tools).toHaveLength(1);
  privateNow = true; // DNS now points inside
  const before = net.calls.length;
  const res = await realFetch(new URL(`/v1/connections/${c.id}/refresh`, server.url), { method: "POST", headers: { authorization: `Bearer ${r.token}` } });
  expect(res.status).toBe(400);
  expect(net.calls.slice(before).filter((x) => /flip\.example/.test(x.url))).toHaveLength(0);
  resolver.lookup = async (h: string) => [{ address: /internal\.test$/.test(h) ? "10.0.0.5" : "93.184.216.34" }];
});

test("AC-S25 Slack can't be re-pointed to another workspace by re-installing", async () => {
  const a: any = await (await realFetch(new URL("/v1/auth/signup", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "A", email: "a@x.test", password: "password123" }) })).json();
  const b: any = await (await realFetch(new URL("/v1/auth/signup", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "B", email: "b@x.test", password: "password123" }) })).json();
  net.on(/oauth\.v2\.access/, () => Response.json({ ok: true, access_token: "xoxb", bot_user_id: "U", team: { id: "T9", name: "Shared" } }));
  const install = async (tok: string, wsUser: string) => {
    const ws = one<any>("select workspace_id from memberships where user_id=?", wsUser).workspace_id;
    const ag = customAgent(ws, wsUser, [], {}, "Bot");
    const go = await realFetch(new URL(`/v1/slack/install?agent=${ag.id}`, server.url), { headers: { authorization: `Bearer ${tok}` }, redirect: "manual" });
    const state = new URL(go.headers.get("location")!).searchParams.get("state")!;
    return (await realFetch(new URL(`/v1/slack/oauth/callback?code=x&state=${state}`, server.url), { headers: { authorization: `Bearer ${tok}` }, redirect: "manual" })).status;
  };
  expect(await install(a.token, a.user.id)).toBe(302);
  expect(await install(b.token, b.user.id)).toBe(409);
  expect(J(one<any>("select config from channel_identities where id='chi_slack_T9'").config).workspace_id).toBe(one<any>("select workspace_id from memberships where user_id=?", a.user.id).workspace_id);
});

test("AC-S30 OAuth state is single-use, short-lived and bound to the person who started it; Google uses PKCE and disconnect revokes at Google", async () => {
  const a: any = await (await realFetch(new URL("/v1/auth/signup", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "A", email: "a@x.test", password: "password123" }) })).json();
  const b: any = await (await realFetch(new URL("/v1/auth/signup", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "B", email: "b@x.test", password: "password123" }) })).json();
  const ws = one<any>("select workspace_id from memberships where user_id=?", a.user.id).workspace_id;
  process.env.GOOGLE_CLIENT_ID = "gid"; process.env.GOOGLE_CLIENT_SECRET = "gsecret";
  const start = await realFetch(new URL(`/v1/connections/google/start?workspace=${ws}`, server.url), { headers: { authorization: `Bearer ${a.token}` }, redirect: "manual" });
  const loc = new URL(start.headers.get("location")!), state = loc.searchParams.get("state")!;
  expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  const idToken = `x.${Buffer.from(JSON.stringify({ email: "a@gmail.test" })).toString("base64url")}.y`;
  net.on(/oauth2\.googleapis\.com\/token/, () => Response.json({ access_token: "ya29.A", refresh_token: "1//R", expires_in: 3600, id_token: idToken, scope: "email" }));
  const cb = (tok: string) => realFetch(new URL(`/v1/connections/google/callback?code=c&state=${state}`, server.url), { headers: { authorization: `Bearer ${tok}` }, redirect: "manual" });
  expect((await cb(b.token)).status).toBe(403); // someone else can't finish my sign-in (login CSRF)
  expect((await cb(a.token)).status).toBe(302);
  expect(net.to(/googleapis\.com\/token/).at(-1)!.body).toContain("code_verifier=");
  expect((await cb(a.token)).status).toBe(400); // replay
  const conn = one<any>("select * from connections where provider='google'");
  net.on(/oauth2\.googleapis\.com\/revoke/, () => new Response("{}"));
  await realFetch(new URL(`/v1/connections/${conn.id}/revoke`, server.url), { method: "POST", headers: { authorization: `Bearer ${a.token}` } });
  expect(net.to(/googleapis\.com\/revoke/)[0].url).toContain("token=1%2F%2FR");
  expect(one<any>("select status, cred_enc from connections where id=?", conn.id)).toEqual({ status: "revoked", cred_enc: null });
  delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET;
});
