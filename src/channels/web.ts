import { readFileSync } from "node:fs";
import { deployAgent } from "../agent/deploy.ts";
import { SuggestionService } from "../inbox/suggestions.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { App } from "../app.ts";
import type { Commitment, MemoryScope, Person, Profile } from "../core/types.ts";
import type { Delivery } from "../runtime/runtime.ts";
import { newAgent } from "../agent/spec.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import { Auth, authConfig, frontendApiFromKey } from "./auth.ts";

/**
 * The web channel: a JSON API and one page for the owner. The API shape is
 * what we learned works: a message creates a run; a watch stream replays
 * events after a cursor; the inbox is one list with statuses.
 */
export function startWebServer(app: App, opts: { port?: number; hostname?: string; auth?: Auth | null } = {}) {
  const suggestions = new SuggestionService(app.store, app.clock, app.commitments, app.model);
  const here = dirname(fileURLToPath(import.meta.url));
  const cfg = authConfig();
  const auth = opts.auth === undefined ? (cfg ? new Auth(app, cfg) : null) : opts.auth;
  const clerkBoot =
    auth && cfg
      ? `<script>window.__CLERK_PK=${JSON.stringify(cfg.publishableKey)};window.__CLERK_FAPI=${JSON.stringify(frontendApiFromKey(cfg.publishableKey) ?? "")};</script>`
      : "";
  const webDir = join(here, "..", "..", "web");
  const html = readFileSync(join(webDir, "index.html"), "utf8").replace("<!--AUTH-->", clerkBoot);
  // The script and stylesheet are read per request so edits show on reload.
  const asset = (name: string, type: string) => new Response(readFileSync(join(webDir, name)), { headers: { "content-type": type, "cache-control": "no-cache" } });
  const sockets = new Set<ReadableStreamDefaultController<string>>();
  app.onDeliver((d) => broadcast({ type: "delivery", ...d }));
  const broadcast = (payload: unknown) => {
    const line = JSON.stringify(payload) + "\n";
    for (const c of sockets) {
      try {
        c.enqueue(line);
      } catch {
        sockets.delete(c);
      }
    }
  };

  const listPeople = () => (app.store.db.query("SELECT data FROM persons ORDER BY created_at").all() as { data: string }[]).map((r) => JSON.parse(r.data) as Person);
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const bad = (msg: string, status = 400) => json({ error: msg }, status);

  const server = Bun.serve({
    port: opts.port ?? Number(process.env.PORT ?? 3000),
    hostname: opts.hostname ?? "0.0.0.0",
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      try {
        if (p === "/" || p === "/index.html") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
        if (p === "/app.js") return asset("app.js", "text/javascript; charset=utf-8");
        if (p === "/styles.css") return asset("styles.css", "text/css; charset=utf-8");
        if (p === "/health") return json({ ok: true, now: app.clock.now(), auth: !!auth });

        // With Clerk configured, every API call is made as a signed-in person; the body may not impersonate anyone else.
        let me: string | undefined;
        if (auth && p.startsWith("/api/")) {
          const person = await auth.personFor(req);
          if (!person) return bad("sign in required", 401);
          me = person.id;
        }
        if (p === "/api/me") return json(me ? app.store.getPerson(me) : null);
        const asMe = (b: Record<string, unknown>) => (me ? { ...b, personId: me } : b);

        // ---- bootstrap: people, agents, rooms
        if (p === "/api/state" && req.method === "GET") {
          const agents = app.store.listAgents();
          const rooms = me ? app.store.listRooms().filter((r) => !!app.store.getMembership(r.id, me!)) : app.store.listRooms();
          return json({
            agents,
            people: listPeople(),
            rooms: rooms.map((r) => ({ ...r, members: app.rooms.members(r.id).map((m) => ({ ...m, person: app.store.getPerson(m.personId) })) })),
          });
        }
        if (p === "/api/people" && req.method === "GET") return json(listPeople());
        if (p === "/api/people" && req.method === "POST") {
          const b = await req.json();
          return json(app.rooms.createPerson({ id: b.id, displayName: b.displayName, timezone: b.timezone ?? "UTC", pronouns: b.pronouns, phoneE164: b.phoneE164, techComfort: b.techComfort }));
        }
        if (p.match(/^\/api\/people\/[^/]+$/) && req.method === "PATCH") {
          const id = p.split("/")[3]!;
          if (me && id !== me) return bad("you can only edit yourself", 403);
          const person = app.store.getPerson(id);
          if (!person) return bad("no such person", 404);
          const b = await req.json();
          Object.assign(person, { displayName: b.displayName ?? person.displayName, timezone: b.timezone ?? person.timezone, pronouns: b.pronouns ?? person.pronouns, phoneE164: b.phoneE164 ?? person.phoneE164, email: b.email ?? person.email, techComfort: b.techComfort ?? person.techComfort });
          app.store.putPerson(person);
          return json(person);
        }
        if (p === "/api/agents" && req.method === "POST") {
          const b = await req.json();
          const a = newAgent({ ownerId: me ?? b.ownerId, name: b.name, purpose: b.purpose, instructions: b.instructions, trust: b.trust });
          app.store.putAgent(a);
          return json(a);
        }
        if (p.startsWith("/api/agents/") && req.method === "PATCH") {
          const a = app.store.getAgent(p.split("/")[3]!);
          if (!a) return bad("no such agent", 404);
          const b = await req.json();
          Object.assign(a, { name: b.name ?? a.name, purpose: b.purpose ?? a.purpose, instructions: b.instructions ?? a.instructions, effort: b.effort ?? a.effort, trust: { ...a.trust, ...(b.trust ?? {}) }, soul: { ...a.soul, ...(b.soul ?? {}) } });
          app.store.putAgent(a);
          return json(a);
        }
        // Deploying ends training: the same check the Settings page shows.
        if (p.match(/^\/api\/agents\/[^/]+\/deploy$/) && req.method === "POST") {
          const r = deployAgent(app.store, app.clock, p.split("/")[3]!);
          if (!r.ok) return bad(r.why, r.why === "no such agent" ? 404 : 409);
          return json(r.agent);
        }
        if (p === "/api/suggestions" && req.method === "GET") {
          const person = app.store.getPerson(me ?? url.searchParams.get("personId") ?? "");
          const agent = app.store.getAgent(url.searchParams.get("agentId") ?? "");
          if (!person || !agent) return bad("personId and agentId required");
          return json(await suggestions.forHome(person, agent));
        }
        if (p === "/api/rooms" && req.method === "POST") {
          const b = await req.json();
          const agentForRoom = app.store.getAgent(b.agentId ?? "");
          if (!agentForRoom) return bad("no such agent", 404);
          if ((b.kind ?? "group") === "group" && !agentForRoom.deployedAt) return bad("deploy the agent first: train it in your private chat, then press Deploy", 409);
          const room = app.rooms.createRoom({ agentId: b.agentId, kind: b.kind ?? "group", channel: b.channel ?? "web", name: b.name, externalId: b.externalId, outreachHours: b.outreachHours });
          for (const m of b.members ?? []) app.rooms.addMember(room.id, m.personId, m.role, { consented: !!m.consented });
          return json(room);
        }
        if (p.match(/^\/api\/rooms\/[^/]+\/members$/) && req.method === "POST") {
          const roomId = p.split("/")[3]!;
          const b = await req.json();
          return json(app.rooms.addMember(roomId, b.personId, b.role ?? "member", { consented: !!b.consented }));
        }

        // ---- chat
        if (p.match(/^\/api\/rooms\/[^/]+\/messages$/)) {
          const roomId = p.split("/")[3]!;
          if (req.method === "GET") {
            // Each assistant message carries its run's recorded steps, so the UI can show "Completed N steps" from records.
            const msgs = app.store.messagesForRoom(roomId, Number(url.searchParams.get("limit") ?? 100)).map((m) => {
              if (m.role !== "assistant" || !m.runId || m.source === "notice") return m;
              const steps = app.store.toolCallsForRun(m.runId).map((c) => ({ name: c.name, label: c.labelDone, status: c.status, verified: !!c.evidence }));
              return { ...m, steps };
            });
            const session = app.store.latestSessionForRoom(roomId);
            const active = session ? app.store.activeRunForSession(session.id) : undefined;
            const activeSteps = active ? app.store.toolCallsForRun(active.id).map((c) => ({ name: c.name, label: c.status === "running" ? c.labelRunning : c.labelDone, status: c.status })) : [];
            return json({ messages: msgs, activeRun: active ? { id: active.id, status: active.status, trigger: active.trigger, steps: activeSteps } : null });
          }
          const b = asMe(await req.json());
          if (me && !app.store.getMembership(roomId, me)) return bad("not a member of this room", 403);
          const run = await app.runtime.handleMessage({ roomId, personId: String(b.personId), text: String(b.text ?? ""), dedupKey: b.dedupKey ? String(b.dedupKey) : undefined });
          return json({ run, session: app.store.latestSessionForRoom(roomId) });
        }
        if (p.match(/^\/api\/sessions\/[^/]+\/events$/)) {
          const sessionId = p.split("/")[3]!;
          return json(app.store.eventsAfter(sessionId, Number(url.searchParams.get("after") ?? 0)));
        }
        // Watch: replay after cursor, then stream live. NDJSON, one event per line, each with its seq.
        if (p.match(/^\/api\/sessions\/[^/]+\/watch$/)) {
          const sessionId = p.split("/")[3]!;
          let cursor = Number(url.searchParams.get("after") ?? 0);
          const stream = new ReadableStream<string>({
            start(controller) {
              for (const e of app.store.eventsAfter(sessionId, cursor)) (controller.enqueue(JSON.stringify({ event: e }) + "\n"), (cursor = e.seq));
              const timer = setInterval(() => {
                try {
                  for (const e of app.store.eventsAfter(sessionId, cursor)) (controller.enqueue(JSON.stringify({ event: e }) + "\n"), (cursor = e.seq));
                  controller.enqueue(JSON.stringify({ ping: cursor }) + "\n");
                } catch {
                  clearInterval(timer);
                }
              }, 1000);
            },
          });
          return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" } });
        }
        if (p === "/api/deliveries/watch") {
          const stream = new ReadableStream<string>({
            start(c) {
              sockets.add(c);
            },
            cancel() {
              /* removed on next failed enqueue */
            },
          });
          return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" } });
        }
        if (p.match(/^\/api\/runs\/[^/]+$/)) {
          const run = app.store.getRun(p.split("/")[3]!);
          if (!run) return bad("no such run", 404);
          return json({ run, toolCalls: app.store.toolCallsForRun(run.id), plan: app.planner.get(run.id), events: app.store.eventsForRun(run.id) });
        }
        if (p.match(/^\/api\/runs\/[^/]+\/stop$/) && req.method === "POST") {
          await app.runtime.stop(p.split("/")[3]!);
          return json({ ok: true });
        }

        // ---- home: needs you / on radar / last activity
        if (p === "/api/inbox") {
          const personId = url.searchParams.get("personId") ?? "";
          const agentId = url.searchParams.get("agentId") ?? "";
          return json(app.attention.inbox(personId, agentId));
        }
        if (p.match(/^\/api\/attention\/[^/]+\/resolve$/) && req.method === "POST") {
          const b = asMe(await req.json());
          const item = app.store.getAttention(p.split("/")[3]!);
          if (me && item && item.assigneeId !== me && !["owner", "decider"].includes(app.rooms.role(item.roomId, me) ?? "")) return bad("not yours to answer", 403);
          const run = await app.runtime.answerAttention(p.split("/")[3]!, String(b.answer ?? ""), b.personId ? String(b.personId) : undefined);
          return json({ ok: true, run });
        }
        if (p.match(/^\/api\/attention\/[^/]+\/dismiss$/) && req.method === "POST") return json(app.attention.dismiss(p.split("/")[3]!));

        // ---- schedules, commitments, memory
        if (p === "/api/schedules" && req.method === "GET") return json(app.store.listSchedules({ agentId: url.searchParams.get("agentId") ?? undefined }));
        if (p === "/api/schedules" && req.method === "POST") {
          const b = await req.json();
          const session = app.store.latestSessionForRoom(b.roomId);
          return json(
            Scheduler.createSchedule(app.store, app.clock, {
              agentId: b.agentId,
              roomId: b.roomId,
              sessionId: session?.id ?? "none",
              title: b.title,
              prompt: b.prompt,
              runAt: b.runAt ? Date.parse(b.runAt) : undefined,
              calendar: b.calendar,
              authorization: b.authorization ?? { basis: "user_requested", disclosedOutreach: [], premise: b.premise ?? "always" },
            }),
          );
        }
        if (p.match(/^\/api\/schedules\/[^/]+\/pause$/) && req.method === "POST") {
          const b = await req.json();
          app.scheduler.pause(p.split("/")[3]!, !!b.paused);
          return json({ ok: true });
        }
        if (p === "/api/commitments" && req.method === "GET") return json(app.store.listCommitments({ roomId: url.searchParams.get("roomId") ?? undefined }));
        if (p.match(/^\/api\/commitments\/[^/]+$/) && req.method === "POST") {
          const id = p.split("/")[3]!;
          const c = app.store.getCommitment(id);
          if (!c) return bad("no such responsibility", 404);
          if (me && !app.store.getMembership(c.roomId, me)) return bad("not a member of this room", 403);
          const b = await req.json();
          const status = b.status as Commitment["status"] | undefined;
          if (status && !["open", "done", "dropped", "blocked"].includes(status)) return bad("status must be open, done, dropped or blocked");
          return json(app.commitments.update(id, { status, dueAt: b.dueAt !== undefined ? Number(b.dueAt) : undefined, detail: b.detail, ownerId: b.ownerId }));
        }
        // Derived profiles: one per scope the agent has a summary for (itself, each room, each person).
        if (p === "/api/profiles" && req.method === "GET") {
          const agentId = url.searchParams.get("agentId") ?? "";
          const out: Profile[] = [];
          const add = (scope: MemoryScope, scopeId: string) => {
            const prof = app.store.getProfile(agentId, scope, scopeId);
            if (prof) out.push(prof);
          };
          add("agent", agentId);
          for (const r of app.store.listRooms(agentId)) add("room", r.id);
          for (const person of listPeople()) add("person", person.id);
          return json(out);
        }
        if (p === "/api/memory" && req.method === "GET") {
          const agentId = url.searchParams.get("agentId") ?? "";
          return json({ memories: app.store.listMemories(agentId, { includeInactive: url.searchParams.get("all") === "1" }), consolidatedAt: app.store.getKv(`consolidated:${agentId}`) });
        }
        if (p === "/api/memory" && req.method === "POST") {
          const b = await req.json();
          return json(app.memory.write({ agentId: b.agentId, scope: b.scope ?? "agent", scopeId: b.scopeId ?? b.agentId, type: b.type ?? "fact", text: b.text, aliases: b.aliases, visibleToRooms: b.visibleToRooms }));
        }
        if (p.match(/^\/api\/memory\/[^/]+$/) && req.method === "DELETE") {
          app.memory.retract(p.split("/")[3]!);
          return json({ ok: true });
        }
        if (p === "/api/memory/consolidate" && req.method === "POST") {
          const b = await req.json();
          const agent = app.store.getAgent(b.agentId);
          if (!agent) return bad("no such agent", 404);
          return json(await app.consolidator.runFor(agent));
        }
        if (p === "/api/tick" && req.method === "POST") return json(await app.scheduler.tick());
        return bad("not found", 404);
      } catch (e) {
        return bad(String((e as Error).message), 500);
      }
    },
  });
  return server;
}

export type { Delivery };
