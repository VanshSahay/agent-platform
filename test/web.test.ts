import { afterAll, describe, expect, test } from "bun:test";
import { Auth } from "../src/channels/auth.ts";
import { type ChannelInfo, startWebServer } from "../src/channels/web.ts";
import { reply } from "../src/model/scripted.ts";
import { groupWorld } from "./helpers.ts";
import { agentForChannel } from "../src/agent/routing.ts";

/** The group world behind a server with a stub sign-in: `Bearer as:<id>` is that person, anything else is nobody. */
function serve(opts: { eventToken?: string; lookupEmail?: Record<string, string>; channels?: ChannelInfo[] } = {}) {
  const w = groupWorld(() => reply("ok"));
  const zed = w.app.rooms.createPerson({ id: "zed", displayName: "Zed", timezone: "UTC" }); // signed in, in no room
  for (const id of ["alex", "sam", "jo", "riley", zed.id]) w.app.store.setKv(`clerk:${id}`, id);
  const auth = new Auth(
    w.app,
    { secretKey: "sk", publishableKey: "pk_test_x", authorizedParties: [] },
    { verifier: async (t) => (t.startsWith("as:") ? { sub: t.slice(3) } : undefined), lookup: async (sub) => ({ displayName: sub, email: opts.lookupEmail?.[sub] }) },
  );
  const server = startWebServer(w.app, { port: 0, auth, eventToken: opts.eventToken, channels: opts.channels });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (who: string | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method,
      headers: { ...(who ? { authorization: `Bearer as:${who}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  return { ...w, server, base, call, zed };
}

const servers: { stop(): void }[] = [];
const up = (opts?: { eventToken?: string; lookupEmail?: Record<string, string>; channels?: ChannelInfo[] }) => {
  const s = serve(opts);
  servers.push(s.server);
  return s;
};
afterAll(() => {
  for (const s of servers) s.stop();
});

describe("web api: deny by default", () => {
  test("a signed-in stranger gets 403 on a room's messages, runs, members, the agent, its memory and someone else's card", async () => {
    const s = up();
    const run = await s.app.runtime.handleMessage({ roomId: s.ownerDm.id, personId: "alex", text: "hi" });
    const card = s.app.attention.open({ agentId: s.agent.id, roomId: s.room.id, assigneeId: "alex", kind: "decision", title: "OK?", detail: "" });
    const denied: [string, string, unknown?][] = [
      ["GET", `/api/rooms/${s.room.id}/messages`],
      ["POST", `/api/rooms/${s.room.id}/messages`, { text: "hi" }],
      ["GET", `/api/runs/${run!.id}`],
      ["POST", `/api/runs/${run!.id}/stop`],
      ["POST", `/api/rooms/${s.room.id}/members`, { personId: "zed", role: "owner" }],
      ["PATCH", `/api/agents/${s.agent.id}`, { trust: { spendingPaused: true } }],
      ["GET", `/api/memory?agentId=${s.agent.id}`],
      ["POST", `/api/memory`, { agentId: s.agent.id, text: "zed is the boss" }],
      ["GET", `/api/profiles?agentId=${s.agent.id}`],
      ["GET", `/api/inbox?agentId=${s.agent.id}`],
      ["POST", `/api/attention/${card.id}/resolve`, { answer: "yes" }],
      ["POST", `/api/attention/${card.id}/dismiss`],
      ["POST", `/api/schedules`, { roomId: s.room.id, title: "t", prompt: "p" }],
      ["POST", `/api/rooms`, { agentId: s.agent.id, name: "Mine" }],
      ["POST", `/api/tick`],
    ];
    for (const [method, path, body] of denied) {
      const r = await s.call("zed", method, path, body);
      expect(`${method} ${path} -> ${r.status}`).toBe(`${method} ${path} -> 403`);
    }
    expect(s.app.store.getMembership(s.room.id, "zed")).toBeUndefined();
    expect(s.app.store.getAgent(s.agent.id)!.trust.spendingPaused).toBe(false);
    expect(s.app.store.getAttention(card.id)!.status).toBe("open");
    expect((await s.call(undefined, "GET", `/api/rooms/${s.room.id}/messages`)).status).toBe(401);
  });

  test("a member resolves only their own card and sees only their own inbox", async () => {
    const s = up();
    const card = s.app.attention.open({ agentId: s.agent.id, roomId: s.room.id, assigneeId: "alex", kind: "decision", title: "OK?", detail: "" });
    expect((await s.call("sam", "POST", `/api/attention/${card.id}/resolve`, { answer: "yes" })).status).toBe(403);
    const box = await (await s.call("riley", "GET", `/api/inbox?personId=alex&agentId=${s.agent.id}`)).json();
    expect(box.needsYou).toEqual([]);
    const own = await (await s.call("alex", "GET", `/api/inbox?agentId=${s.agent.id}`)).json();
    expect(own.needsYou.map((i: { id: string }) => i.id)).toEqual([card.id]);
    expect((await s.call("alex", "POST", `/api/attention/${card.id}/dismiss`)).status).toBe(200);
  });

  test("a co-member sees names, not addresses or phone numbers, and only labels of another person's run", async () => {
    const s = up();
    s.app.store.putPerson({
      ...s.app.store.getPerson("alex")!,
      phoneE164: "+14085550100",
      addresses: [{ id: "a1", label: "Home", line1: "1 Main St", city: "San Jose", country: "US" }],
    });
    const run = await s.app.runtime.handleMessage({ roomId: s.room.id, personId: "alex", text: "@pip hi" });
    const state = await (await s.call("riley", "GET", `/api/state`)).json();
    const alex = state.people.find((p: { id: string }) => p.id === "alex");
    expect(alex.displayName).toBe("Alex");
    expect(alex.phoneE164).toBeUndefined();
    expect(alex.addresses).toBeUndefined();
    expect(state.rooms[0].members.find((m: { personId: string }) => m.personId === "alex").person.phoneE164).toBeUndefined();
    const self = (await (await s.call("riley", "GET", `/api/people`)).json()).find((p: { id: string }) => p.id === "riley");
    expect(self.timezone).toBe("America/Los_Angeles");
    // The owner still sees everyone's details: they add and edit people.
    expect((await (await s.call("alex", "GET", `/api/people`)).json()).find((p: { id: string }) => p.id === "alex").phoneE164).toBe("+14085550100");
    const detail = await (await s.call("riley", "GET", `/api/runs/${run!.id}`)).json();
    expect(detail.toolCalls.every((c: { input: unknown; result: unknown }) => c.result === undefined)).toBe(true);
    expect((await s.call("riley", "POST", `/api/runs/${run!.id}/stop`)).status).toBe(403);
    const c = s.app.commitments.track({ agentId: s.agent.id, roomId: s.room.id, ownerId: "alex", title: "Pay Jo's rent" });
    expect((await s.call("riley", "POST", `/api/commitments/${c.id}`, { status: "done" })).status).toBe(403);
    expect((await s.call("alex", "POST", `/api/commitments/${c.id}`, { ownerId: "nobody" })).status).toBe(400);
    expect((await s.call("alex", "POST", `/api/commitments/${c.id}`, { status: "done" })).status).toBe(200);
  });

  test("on the shared pool a person registers their own handle, is texted first, and sees the number assigned to them", async () => {
    const registered = new Map<string, string>();
    const texts: [string, string][] = [];
    const handle: ChannelInfo["handle"] = {
      async register(phone) {
        registered.set(phone, "+17735550100");
        return { assignedPhone: "+17735550100" };
      },
      async assigned(phone) {
        return registered.get(phone);
      },
      async textFirst(phone, text) {
        texts.push([phone, text]);
      },
    };
    const s = up({ channels: [{ channel: "imessage", mode: "shared", handle }] });
    const before = await (await s.call("sam", "GET", `/api/channels`)).json();
    expect(before.channels[0]).toEqual({ channel: "imessage", phone: null, mode: "shared", agentId: s.agent.id });
    expect(before.mine.phone).toBeNull();
    expect((await s.call("sam", "POST", `/api/channels/register`, { phone: "408 555" })).status).toBe(400);
    const r = await (await s.call("sam", "POST", `/api/channels/register`, { phone: "+1 (408) 555-0100" })).json();
    expect(r.assignedPhone).toBe("+17735550100");
    expect(texts).toEqual([["+14085550100", expect.stringContaining("it's Pip")]]);
    expect(s.app.store.getPerson("sam")!.phoneE164).toBe("+14085550100");
    const after = await (await s.call("sam", "GET", `/api/channels`)).json();
    expect(after.mine.phone).toBe("+17735550100");
    expect((await s.call("sam", "GET", `/api/channels/vcard`)).status).toBe(200);
  });

  test("the owner's Memory tab shows group and own notes, never what another member told the assistant privately", async () => {
    const s = up();
    const samDm = s.app.rooms.dmFor(s.agent, "sam");
    s.app.memory.write({ agentId: s.agent.id, scope: "person", scopeId: "sam", type: "fact", text: "Sam is between jobs.", visibleToRooms: [samDm.id] });
    s.app.memory.write({ agentId: s.agent.id, scope: "person", scopeId: "sam", type: "preference", text: "Sam drives Thursdays.", visibleToRooms: [s.room.id] });
    s.app.memory.write({ agentId: s.agent.id, scope: "person", scopeId: "alex", type: "fact", text: "Alex prefers mornings.", visibleToRooms: [s.ownerDm.id] });
    s.app.memory.write({ agentId: s.agent.id, scope: "room", scopeId: samDm.id, type: "fact", text: "In Sam's chat.", visibleToRooms: [samDm.id] });
    const texts = (await (await s.call("alex", "GET", `/api/memory?agentId=${s.agent.id}`)).json()).memories.map((m: { text: string }) => m.text);
    expect(texts).toContain("Sam drives Thursdays.");
    expect(texts).toContain("Alex prefers mornings.");
    expect(texts).not.toContain("Sam is between jobs.");
    expect(texts).not.toContain("In Sam's chat.");
  });

  test("the owner succeeds, and trust is validated on the way in", async () => {
    const s = up();
    expect((await s.call("alex", "GET", `/api/rooms/${s.room.id}/messages`)).status).toBe(200);
    expect((await s.call("alex", "POST", `/api/rooms/${s.room.id}/messages`, { personId: "sam", text: "hi" })).status).toBe(200);
    // The body's personId is ignored: the message is Alex's.
    expect(
      s.app.store
        .messagesForRoom(s.room.id)
        .filter((m) => m.role === "user")
        .map((m) => m.authorId),
    ).toEqual(["alex"]);
    expect((await s.call("alex", "POST", `/api/rooms/${s.room.id}/members`, { personId: "zed", role: "member" })).status).toBe(200);
    expect((await s.call("alex", "POST", `/api/rooms/${s.room.id}/members`, { personId: "zed", role: "admin" })).status).toBe(400);
    expect((await s.call("alex", "PATCH", `/api/agents/${s.agent.id}`, { trust: { autoApproveUnderUsd: 20, autoAllow: ["send_sms"], spendingPaused: true } })).status).toBe(200);
    expect(s.app.store.getAgent(s.agent.id)!.trust).toMatchObject({ autoApproveUnderUsd: 20, autoAllow: ["send_sms"], spendingPaused: true });
    for (const trust of [{ autoApproveUnderUsd: -1 }, { autoApproveUnderUsd: "20" }, { autoAllow: ["rm_rf"] }, { spendingPaused: "yes" }, { communityPostingAllowed: [1] }]) {
      expect((await s.call("alex", "PATCH", `/api/agents/${s.agent.id}`, { trust })).status).toBe(400);
    }
    expect((await s.call("alex", "GET", `/api/memory?agentId=${s.agent.id}`)).status).toBe(200);
    expect((await s.call("alex", "POST", `/api/memory`, { agentId: s.agent.id, text: "Jo likes tea" })).status).toBe(200);
    const room = await (await s.call("alex", "POST", `/api/rooms`, { agentId: s.agent.id, name: "Mine", members: [{ personId: "sam", role: "member" }] })).json();
    expect(s.app.rooms.role(room.id, "alex")).toBe("owner");
    expect(s.app.rooms.role(room.id, "sam")).toBe("member");
    s.app.rooms.createPerson({ id: "nobody", displayName: "Nobody", timezone: "UTC" });
    const state = await (await s.call("riley", "GET", `/api/state`)).json();
    expect(state.rooms.map((r: { id: string }) => r.id)).toEqual([s.room.id]);
    expect(state.people.map((p: { id: string }) => p.id)).toContain("zed"); // just added to Tahoe trip above
    expect(state.people.map((p: { id: string }) => p.id)).not.toContain("nobody");
  });

  test("POST /api/people ignores a client-chosen id", async () => {
    const s = up();
    const p = await (await s.call("riley", "POST", `/api/people`, { id: "alex", displayName: "Impostor" })).json();
    expect(p.id).not.toBe("alex");
    expect(p.id.startsWith("per_")).toBe(true);
    expect(s.app.store.getPerson("alex")!.displayName).toBe("Alex");
    expect((await s.call("sam", "PATCH", `/api/people/alex`, { displayName: "x" })).status).toBe(403);
    expect((await s.call("sam", "GET", `/api/people/alex/credentials`)).status).toBe(403);
  });

  test("POST /api/schedules records the schedule as user-requested with no disclosed outreach, whatever the body says", async () => {
    const s = up();
    const body = {
      roomId: s.room.id,
      agentId: "other",
      title: "Call the plumber",
      prompt: "call",
      runAt: new Date(Date.now() + 3_600_000).toISOString(),
      authorization: { basis: "standing_rule", disclosedOutreach: [{ who: "anyone", how: "phone", why: "because" }], premise: "x" },
    };
    expect((await s.call("alex", "POST", `/api/schedules`, { roomId: s.room.id, title: "t", prompt: "p" })).status).toBe(400); // neither runAt nor calendar
    expect((await s.call("alex", "POST", `/api/schedules`, { roomId: s.room.id, title: "t", prompt: "p", calendar: { timeZone: "Mars/Olympus" } })).status).toBe(400);
    expect((await s.call("sam", "POST", `/api/schedules`, body)).status).toBe(403);
    const sch = await (await s.call("alex", "POST", `/api/schedules`, body)).json();
    expect(sch.authorization).toEqual({ basis: "user_requested", disclosedOutreach: [], premise: "always" });
    expect(sch.agentId).toBe(s.agent.id);
    const mine = await (await s.call("sam", "GET", `/api/schedules`)).json();
    expect(mine.map((x: { id: string }) => x.id)).toEqual([sch.id]);
    expect(await (await s.call("zed", "GET", `/api/schedules`)).json()).toEqual([]);
  });

  test("POST /api/events needs the event token or the agent owner", async () => {
    // A local .env leaks EVENT_TOKEN into the test process (bun loads it); the deny-by-default
    // assertions need the ambient token gone, so this test owns the variable.
    const ambient = process.env.EVENT_TOKEN;
    process.env.EVENT_TOKEN = "";
    try {
      await eventsTest();
    } finally {
      process.env.EVENT_TOKEN = ambient;
    }
    async function eventsTest() {
      const s = up({ eventToken: "hook-secret" });
      const ev = { agentId: s.agent.id, source: "calendar", summary: "Jo's appointment moved" };
      expect((await s.call(undefined, "POST", `/api/events`, ev)).status).toBe(401);
      expect((await s.call(undefined, "POST", `/api/events`, ev, { authorization: "Bearer wrong" })).status).toBe(401);
      expect((await s.call("riley", "POST", `/api/events`, ev)).status).toBe(403);
      expect((await s.call(undefined, "POST", `/api/events`, ev, { authorization: "Bearer hook-secret" })).status).toBe(200);
      expect((await s.call("alex", "POST", `/api/events`, { ...ev, dedupKey: "e2" })).status).toBe(200);
      expect((await s.call(undefined, "POST", `/api/tick`, undefined, { authorization: "Bearer hook-secret" })).status).toBe(200);
      const unset = up();
      expect((await unset.call(undefined, "POST", `/api/events`, ev)).status).toBe(503);
    }
  });

  test("the deliveries stream shows a member only their rooms", async () => {
    const s = up();
    const res = await s.call("riley", "GET", `/api/deliveries/watch`);
    const reader = res.body!.getReader();
    await s.app.runtime.handleMessage({ roomId: s.ownerDm.id, personId: "alex", text: "private" });
    await s.app.runtime.handleMessage({ roomId: s.room.id, personId: "alex", text: "@pip hi" });
    expect(s.deliveries.some((d) => d.roomId === s.ownerDm.id)).toBe(true);
    // Read until the first delivery line arrives; a leak would have put the private one first.
    const seen: { type?: string; roomId?: string }[] = [];
    const deadline = Date.now() + 2000;
    let buf = "";
    while (!seen.some((d) => d.type === "delivery") && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<{ value?: Uint8Array }>((r) => setTimeout(() => r({}), 500))]);
      if (!chunk.value) continue;
      buf += new TextDecoder().decode(chunk.value);
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const l of parts) if (l) seen.push(JSON.parse(l));
    }
    const got = seen.filter((d) => d.type === "delivery");
    expect(got.length).toBeGreaterThan(0);
    for (const d of got) expect(d.roomId).toBe(s.room.id);
    await reader.cancel();
  });

  test("bad bodies are 400 or 415, and a bad limit is clamped", async () => {
    const s = up();
    const raw = (ct: string, body: string) =>
      fetch(`${s.base}/api/rooms/${s.room.id}/messages`, { method: "POST", headers: { authorization: "Bearer as:alex", "content-type": ct }, body });
    expect((await raw("application/json", "{not json")).status).toBe(400);
    expect((await raw("application/json", "[1]")).status).toBe(400);
    expect((await raw("text/plain", '{"text":"hi"}')).status).toBe(415);
    expect((await s.call("alex", "GET", `/api/rooms/${s.room.id}/messages?limit=abc`)).status).toBe(200);
    const page = await s.call("alex", "GET", "/");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("chat search", () => {
  test("finds the rooms a person is in by message text or room name, with a snippet, and never another room", async () => {
    const s = up();
    await s.app.runtime.handleMessage({ roomId: s.room.id, personId: "riley", text: "@pip can you find a plumber for Jo's leaking kitchen tap?" });
    const r = await (await s.call("sam", "GET", "/api/search?q=leaking%20tap")).json();
    expect(r.results).toHaveLength(1);
    expect(r.results[0].roomName).toBe("Tahoe trip");
    expect(r.results[0].who).toBe("Riley");
    expect(r.results[0].snippet).toContain("leaking kitchen tap");
    expect((await (await s.call("zed", "GET", "/api/search?q=leaking%20tap")).json()).results).toEqual([]);
    expect((await (await s.call("sam", "GET", "/api/search?q=tah")).json()).results[0].roomName).toBe("Tahoe trip");
    expect((await (await s.call("sam", "GET", "/api/search?q=ta")).json()).results).toEqual([]);
  });
});

describe("invites", () => {
  test("the owner mints a link, a signed-in stranger joins through it as a member, and nobody else can mint one", async () => {
    const s = up();
    expect((await s.call("sam", "POST", `/api/rooms/${s.room.id}/invites`, {})).status).toBe(403);
    const { token, url } = await (await s.call("alex", "POST", `/api/rooms/${s.room.id}/invites`, {})).json();
    expect(url).toContain(`/#join=${token}`);
    expect((await (await s.call(undefined, "GET", `/api/invites/${token}`)).json()).roomName).toBe("Tahoe trip");
    expect((await s.call("zed", "GET", `/api/rooms/${s.room.id}/messages`)).status).toBe(403);
    const joined = await (await s.call("zed", "POST", `/api/invites/${token}/accept`, {})).json();
    expect(joined.room.id).toBe(s.room.id);
    expect(s.app.rooms.role(s.room.id, "zed")).toBe("member");
    expect((await s.call("zed", "GET", `/api/rooms/${s.room.id}/messages`)).status).toBe(200);
    expect((await s.call("zed", "POST", "/api/invites/nope-nope-nope/accept", {})).status).toBe(404);
  });
});

describe("document pages", () => {
  test("a member can share a page: before that a non-member gets a private page, after it anyone opens it and sees where Circle comes from", async () => {
    const s = up();
    const { newId } = await import("../src/core/ids.ts");
    const id = newId("art");
    s.app.store.putArtifact({
      id,
      agentId: s.agent.id,
      roomId: s.room.id,
      kind: "document",
      title: "Packing list",
      data: { markdown: "# Packing list\n- Boots" },
      share: "room",
      createdAt: s.clock.now(),
    });
    const closed = await s.call("zed", "GET", `/d/${id}`);
    expect(closed.status).toBe(403);
    expect(await closed.text()).toContain("This page is private");
    expect(await (await s.call("sam", "GET", `/d/${id}`)).text()).toContain("Share this page");
    expect((await s.call("zed", "PATCH", `/api/artifacts/${id}/share`, { share: "link" })).status).toBe(403);
    // The page itself has only the session cookie: a write with it needs the custom header a cross-site form cannot send.
    expect((await s.call(undefined, "PATCH", `/api/artifacts/${id}/share`, { share: "link" }, { cookie: "__session=as:sam" })).status).toBe(403);
    expect(await (await s.call(undefined, "PATCH", `/api/artifacts/${id}/share`, { share: "link" }, { cookie: "__session=as:sam", "x-requested-with": "circle" })).json()).toEqual({
      share: "link",
    });
    const open = await s.call("zed", "GET", `/d/${id}`);
    expect(open.status).toBe(200);
    // A visitor holding the link sees the page, not who is in the chat.
    expect((await (await s.call("zed", "GET", `/api/artifacts/${id}`)).json()).members).toEqual([]);
    const page = await open.text();
    expect(page).toContain("Packing list");
    expect(page).toContain("Get yours");
    expect(page).not.toContain("Share this page");
  });

  test("a document the assistant wrote is a shared checklist: ticks, claims and added items are kept per document and visible to members", async () => {
    const s = up();
    const { newId } = await import("../src/core/ids.ts");
    const id = newId("art");
    s.app.store.putArtifact({
      id,
      agentId: s.agent.id,
      roomId: s.room.id,
      kind: "document",
      title: "Packing list",
      data: { markdown: "# Packing list\n## Clothes\n- Boots\n- Hat\n## Food\n- Coffee" },
      share: "room",
      createdAt: s.clock.now(),
    });
    const page = await (await s.call("sam", "GET", `/d/${id}`)).text();
    expect(page).toContain("Packing list");
    expect(page).toContain('"key":"0-clothes:0-boots"');
    expect((await s.call("zed", "GET", `/api/artifacts/${id}`)).status).toBe(403);
    const first = await (await s.call("sam", "GET", `/api/artifacts/${id}`)).json();
    expect([...first.members].sort()).toEqual(["Alex", "Jo", "Riley", "Sam"]);
    expect(first.me).toBe("Sam");
    const st = await (
      await s.call("sam", "PATCH", `/api/artifacts/${id}/state`, {
        checked: { "0-clothes:0-boots": true },
        claimed: { "0-clothes:1-hat": "Jo" },
        add: { section: "1-food", text: "Marshmallows" },
      })
    ).json();
    expect(st.checked["0-clothes:0-boots"]).toBe("Sam");
    expect(st.claimed["0-clothes:1-hat"]).toBe("Jo");
    expect(st.claimedBy["0-clothes:1-hat"]).toBe("Sam"); // Sam put Jo down
    const forged = await (await s.call("sam", "PATCH", `/api/artifacts/${id}/state`, { claimed: { "0-clothes:0-boots": "Mallory" } })).json();
    expect(forged.claimed["0-clothes:0-boots"]).toBeUndefined(); // not a member of this chat
    expect(st.added["1-food"][0].text).toBe("Marshmallows");
    const again = await (await s.call("alex", "GET", `/api/artifacts/${id}`)).json();
    expect(again.state.checked["0-clothes:0-boots"]).toBe("Sam");
    // Page edits are events: the patch left a snapshot for the scheduler's diff.
    expect(s.app.store.getKv(`artedit:${id}`)).toBe("1");
    expect(JSON.parse(s.app.store.getKv("artedit:pending") ?? "[]")).toContain(id);
    await s.call("alex", "PATCH", `/api/artifacts/${id}/state`, { checked: { "0-clothes:0-boots": null } });
    expect((await (await s.call("alex", "GET", `/api/artifacts/${id}`)).json()).state.checked).toEqual({});
    expect(s.app.store.getKv(`artedit:${id}`)).toBe("2");
  });
});

describe("web api: attachments", () => {
  test("a photo a member attaches becomes an image artifact of the room, served raw to members and refused to a stranger", async () => {
    const s = up();
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("89504e470d0a1a0a", "hex")], "receipt.png", { type: "image/png" }));
    fd.append("roomId", s.room.id);
    fd.append("agentId", s.agent.id);
    const r = await fetch(`${s.base}/api/files`, { method: "POST", body: fd, headers: { authorization: "Bearer as:sam" } });
    expect(r.status).toBe(200);
    const { id, url } = (await r.json()) as { id: string; url: string };
    const art = s.app.store.getArtifact(id)!;
    expect(art.kind).toBe("image");
    expect(art.roomId).toBe(s.room.id);
    expect((art.data as { uploadedBy?: string }).uploadedBy).toBe("sam");
    const raw = await fetch(`${s.base}${url}?raw=1`, { headers: { authorization: "Bearer as:alex" } });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("image/png");
    expect((await fetch(`${s.base}${url}`, { headers: { authorization: "Bearer as:zed" } })).status).toBe(403);
  });
});

describe("web api: members", () => {
  test("the owner adds someone by email, changes their role, removes them; a member cannot; the owner cannot be removed", async () => {
    const s = up();
    const added = await (await s.call("alex", "POST", `/api/rooms/${s.room.id}/members`, { displayName: "Mia", email: "mia@example.com", role: "guest" })).json();
    expect(added.person.email).toBe("mia@example.com");
    expect(s.app.rooms.role(s.room.id, added.person.id)).toBe("guest");
    // Adding the same person again, now by phone, promotes the guest rather than creating a second record.
    const again = await (await s.call("alex", "POST", `/api/rooms/${s.room.id}/members`, { displayName: "Mia", email: "mia@example.com" })).json();
    expect(again.person.id).toBe(added.person.id);
    expect(s.app.rooms.role(s.room.id, added.person.id)).toBe("member");
    expect((await s.call("sam", "DELETE", `/api/rooms/${s.room.id}/members/${added.person.id}`)).status).toBe(403);
    expect((await s.call("alex", "DELETE", `/api/rooms/${s.room.id}/members/alex`)).status).toBe(404);
    expect((await s.call("alex", "DELETE", `/api/rooms/${s.room.id}/members/${added.person.id}`)).status).toBe(200);
    expect(s.app.rooms.role(s.room.id, added.person.id)).toBeUndefined();
  });

  test("someone added by email before signing in gets that same seat on first sign-in", async () => {
    const s = up({ lookupEmail: { newbie: "mia@example.com" } });
    const added = await (await s.call("alex", "POST", `/api/rooms/${s.room.id}/members`, { displayName: "Mia", email: "mia@example.com" })).json();
    const me = await (await s.call("newbie", "GET", "/api/me")).json();
    expect(me.id).toBe(added.person.id);
    expect((await s.call("newbie", "GET", `/api/rooms/${s.room.id}/messages`)).status).toBe(200);
  });
});

describe("web api: channels", () => {
  test("a signed-in person gets a link code with the number to text and a QR; the list shows what is up", async () => {
    const s = up({ channels: [{ channel: "imessage", phone: "+14155550123" }] });
    const list = await (await s.call("alex", "GET", "/api/channels")).json();
    expect(list.channels).toEqual([{ channel: "imessage", phone: "+14155550123", mode: "dedicated", agentId: s.agent.id }]);
    expect(list.mine.phone).toBe("+14155550123");
    const r = await (await s.call("alex", "POST", "/api/channels/link-code", {})).json();
    expect(r.code).toMatch(/^\d{8}$/);
    expect(r.sms).toBe(`sms:+14155550123?&body=${r.code}`);
    expect(r.qr).toContain("<svg");
    expect((await s.call(undefined, "POST", "/api/channels/link-code", {})).status).toBe(401);
  });
});

describe("web api: many agents", () => {
  test("an owner runs a second agent: puts it on the iMessage line, hands a chat to it, gives it a model, tools and skills", async () => {
    const s = up({ channels: [{ channel: "imessage", phone: "+14155550123" }] });
    const created = await (await s.call("alex", "POST", "/api/agents", { name: "Juno", purpose: "Trips and bookings" })).json();
    expect(created.ownerId).toBe("alex");
    // The line answers as Juno now; a group added on it gets Juno with no code change.
    expect((await s.call("alex", "PUT", "/api/channels/imessage/agent", { agentId: created.id })).status).toBe(200);
    expect(agentForChannel(s.app.store, "imessage")!.id).toBe(created.id);
    expect((await (await s.call("alex", "GET", "/api/channels")).json()).channels[0].agentId).toBe(created.id);
    // Someone else's agent cannot be put on Alex's line, nor handed Alex's chat.
    const zeds = await (await s.call("zed", "POST", "/api/agents", { name: "Zed's" })).json();
    expect((await s.call("zed", "PUT", "/api/channels/imessage/agent", { agentId: s.agent.id })).status).toBe(403);
    expect((await s.call("alex", "PATCH", `/api/rooms/${s.room.id}`, { agentId: zeds.id })).status).toBe(403);
    // Alex hands the trip chat to Juno.
    const moved = await (await s.call("alex", "PATCH", `/api/rooms/${s.room.id}`, { agentId: created.id })).json();
    expect(moved.agentId).toBe(created.id);
    // A chosen model is kept (pinned); tools and skills lists are stored, and null clears them.
    const tuned = await (
      await s.call("alex", "PATCH", `/api/agents/${created.id}`, { model: "anthropic/claude-sonnet-5.5", tools: ["calls", "web_search"], skills: ["travel-and-trips"] })
    ).json();
    expect(tuned.model).toBe("anthropic/claude-sonnet-5.5");
    expect(tuned.modelPinned).toBe(true);
    expect(tuned.tools).toEqual(["calls", "web_search"]);
    expect((await s.call("alex", "PATCH", `/api/agents/${created.id}`, { tools: "everything" })).status).toBe(400);
    const cleared = await (await s.call("alex", "PATCH", `/api/agents/${created.id}`, { tools: null, model: "" })).json();
    expect(cleared.tools).toBeUndefined();
    expect(cleared.modelPinned).toBe(false);
  });

  test("the settings screen can list what an agent may be narrowed to: skills by name, tool families without the always-on core", async () => {
    const s = up();
    const opts = await (await s.call("alex", "GET", "/api/agents/options")).json();
    expect(opts.families).toContain("calls");
    expect(opts.skills.every((k: { name: string }) => !k.name.startsWith("_"))).toBe(true);
    expect((await s.call(undefined, "GET", "/api/agents/options")).status).toBe(401);
  });
});

describe("web api: inspect and stop", () => {
  test("delegated work is stopped by the person who asked or the owner, nobody else; the radar lists it", async () => {
    const s = up();
    const task = s.app.tasks.create({ agentId: s.agent.id, roomId: s.room.id, requesterId: "sam", title: "Compare three movers", instructions: "quotes for Saturday" });
    const inbox = await (await s.call("jo", "GET", `/api/inbox?agentId=${s.agent.id}`)).json();
    expect(inbox.tasks.map((t: { id: string }) => t.id)).toEqual([task.id]);
    expect((await s.call("jo", "POST", `/api/tasks/${task.id}/stop`, {})).status).toBe(403);
    expect((await s.call("zed", "POST", `/api/tasks/${task.id}/stop`, {})).status).toBe(403);
    const stopped = await (await s.call("sam", "POST", `/api/tasks/${task.id}/stop`, {})).json();
    expect(stopped.status).toBe("stopped");
  });
});

describe("operations", () => {
  test("/health answers 200 while the loops beat, 503 once one misses three beats, and never carries an error's text", async () => {
    const s = up();
    s.app.ops.beat("scheduler", 60_000);
    s.app.ops.error("tick", new Error("upstream said Bearer abc.def.ghi for sk-or-v1-0123456789abcdef"));
    const fine = await s.call(undefined, "GET", "/health");
    expect(fine.status).toBe(200);
    const body = await fine.json();
    expect(body.recentErrors).toBe(1);
    expect(JSON.stringify(body)).not.toContain("upstream");
    s.clock.set(s.clock.now() + 4 * 60_000);
    expect((await s.call(undefined, "GET", "/health")).status).toBe(503);
  });

  test("the error log is for the operator only, with secrets taken out before it is stored", async () => {
    const s = up();
    s.app.ops.error("imessage send", new Error("401 for token=abcd1234 with Bearer abc.def and sk-or-v1-0123456789abcdef"));
    expect((await s.call("sam", "GET", "/api/ops/errors")).status).toBe(403);
    const { errors } = await (await s.call("alex", "GET", "/api/ops/errors")).json();
    expect(errors[0].source).toBe("imessage send");
    expect(errors[0].message).toBe("401 for token=[redacted] with Bearer [redacted] and [key]");
  });

  test("editing an agent does not change which agent is the oldest, so the default line agent stays put", async () => {
    const s = up();
    const second = await (await s.call("alex", "POST", "/api/agents", { name: "Juno" })).json();
    expect(s.app.store.listAgents()[0]!.id).toBe(s.agent.id);
    await s.call("alex", "PATCH", `/api/agents/${s.agent.id}`, { instructions: "be brief" });
    expect(s.app.store.listAgents()[0]!.id).toBe(s.agent.id);
    expect(s.app.store.listAgents()[1]!.id).toBe(second.id);
  });
});

test("two owners naming their assistants the same keep both: the second gets its own handle", async () => {
  const s = up();
  const a = await (await s.call("alex", "POST", "/api/agents", { name: "Juno" })).json();
  const b = await (await s.call("zed", "POST", "/api/agents", { name: "Juno" })).json();
  expect(a.handle).toBe("juno");
  expect(b.handle).toBe("juno-2");
  expect(s.app.store.getAgent(a.id)).toBeDefined();
  expect(() => s.app.store.putAgent({ ...b, handle: "juno" })).toThrow();
});

test("the owner's off switch stops a waiting errand, runs nothing new, holds reminders, and back on they fire", async () => {
  const s = up();
  const card = s.app.attention.open({ agentId: s.agent.id, roomId: s.room.id, assigneeId: "alex", kind: "decision", title: "OK?", detail: "" });
  const waiting = await s.app.runtime.handleMessage({ roomId: s.room.id, personId: "sam", text: "@pip book it" });
  s.app.store.putRun({ ...waiting!, status: "waiting", waitingOn: card.id, endedAt: undefined });
  expect((await s.call("sam", "PATCH", `/api/agents/${s.agent.id}`, { paused: true })).status).toBe(403);
  expect((await s.call("alex", "PATCH", `/api/agents/${s.agent.id}`, { paused: true })).status).toBe(200);
  expect(s.app.store.getRun(waiting!.id)!.status).toBe("stopped");
  const calls = s.model.calls.length;
  const next = await s.app.runtime.handleMessage({ roomId: s.room.id, personId: "sam", text: "@pip hello?" });
  expect(next!.status).toBe("stopped");
  expect(s.model.calls.length).toBe(calls);
  s.app.commitments.track({ roomId: s.room.id, agentId: s.agent.id, ownerId: "sam", title: "Bring the stove", dueAt: s.clock.now() + 3 * 3600_000 });
  s.clock.set(s.clock.now() + 2 * 3600_000);
  expect((await s.app.scheduler.tick()).nudged).toBe(0);
  await s.call("alex", "PATCH", `/api/agents/${s.agent.id}`, { paused: false });
  expect((await s.app.scheduler.tick()).nudged).toBe(1);
});
