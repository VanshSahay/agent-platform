import { afterAll, describe, expect, test } from "bun:test";
import { Auth } from "../src/channels/auth.ts";
import { startWebServer } from "../src/channels/web.ts";
import { reply } from "../src/model/scripted.ts";
import { groupWorld } from "./helpers.ts";

/** The group world behind a server with a stub sign-in: `Bearer as:<id>` is that person, anything else is nobody. */
function serve(opts: { eventToken?: string; lookupEmail?: Record<string, string>; channels?: { channel: string; phone?: string }[] } = {}) {
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
const up = (opts?: { eventToken?: string; lookupEmail?: Record<string, string>; channels?: { channel: string; phone?: string }[] }) => {
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
      authorization: { basis: "standing_rule", disclosedOutreach: [{ who: "anyone", how: "phone", why: "because" }], premise: "x" },
    };
    expect((await s.call("sam", "POST", `/api/schedules`, body)).status).toBe(403);
    const sch = await (await s.call("alex", "POST", `/api/schedules`, body)).json();
    expect(sch.authorization).toEqual({ basis: "user_requested", disclosedOutreach: [], premise: "always" });
    expect(sch.agentId).toBe(s.agent.id);
    const mine = await (await s.call("sam", "GET", `/api/schedules`)).json();
    expect(mine.map((x: { id: string }) => x.id)).toEqual([sch.id]);
    expect(await (await s.call("zed", "GET", `/api/schedules`)).json()).toEqual([]);
  });

  test("POST /api/events needs the event token or the agent owner", async () => {
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
    expect(st.added["1-food"][0].text).toBe("Marshmallows");
    const again = await (await s.call("alex", "GET", `/api/artifacts/${id}`)).json();
    expect(again.state.checked["0-clothes:0-boots"]).toBe("Sam");
    await s.call("alex", "PATCH", `/api/artifacts/${id}/state`, { checked: { "0-clothes:0-boots": null } });
    expect((await (await s.call("alex", "GET", `/api/artifacts/${id}`)).json()).state.checked).toEqual({});
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
    expect(list.channels).toEqual([{ channel: "imessage", phone: "+14155550123" }]);
    const r = await (await s.call("alex", "POST", "/api/channels/link-code", {})).json();
    expect(r.code).toMatch(/^\d{6}$/);
    expect(r.sms).toBe(`sms:+14155550123?&body=${r.code}`);
    expect(r.qr).toContain("<svg");
    expect((await s.call(undefined, "POST", "/api/channels/link-code", {})).status).toBe(401);
  });
});
