import { afterAll, describe, expect, test } from "bun:test";
import { Auth } from "../src/channels/auth.ts";
import { startWebServer } from "../src/channels/web.ts";
import { reply } from "../src/model/scripted.ts";
import { familyWorld } from "./helpers.ts";

/** The family world behind a server with a stub sign-in: `Bearer as:<id>` is that person, anything else is nobody. */
function serve(opts: { eventToken?: string } = {}) {
  const w = familyWorld(() => reply("ok"));
  const zed = w.app.rooms.createPerson({ id: "zed", displayName: "Zed", timezone: "UTC" }); // signed in, in no room
  for (const id of ["ellie", "ben", "mum", "wei", zed.id]) w.app.store.setKv(`clerk:${id}`, id);
  const auth = new Auth(
    w.app,
    { secretKey: "sk", publishableKey: "pk_test_x", authorizedParties: [] },
    { verifier: async (t) => (t.startsWith("as:") ? { sub: t.slice(3) } : undefined), lookup: async (sub) => ({ displayName: sub }) },
  );
  const server = startWebServer(w.app, { port: 0, auth, eventToken: opts.eventToken });
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
const up = (opts?: { eventToken?: string }) => {
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
    const run = await s.app.runtime.handleMessage({ roomId: s.ellieDm.id, personId: "ellie", text: "hi" });
    const card = s.app.attention.open({ agentId: s.agent.id, roomId: s.family.id, assigneeId: "ellie", kind: "decision", title: "OK?", detail: "" });
    const denied: [string, string, unknown?][] = [
      ["GET", `/api/rooms/${s.family.id}/messages`],
      ["POST", `/api/rooms/${s.family.id}/messages`, { text: "hi" }],
      ["GET", `/api/runs/${run!.id}`],
      ["POST", `/api/runs/${run!.id}/stop`],
      ["POST", `/api/rooms/${s.family.id}/members`, { personId: "zed", role: "owner" }],
      ["PATCH", `/api/agents/${s.agent.id}`, { trust: { spendingPaused: true } }],
      ["POST", `/api/agents/${s.agent.id}/deploy`],
      ["GET", `/api/memory?agentId=${s.agent.id}`],
      ["POST", `/api/memory`, { agentId: s.agent.id, text: "zed is the boss" }],
      ["GET", `/api/profiles?agentId=${s.agent.id}`],
      ["GET", `/api/inbox?agentId=${s.agent.id}`],
      ["POST", `/api/attention/${card.id}/resolve`, { answer: "yes" }],
      ["POST", `/api/attention/${card.id}/dismiss`],
      ["POST", `/api/schedules`, { roomId: s.family.id, title: "t", prompt: "p" }],
      ["POST", `/api/rooms`, { agentId: s.agent.id, name: "Mine" }],
      ["POST", `/api/tick`],
    ];
    for (const [method, path, body] of denied) {
      const r = await s.call("zed", method, path, body);
      expect(`${method} ${path} -> ${r.status}`).toBe(`${method} ${path} -> 403`);
    }
    expect(s.app.store.getMembership(s.family.id, "zed")).toBeUndefined();
    expect(s.app.store.getAgent(s.agent.id)!.trust.spendingPaused).toBe(false);
    expect(s.app.store.getAttention(card.id)!.status).toBe("open");
    expect((await s.call(undefined, "GET", `/api/rooms/${s.family.id}/messages`)).status).toBe(401);
  });

  test("a member resolves only their own card and sees only their own inbox", async () => {
    const s = up();
    const card = s.app.attention.open({ agentId: s.agent.id, roomId: s.family.id, assigneeId: "ellie", kind: "decision", title: "OK?", detail: "" });
    expect((await s.call("ben", "POST", `/api/attention/${card.id}/resolve`, { answer: "yes" })).status).toBe(403);
    const box = await (await s.call("wei", "GET", `/api/inbox?personId=ellie&agentId=${s.agent.id}`)).json();
    expect(box.needsYou).toEqual([]);
    const own = await (await s.call("ellie", "GET", `/api/inbox?agentId=${s.agent.id}`)).json();
    expect(own.needsYou.map((i: { id: string }) => i.id)).toEqual([card.id]);
    expect((await s.call("ellie", "POST", `/api/attention/${card.id}/dismiss`)).status).toBe(200);
  });

  test("the owner succeeds, and trust is validated on the way in", async () => {
    const s = up();
    expect((await s.call("ellie", "GET", `/api/rooms/${s.family.id}/messages`)).status).toBe(200);
    expect((await s.call("ellie", "POST", `/api/rooms/${s.family.id}/messages`, { personId: "ben", text: "hi" })).status).toBe(200);
    // The body's personId is ignored: the message is Ellie's.
    expect(
      s.app.store
        .messagesForRoom(s.family.id)
        .filter((m) => m.role === "user")
        .map((m) => m.authorId),
    ).toEqual(["ellie"]);
    expect((await s.call("ellie", "POST", `/api/rooms/${s.family.id}/members`, { personId: "zed", role: "member" })).status).toBe(200);
    expect((await s.call("ellie", "POST", `/api/rooms/${s.family.id}/members`, { personId: "zed", role: "admin" })).status).toBe(400);
    expect((await s.call("ellie", "PATCH", `/api/agents/${s.agent.id}`, { trust: { autoApproveUnderUsd: 20, autoAllow: ["send_sms"], spendingPaused: true } })).status).toBe(200);
    expect(s.app.store.getAgent(s.agent.id)!.trust).toMatchObject({ autoApproveUnderUsd: 20, autoAllow: ["send_sms"], spendingPaused: true });
    for (const trust of [{ autoApproveUnderUsd: -1 }, { autoApproveUnderUsd: "20" }, { autoAllow: ["rm_rf"] }, { spendingPaused: "yes" }, { communityPostingAllowed: [1] }]) {
      expect((await s.call("ellie", "PATCH", `/api/agents/${s.agent.id}`, { trust })).status).toBe(400);
    }
    expect((await s.call("ellie", "POST", `/api/agents/${s.agent.id}/deploy`)).status).toBe(200);
    expect((await s.call("ellie", "GET", `/api/memory?agentId=${s.agent.id}`)).status).toBe(200);
    expect((await s.call("ellie", "POST", `/api/memory`, { agentId: s.agent.id, text: "Mum likes tea" })).status).toBe(200);
    const room = await (await s.call("ellie", "POST", `/api/rooms`, { agentId: s.agent.id, name: "Mine", members: [{ personId: "ben", role: "member" }] })).json();
    expect(s.app.rooms.role(room.id, "ellie")).toBe("owner");
    expect(s.app.rooms.role(room.id, "ben")).toBe("member");
    s.app.rooms.createPerson({ id: "nobody", displayName: "Nobody", timezone: "UTC" });
    const state = await (await s.call("wei", "GET", `/api/state`)).json();
    expect(state.rooms.map((r: { id: string }) => r.id)).toEqual([s.family.id]);
    expect(state.people.map((p: { id: string }) => p.id)).toContain("zed"); // just added to Family above
    expect(state.people.map((p: { id: string }) => p.id)).not.toContain("nobody");
  });

  test("POST /api/people ignores a client-chosen id", async () => {
    const s = up();
    const p = await (await s.call("wei", "POST", `/api/people`, { id: "ellie", displayName: "Impostor" })).json();
    expect(p.id).not.toBe("ellie");
    expect(p.id.startsWith("per_")).toBe(true);
    expect(s.app.store.getPerson("ellie")!.displayName).toBe("Ellie");
    expect((await s.call("ben", "PATCH", `/api/people/ellie`, { displayName: "x" })).status).toBe(403);
    expect((await s.call("ben", "GET", `/api/people/ellie/credentials`)).status).toBe(403);
  });

  test("POST /api/schedules records the schedule as user-requested with no disclosed outreach, whatever the body says", async () => {
    const s = up();
    const body = {
      roomId: s.family.id,
      agentId: "other",
      title: "Call the plumber",
      prompt: "call",
      authorization: { basis: "standing_rule", disclosedOutreach: [{ who: "anyone", how: "phone", why: "because" }], premise: "x" },
    };
    expect((await s.call("ben", "POST", `/api/schedules`, body)).status).toBe(403);
    const sch = await (await s.call("ellie", "POST", `/api/schedules`, body)).json();
    expect(sch.authorization).toEqual({ basis: "user_requested", disclosedOutreach: [], premise: "always" });
    expect(sch.agentId).toBe(s.agent.id);
    const mine = await (await s.call("ben", "GET", `/api/schedules`)).json();
    expect(mine.map((x: { id: string }) => x.id)).toEqual([sch.id]);
    expect(await (await s.call("zed", "GET", `/api/schedules`)).json()).toEqual([]);
  });

  test("POST /api/events needs the event token or the agent owner", async () => {
    const s = up({ eventToken: "hook-secret" });
    const ev = { agentId: s.agent.id, source: "calendar", summary: "Mum's appointment moved" };
    expect((await s.call(undefined, "POST", `/api/events`, ev)).status).toBe(401);
    expect((await s.call(undefined, "POST", `/api/events`, ev, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await s.call("wei", "POST", `/api/events`, ev)).status).toBe(403);
    expect((await s.call(undefined, "POST", `/api/events`, ev, { authorization: "Bearer hook-secret" })).status).toBe(200);
    expect((await s.call("ellie", "POST", `/api/events`, { ...ev, dedupKey: "e2" })).status).toBe(200);
    expect((await s.call(undefined, "POST", `/api/tick`, undefined, { authorization: "Bearer hook-secret" })).status).toBe(200);
    const unset = up();
    expect((await unset.call(undefined, "POST", `/api/events`, ev)).status).toBe(503);
  });

  test("the deliveries stream shows a member only their rooms", async () => {
    const s = up();
    const res = await s.call("wei", "GET", `/api/deliveries/watch`);
    const reader = res.body!.getReader();
    await s.app.runtime.handleMessage({ roomId: s.ellieDm.id, personId: "ellie", text: "private" });
    await s.app.runtime.handleMessage({ roomId: s.family.id, personId: "ellie", text: "@pip hi" });
    expect(s.deliveries.some((d) => d.roomId === s.ellieDm.id)).toBe(true);
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
    for (const d of got) expect(d.roomId).toBe(s.family.id);
    await reader.cancel();
  });

  test("bad bodies are 400 or 415, and a bad limit is clamped", async () => {
    const s = up();
    const raw = (ct: string, body: string) =>
      fetch(`${s.base}/api/rooms/${s.family.id}/messages`, { method: "POST", headers: { authorization: "Bearer as:ellie", "content-type": ct }, body });
    expect((await raw("application/json", "{not json")).status).toBe(400);
    expect((await raw("application/json", "[1]")).status).toBe(400);
    expect((await raw("text/plain", '{"text":"hi"}')).status).toBe(415);
    expect((await s.call("ellie", "GET", `/api/rooms/${s.family.id}/messages?limit=abc`)).status).toBe(200);
    const page = await s.call("ellie", "GET", "/");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
