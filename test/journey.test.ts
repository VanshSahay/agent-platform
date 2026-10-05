// End-user journeys, driven exactly as a person would: HTTP API for the web app, signed webhooks for phones and Slack.
// Register -> describe the agent -> test it safely -> one-click deploy -> it does real work where people already talk.
import { test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { one, all, J, S, exec, advance, now } from "../src/db";
import * as rt from "../src/runtime";
import * as ch from "../src/channels";
import { releaseAt, SANDBOX_VENUES, ymd } from "../src/reservations";
import { serve, worker, attempts } from "../src/server";
import { setup, realFetch, net, signed, imsg, slackMsg, SECRETS } from "./helpers";

let server: ReturnType<typeof serve>;
beforeAll(() => { server = serve(0); });
afterAll(() => server.stop(true));
beforeEach(() => {
  setup(); attempts.clear();
  Object.assign(process.env, { SHARED_IMESSAGE_LINE: "+15550001000", SHARED_IMESSAGE_API_URL: "https://photon.test", SHARED_IMESSAGE_API_KEY: "ph", SHARED_IMESSAGE_WEBHOOK_SECRET: SECRETS.imessage.webhook_secret,
    SHARED_TELEGRAM_BOT_USERNAME: "agents_bot", SHARED_TELEGRAM_BOT_TOKEN: "1:tok", SHARED_TELEGRAM_WEBHOOK_SECRET: SECRETS.telegram.webhook_secret,
    SLACK_CLIENT_ID: "cid", SLACK_CLIENT_SECRET: "csecret", SLACK_SIGNING_SECRET: SECRETS.slack.signing_secret });
  ch.ensureSharedIdentities();
});

async function api(path: string, token?: string, body?: any, method?: string) {
  const r = await realFetch(new URL(path, server.url), { method: method ?? (body ? "POST" : "GET"), redirect: "manual",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data: any = text; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, headers: r.headers };
}
async function register(name: string) {
  const r = await api("/v1/auth/signup", undefined, { name, email: `${name.toLowerCase()}@example.com`, password: "password123" });
  const me = await api("/v1/me", r.data.token);
  return { id: r.data.user.id as string, token: r.data.token as string, ws: me.data.workspaces[0].id as string };
}
const settle = async () => { await worker(); await rt.drain(); };
const text = async (handle: string, chat: string, body: string, group = false, name = "Me") => {
  await ch.handleWebhook("imessage", "chi_shared_imessage", signed("imessage", "chi_shared_imessage", imsg(chat, handle, name, body, group))); await settle();
};
const photon = () => net.to(/photon\.test\/messages/).map((c) => c.body);
const lastPhoton = (chat: string) => photon().filter((m) => m.chat_id === chat).at(-1)?.text as string;

test("AC-J1 personal: register → describe → test safely → one-click iMessage → real work over text, same agent on web", async () => {
  expect((await realFetch(new URL("/", server.url))).headers.get("content-type")).toContain("text/html"); // landing page
  const me = await register("Ellie");
  const draft = (await api("/v1/agents/draft", me.token, { description: "An assistant that watches my email, handles my calendar and reminds me about follow-ups", workspace_id: me.ws })).data;
  const ava = (await api("/v1/agents", me.token, { workspace_id: me.ws, ...draft })).data;
  expect(ava.name).toBe("Ava");

  // Test mode: the whole pipeline runs, approvals included, but nothing is sent.
  const testRoom = (await api(`/v1/agents/${ava.id}/test-room`, me.token, {})).data;
  expect(testRoom.mode).toBe("test");
  await api(`/v1/rooms/${testRoom.id}/messages`, me.token, { text: "Email sam@example.com about dinner on Friday" }); await settle();
  const apr = (await api(`/v1/rooms/${testRoom.id}`, me.token)).data.approvals[0];
  expect(apr.summary).toMatch(/Send email to sam@example.com/);
  await api(`/v1/approvals/${apr.id}/decision`, me.token, { decision: "approve" }); await settle();
  expect(net.to(/gmail/)).toHaveLength(0);
  expect(JSON.stringify((await api(`/v1/runs/${apr.run_id}`, me.token)).data.tool_executions)).toContain("test mode");
  await api(`/v1/rooms/${testRoom.id}/messages`, me.token, { text: "What's on my calendar this week?" }); await settle();
  expect((await api(`/v1/rooms/${testRoom.id}`, me.token)).data.events.filter((e: any) => e.type === "message").at(-1).data.text).toMatch(/sample/);
  expect((await api(`/v1/rooms?workspace=${me.ws}`, me.token)).data.some((r: any) => r.id === testRoom.id)).toBe(false); // test rooms stay out of the room list

  // One-click deploy: the button opens Messages with the code prefilled.
  const dep = (await api(`/v1/agents/${ava.id}/deploy/imessage`, me.token, { kind: "dm" })).data;
  expect(dep.link).toBe(`sms:+15550001000?&body=${encodeURIComponent(`start ${dep.code}`)}`);
  await text("+15557770001", "chat-ellie", dep.message);
  expect(lastPhoton("chat-ellie")).toMatch(/Hi, I'm Ava/);
  await text("+15557770001", "chat-ellie", "Remind me to call mom in 30 minutes");
  expect(lastPhoton("chat-ellie")).toMatch(/Reminder set/);
  advance(31 * 60e3); await settle();
  // Same agent, same room on web; the deploy page shows the connection.
  const deploy = (await api(`/v1/agents/${ava.id}/deploy`, me.token)).data;
  const im = deploy.targets.find((t: any) => t.platform === "imessage");
  expect(im).toMatchObject({ available: true, address: "+15550001000" });
  expect(im.connected[0].conv).toBe("chat-ellie");
  const web = (await api(`/v1/rooms/${im.connected[0].room_id}`, me.token)).data;
  expect(web.events.filter((e: any) => e.type === "message").map((e: any) => e.data.platform)).toContain("imessage");
  // A stranger texting the shared line gets instructions, not an agent.
  await text("+15559999999", "chat-stranger", "hello?");
  expect(lastPhoton("chat-stranger")).toMatch(/To talk to an agent here/);
});

test("AC-J2 team: create for my team → Add to Slack → pick a channel → teammates use it in Slack and an iMessage group", async () => {
  const lead = await register("Sarah"), mate = await register("James");
  const team = (await api("/v1/workspaces", lead.token, { name: "Acme Ops" })).data;
  const inv = (await api(`/v1/workspaces/${team.id}/invitations`, lead.token, {})).data;
  await api(`/v1/invitations/${inv.token}/accept`, mate.token, {});
  const relay = (await api("/v1/agent-templates/relay-ops/install", lead.token, { workspace_id: team.id })).data.agent;

  // Add to Slack (OAuth): redirect, then Slack calls back with a code.
  const go = await api(`/v1/slack/install?agent=${relay.id}`, lead.token);
  expect(go.status).toBe(302);
  const state = new URL(go.headers.get("location")!).searchParams.get("state")!;
  net.on(/oauth\.v2\.access/, () => Response.json({ ok: true, access_token: "xoxb-team", bot_user_id: "UBOT", team: { id: "T1", name: "Acme" } }));
  net.on(/conversations\.list/, () => Response.json({ ok: true, channels: [{ id: "C42", name: "ops", is_private: false }] }));
  expect((await api(`/v1/slack/oauth/callback?code=x&state=${state}`, lead.token)).status).toBe(302); // same signed-in person finishes it
  const chans = (await api(`/v1/agents/${relay.id}/slack/channels`, lead.token)).data;
  expect(chans[0]).toMatchObject({ id: "C42", name: "ops" });
  const bound = (await api(`/v1/agents/${relay.id}/slack/channels`, lead.token, { identity: chans[0].identity, channel_id: "C42", name: "ops" })).data;
  // James asks in #ops (Slack's single app URL; routed by team)
  require("../src/db").exec("insert or replace into external_identities (platform, external_user_id, user_id, verified) values ('slack','UJ',?,1)", mate.id);
  const ev = { ...slackMsg("C42", "UJ", "<@UBOT> take care of the BLS follow-ups"), team_id: "T1" };
  expect((await ch.handleSlackApp(signed("slack", "app", ev))).status).toBe(200); await settle();
  expect(net.to(/chat\.postMessage/).at(-1)!.body).toMatchObject({ channel: "C42" });
  expect(net.to(/chat\.postMessage/).at(-1)!.headers.authorization).toBe("Bearer xoxb-team");
  expect(all("select * from tasks where room_id=?", bound.room_id)).toHaveLength(1);

  // Same agent in the field team's iMessage group
  const g = (await api(`/v1/agents/${relay.id}/deploy/imessage`, lead.token, { kind: "group" })).data;
  expect(g.instructions).toMatch(/Add \+15550001000 to your group chat, then send "join \d{8}"/);
  await text("+1555lead", "grp-field", g.message, true, "Sarah");
  expect(lastPhoton("grp-field")).toMatch(/^Relay: Relay joined this group/);
  await text("+1555field", "grp-field", "@Relay what's the status?", true, "Kim");
  expect(lastPhoton("grp-field")).toMatch(/^Relay: /);
  // Account-level view: one place shows what every agent does and where it lives
  const ov = (await api("/v1/overview", lead.token)).data.find((w: any) => w.workspace.id === team.id).agents[0];
  expect(ov).toMatchObject({ name: "Relay", open_tasks: 1 });
  expect(ov.deployed.sort()).toEqual(["imessage", "slack", "web"]);
  expect((await api(`/v1/tasks?workspace=${team.id}`, mate.token)).data[0]).toMatchObject({ title: "BLS follow-ups", agent: "Relay" });
});

test("AC-J3 reservations: watch a hot spot, pre-approve limits once, it books the instant tables drop and texts you", async () => {
  const me = await register("Ellie");
  const reese = (await api("/v1/agent-templates/reese-reservations/install", me.token, { workspace_id: me.ws })).data.agent;
  const dep = (await api(`/v1/agents/${reese.id}/deploy/imessage`, me.token, { kind: "dm" })).data;
  await text("+15557770001", "chat-r", dep.message);

  // A normal booking: options, then a one-tap approval.
  await text("+15557770001", "chat-r", "Book a table at Osteria Nove on Friday for 4 around 8");
  expect(lastPhoton("chat-r")).toMatch(/Reese wants to: Book Osteria Nove, \w{3}, \w{3} \d+ at \d+:\d\d[ap]m for 4/);
  await text("+15557770001", "chat-r", "approve");
  expect(lastPhoton("chat-r")).toMatch(/🎉 Booked: Osteria Nove/);

  // A hot spot: Lumen releases tables 14 days ahead at 10am and they're gone in two minutes.
  const target = new Date(now()); target.setDate(target.getDate() + 20); const date = ymd(target);
  const lumen = SANDBOX_VENUES.find((v) => v.id === "sb-lumen")!;
  await text("+15557770001", "chat-r", `Watch Lumen on ${date} for 2 between 7 and 9pm and book it if you can get it`);
  expect(lastPhoton("chat-r")).toMatch(/strong confirmation — reply "confirm (\w{4})"/);
  const code = lastPhoton("chat-r").match(/confirm (\w{4})/)![1];
  await text("+15557770001", "chat-r", `confirm ${code}`);
  expect(lastPhoton("chat-r")).toMatch(/Auto-book is on for Lumen/);
  const w = one<any>("select * from reservation_watches where status='active'");
  expect(w.release_at).toBe(releaseAt(lumen, date));
  // Jump to 30s before the drop; the watch is polling every few seconds by then.
  advance(releaseAt(lumen, date) - now() - 30_000); await settle();
  expect(one<any>("select status from reservation_watches where id=?", w.id).status).toBe("active");
  advance(35_000); await settle();
  expect(one<any>("select status from reservation_watches where id=?", w.id).status).toBe("booked");
  expect(lastPhoton("chat-r")).toMatch(/🎉 Booked: Lumen, .* at 7:30pm for 2/);
  expect(J(all<any>("select data from events where type='PERMISSION_DECISION' order by seq desc limit 1")[0].data).reason).toMatch(/pre-approved within your limits/);
  // Limits hold: a second table for the same watch would need a new approval.
  expect(one<any>("select status, uses from standing_approvals")).toMatchObject({ status: "used", uses: 1 });
});

test("AC-J4 reservations without pre-approval: you get a one-tap card the moment a table opens; too slow means an honest miss", async () => {
  const me = await register("Ellie");
  const reese = (await api("/v1/agent-templates/reese-reservations/install", me.token, { workspace_id: me.ws })).data.agent;
  const dep = (await api(`/v1/agents/${reese.id}/deploy/imessage`, me.token, { kind: "dm" })).data;
  await text("+15557770002", "chat-k", dep.message);
  const target = new Date(now()); target.setDate(target.getDate() + 40); const date = ymd(target);
  const kinjo = SANDBOX_VENUES.find((v) => v.id === "sb-kinjo")!;
  await text("+15557770002", "chat-k", `Watch Kinjo on ${date} for 2 between 7 and 9pm and tell me when something opens`);
  advance(releaseAt(kinjo, date) - now() + 2_000); await settle();
  expect(lastPhoton("chat-k")).toMatch(/Book Kinjo, .* \(\$50\/person deposit\)/); // deposit -> financial -> strong confirmation
  expect(lastPhoton("chat-k")).toMatch(/confirm \w{4}/);
  advance(3 * 60e3); await settle(); // they answer after the table is gone
  const c = lastPhoton("chat-k").match(/confirm (\w{4})/)?.[1] ?? all<any>("select id from approvals where status='pending'")[0].id.slice(-4);
  await text("+15557770002", "chat-k", `confirm ${c}`);
  expect(lastPhoton("chat-k")).toMatch(/Couldn't book Kinjo — someone else got it first/);
  expect(all("select * from reservations where venue_id='sb-kinjo'")).toHaveLength(0);
});

test("AC-J5 group buying in an iMessage group: open, join without tagging, tally, reminder, auto-close with pay links", async () => {
  const maria = await register("Maria");
  const pool = (await api("/v1/agent-templates/pool-group-buying/install", maria.token, { workspace_id: maria.ws })).data.agent;
  const dm = (await api(`/v1/agents/${pool.id}/deploy/imessage`, maria.token, { kind: "dm" })).data;
  await text("+1555maria", "chat-maria", dm.message); // Maria links her phone once so Pool recognizes her in groups
  const g = (await api(`/v1/agents/${pool.id}/deploy/imessage`, maria.token, { kind: "group" })).data;
  await text("+1555maria", "grp-coffee", g.message, true, "Maria");
  const fri = new Date(now()); fri.setDate(fri.getDate() + 3);
  await text("+1555maria", "grp-coffee", `@Pool let's do a group order of Ethiopian coffee 5lb bags $45 each, minimum 4, closes ${ymd(fri)} 6pm, venmo @maria-k`, true, "Maria");
  expect(lastPhoton("grp-coffee")).toMatch(/Pool: 🛒 Group order open[\s\S]*\$45[\s\S]*Minimum: 4/);
  await text("+1555ana", "grp-coffee", "in for 2", true, "Ana");
  expect(lastPhoton("grp-coffee")).toMatch(/Got it, Ana: 2 × .*coffee.*Now 2\/4/i);
  await text("+1555ben", "grp-coffee", "put me down for 1", true, "Ben");
  await text("+1555ben", "grp-coffee", "actually make mine 2", true, "Ben");
  await text("+1555cal", "grp-coffee", "lol nice", true, "Cal"); // chatter: no reply
  expect(lastPhoton("grp-coffee")).toMatch(/Ben: 2 × .*Now 4\/4 ✅/);
  await text("+1555cal", "grp-coffee", "who's in?", true, "Cal");
  expect(lastPhoton("grp-coffee")).toMatch(/4\/4[\s\S]*Ana \(2\), Ben \(2\)/);
  await text("+1555ana", "grp-coffee", "close the order", true, "Ana");
  expect(lastPhoton("grp-coffee")).toMatch(/only Maria \(the organizer\) can close/);
  advance(fri.setHours(18, 0, 0, 0) - now() - 23 * 3600e3); await settle();
  expect(lastPhoton("grp-coffee")).toMatch(/⏰ 24h left/);
  advance(24 * 3600e3); await settle();
  const closed = lastPhoton("grp-coffee");
  expect(closed).toMatch(/🔒 .* is closed — 4 total/);
  expect(closed).toContain("Ana: $90 → https://venmo.com/maria-k?txn=pay&amount=90.00");
  await text("+1555ana", "grp-coffee", "paid!", true, "Ana");
  expect(lastPhoton("grp-coffee")).toMatch(/✓ Ana marked as paid \(self-reported\)/);
});

test("AC-J6 agent-level and account-level memory: teach an agent once; your personal facts follow you across your agents", async () => {
  const me = await register("Ellie");
  const reese = (await api("/v1/agent-templates/reese-reservations/install", me.token, { workspace_id: me.ws })).data.agent;
  const ava = (await api("/v1/agent-templates/ava-executive-assistant/install", me.token, { workspace_id: me.ws })).data.agent;
  await api("/v1/memory", me.token, { workspace_id: me.ws, scope: "agent", agent_id: reese.id, text: "Always prefer bar seating when it's just two people" });
  expect((await api("/v1/memory", me.token, { workspace_id: me.ws, scope: "user_private", text: "Ellie is vegetarian" })).status).toBe(200);
  const { scriptModel } = await import("./helpers");
  const seen = scriptModel({ text: "ok" });
  for (const a of [reese, ava]) { const room = (await api(`/v1/agents/${a.id}/private-room`, me.token, {})).data; await api(`/v1/rooms/${room.id}/messages`, me.token, { text: "any dinner ideas for two, I'm vegetarian?" }); await settle(); }
  expect(seen[0].system).toContain("bar seating");           // Reese's own memory
  expect(seen[1].system).not.toContain("bar seating");       // ...not Ava's
  expect(seen.every((r) => r.system.includes("vegetarian"))).toBe(true); // account-level, private to Ellie
  const agentMem = (await api(`/v1/memory?workspace=${me.ws}&agent=${reese.id}`, me.token)).data.map((m: any) => m.scope_type);
  expect(agentMem).toEqual(expect.arrayContaining(["agent", "user_private"]));
});

test("AC-J7 real-time group chat: quick replies while an order is still opening aren't lost; same-day orders don't get an instant '24h left'", async () => {
  process.env.DEBOUNCE_MS = "1500";
  const maria = await register("Maria");
  const pool = (await api("/v1/agent-templates/pool-group-buying/install", maria.token, { workspace_id: maria.ws })).data.agent;
  await text("+1555maria", "chat-maria", (await api(`/v1/agents/${pool.id}/deploy/imessage`, maria.token, { kind: "dm" })).data.message);
  const g = (await api(`/v1/agents/${pool.id}/deploy/imessage`, maria.token, { kind: "group" })).data;
  const raw = (h: string, n: string, t: string) => ch.handleWebhook("imessage", "chi_shared_imessage", signed("imessage", "chi_shared_imessage", imsg("grp-q", h, n, t, true)));
  await raw("+1555maria", "Maria", g.message); await settle();
  // A short order: closes 3-4 hours from now (not "11pm tonight", which has already passed late in the day).
  const soon = new Date(now() + 4 * 36e5); soon.setMinutes(0, 0, 0); const h = soon.getHours();
  await raw("+1555maria", "Maria", `@Pool let's do a group order of dumplings $12 each, closes ${ymd(soon)} ${h % 12 || 12}${h < 12 ? "am" : "pm"}, venmo @maria-k`);
  await raw("+1555ana", "Ana", "in for 2"); // arrives before the order exists
  await settle(); advance(2000); await settle(); advance(2000); await settle();
  expect(photon().filter((m) => m.chat_id === "grp-q").map((m) => m.text).join("\n")).toMatch(/Got it, Ana: 2 × dumplings/);
  expect(photon().some((m) => m.chat_id === "grp-q" && /24h left/.test(m.text))).toBe(false);
  process.env.DEBOUNCE_MS = "0";
});
