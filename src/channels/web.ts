import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deployAgent } from "../agent/deploy.ts";
import { newAgent } from "../agent/spec.ts";
import type { App } from "../app.ts";
import type { AgentSpec, AttentionItem, Calendar, Commitment, MemberRole, MemoryScope, Profile, Room, TrustPolicy } from "../core/types.ts";
import type { Delivery } from "../runtime/runtime.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import { SuggestionService } from "../inbox/suggestions.ts";
import { listPeople, peopleVisibleTo } from "../store/queries.ts";
import { Auth, authConfig, frontendApiFromKey } from "./auth.ts";

/**
 * The web channel: a JSON API and one page for the owner. The API shape is
 * what we learned works: a message creates a run; a watch stream replays
 * events after a cursor; the inbox is one list with statuses.
 *
 * Every route declares who may call it; the policy runs before the handler.
 * With Clerk on, the caller is the signed-in person and nothing else; with
 * Clerk off (local dev) the body's personId is trusted, as before.
 */
type Body = Record<string, unknown>;
interface Ctx {
  req: Request;
  url: URL;
  me?: string;
  params: string[];
  body: Body;
}
/** What the access rule is about. `undefined` from a scope means the resource does not exist. */
interface Scope {
  room?: Room;
  agent?: AgentSpec;
  personId?: string;
  item?: AttentionItem;
}
type Access =
  | "public" // no sign-in needed (only /api/me, which answers null)
  | "signedIn" // any signed-in person; the handler scopes by `me`
  | "self" // the person in the path is me
  | "roomMember" // I am a member of the resource's room
  | "roomOwner" // the room's owner member, or the owner of its agent
  | "agentOwner" // agent.ownerId is me
  | "agentMember" // agent owner, or a member of one of its rooms
  | "assignee" // the attention item is addressed to me
  | "anyAgentOwner"; // I own at least one agent
interface Route {
  method: string;
  re: RegExp;
  access: Access;
  scope?: (c: Ctx) => Scope | undefined;
  /** Also allowed with `Authorization: Bearer <EVENT_TOKEN>` (webhooks, cron). */
  orToken?: boolean;
  handle: (c: Ctx) => Response | Promise<Response>;
}

export interface WebOptions {
  port?: number;
  hostname?: string;
  auth?: Pick<Auth, "personFor"> | null;
  eventToken?: string;
}

const ROLES: MemberRole[] = ["owner", "decider", "member", "guest", "cared_for"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const AUTO_ALLOW = ["place_call", "send_sms"];

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const bad = (msg: string, status = 400) => json({ error: msg }, status);
const intParam = (url: URL, name: string, def: number, min: number, max: number) => {
  const n = Number(url.searchParams.get(name) ?? def);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
};
const bearerOf = (req: Request) => {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
};
/** Constant-time compare over digests, so neither length nor content leaks through timing. */
const sameSecret = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/** Trust settings are typed on the way in: a bad value here would silently widen what runs unasked. */
function parseTrust(t: unknown): Partial<TrustPolicy> | string {
  if (t === undefined) return {};
  if (!t || typeof t !== "object" || Array.isArray(t)) return "trust must be an object";
  const b = t as Record<string, unknown>;
  const out: Partial<TrustPolicy> = {};
  if (b.autoApproveUnderUsd !== undefined) {
    if (typeof b.autoApproveUnderUsd !== "number" || !Number.isFinite(b.autoApproveUnderUsd) || b.autoApproveUnderUsd < 0) return "autoApproveUnderUsd must be a number >= 0";
    out.autoApproveUnderUsd = b.autoApproveUnderUsd;
  }
  if (b.autoAllow !== undefined) {
    if (!Array.isArray(b.autoAllow) || !b.autoAllow.every((x) => typeof x === "string" && AUTO_ALLOW.includes(x))) return `autoAllow may only contain ${AUTO_ALLOW.join(", ")}`;
    out.autoAllow = b.autoAllow as string[];
  }
  if (b.communityPostingAllowed !== undefined) {
    if (!Array.isArray(b.communityPostingAllowed) || !b.communityPostingAllowed.every((x) => typeof x === "string")) return "communityPostingAllowed must be a list of names";
    out.communityPostingAllowed = b.communityPostingAllowed as string[];
  }
  if (b.spendingPaused !== undefined) {
    if (typeof b.spendingPaused !== "boolean") return "spendingPaused must be true or false";
    out.spendingPaused = b.spendingPaused;
  }
  return out;
}

async function readBody(req: Request): Promise<Body | Response> {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) return {};
  const text = await req.text();
  if (!text.trim()) return {};
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return bad("content-type must be application/json", 415);
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Body) : bad("body must be a JSON object");
  } catch {
    return bad("invalid JSON");
  }
}

export function startWebServer(app: App, opts: WebOptions = {}) {
  const suggestions = new SuggestionService(app.store, app.clock, app.commitments, app.model);
  const here = dirname(fileURLToPath(import.meta.url));
  const cfg = authConfig();
  const auth = opts.auth === undefined ? (cfg ? new Auth(app, cfg) : null) : opts.auth;
  const eventToken = opts.eventToken ?? process.env.EVENT_TOKEN;

  // ---- the page and its content-security policy
  const fapi = cfg ? frontendApiFromKey(cfg.publishableKey) : undefined;
  const bootInner = auth && cfg ? `window.__CLERK_PK=${JSON.stringify(cfg.publishableKey)};window.__CLERK_FAPI=${JSON.stringify(fapi ?? "")};` : "";
  const webDir = join(here, "..", "..", "web");
  const html = readFileSync(join(webDir, "index.html"), "utf8").replace("<!--AUTH-->", bootInner ? `<script>${bootInner}</script>` : "");
  // The one inline script is allowed by its hash; Clerk's loader, its API and its bot check are allowed only when sign-in is on.
  const clerkHosts = cfg ? ["https://*.clerk.accounts.dev", ...(fapi ? [`https://${fapi}`] : [])] : [];
  const csp = [
    "default-src 'self'",
    ["script-src 'self'", bootInner && `'sha256-${createHash("sha256").update(bootInner).digest("base64")}'`, ...clerkHosts, cfg && "https://challenges.cloudflare.com"]
      .filter(Boolean)
      .join(" "),
    ["connect-src 'self'", ...clerkHosts].join(" "),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    ["img-src 'self' data:", cfg && "https://img.clerk.com"].filter(Boolean).join(" "),
    cfg ? "frame-src https://challenges.cloudflare.com" : "frame-src 'none'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  // The script and stylesheet are read per request so edits show on reload.
  const asset = (name: string, type: string) => new Response(readFileSync(join(webDir, name)), { headers: { "content-type": type, "cache-control": "no-cache" } });

  // ---- live deliveries: each socket remembers who is listening, so a room's output reaches only its members
  const sockets = new Map<ReadableStreamDefaultController<string>, string | undefined>();
  app.onDeliver((d) => {
    const line = `${JSON.stringify({ type: "delivery", ...d })}\n`;
    for (const [c, who] of sockets) {
      if (who && (!app.store.getMembership(d.roomId, who) || (d.visibleTo?.length && !d.visibleTo.includes(who)))) continue;
      try {
        c.enqueue(line);
      } catch {
        sockets.delete(c);
      }
    }
  });

  // ---- scope helpers
  const roomScope = (roomId?: string): Scope | undefined => {
    const room = roomId ? app.store.getRoom(roomId) : undefined;
    return room ? { room } : undefined;
  };
  const agentScope = (agentId?: string): Scope | undefined => {
    const agent = agentId ? app.store.getAgent(agentId) : undefined;
    return agent ? { agent } : undefined;
  };
  const isMember = (roomId: string, me: string) => !!app.store.getMembership(roomId, me);
  const ownsRoom = (room: Room, me: string) => app.rooms.role(room.id, me) === "owner" || app.store.getAgent(room.agentId)?.ownerId === me;
  const reachesAgent = (agent: AgentSpec, me: string) => agent.ownerId === me || app.store.listRooms(agent.id).some((r) => isMember(r.id, me));
  const myRooms = (me: string | undefined) => (me ? app.store.listRooms().filter((r) => isMember(r.id, me)) : app.store.listRooms());
  const inMyRooms = <T extends { roomId: string }>(me: string | undefined, xs: T[]) => (me ? xs.filter((x) => isMember(x.roomId, me)) : xs);

  /** The policy. With Clerk off nothing is checked beyond the token routes, as before. */
  function permit(route: Route, c: Ctx): Response | undefined {
    if (route.access === "public") return;
    const bearer = bearerOf(c.req);
    if (route.orToken && eventToken && bearer && sameSecret(bearer, eventToken)) return;
    if (!auth) return;
    if (!c.me) return route.orToken && !eventToken ? bad("EVENT_TOKEN is not configured", 503) : bad("sign in required", 401);
    const me = c.me;
    if (route.access === "signedIn") return;
    const s = route.scope ? route.scope(c) : {};
    if (!s) return bad("not found", 404);
    const ok: Record<Exclude<Access, "public" | "signedIn">, () => boolean> = {
      self: () => s.personId === me,
      roomMember: () => !!s.room && isMember(s.room.id, me),
      roomOwner: () => !!s.room && ownsRoom(s.room, me),
      agentOwner: () => s.agent?.ownerId === me,
      agentMember: () => !!s.agent && reachesAgent(s.agent, me),
      assignee: () => s.item?.assigneeId === me,
      anyAgentOwner: () => app.store.listAgents(me).length > 0,
    };
    return ok[route.access]() ? undefined : bad("not allowed", 403);
  }

  const ndjson = (stream: ReadableStream<string>) => new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" } });

  const routes: Route[] = [
    { method: "GET", re: /^\/api\/me$/, access: "public", handle: (c) => json(c.me ? app.store.getPerson(c.me) : null) },
    {
      method: "GET",
      re: /^\/api\/state$/,
      access: "signedIn",
      handle: (c) => {
        const rooms = myRooms(c.me);
        const agents = c.me ? app.store.listAgents().filter((a) => a.ownerId === c.me || rooms.some((r) => r.agentId === a.id)) : app.store.listAgents();
        const people = c.me ? peopleVisibleTo(app.store, c.me) : listPeople(app.store);
        return json({ agents, people, rooms: rooms.map((r) => ({ ...r, members: app.rooms.members(r.id).map((m) => ({ ...m, person: app.store.getPerson(m.personId) })) })) });
      },
    },

    // ---- people
    { method: "GET", re: /^\/api\/people$/, access: "signedIn", handle: (c) => json(c.me ? peopleVisibleTo(app.store, c.me) : listPeople(app.store)) },
    {
      method: "POST",
      re: /^\/api\/people$/,
      access: "signedIn",
      handle: ({ body: b }) => {
        const displayName = str(b.displayName)?.trim();
        if (!displayName) return bad("displayName required");
        // The id is always ours: a client-chosen id could land on, or later collide with, someone else's record.
        return json(
          app.rooms.createPerson({
            displayName,
            timezone: str(b.timezone) ?? "UTC",
            pronouns: str(b.pronouns),
            phoneE164: str(b.phoneE164),
            email: str(b.email),
            techComfort: b.techComfort as "low" | "medium" | "high" | undefined,
          }),
        );
      },
    },
    {
      method: "PATCH",
      re: /^\/api\/people\/([^/]+)$/,
      access: "self",
      scope: (c) => ({ personId: c.params[0] }),
      handle: ({ params, body: b }) => {
        const person = app.store.getPerson(params[0]!);
        if (!person) return bad("no such person", 404);
        Object.assign(person, {
          displayName: str(b.displayName) ?? person.displayName,
          timezone: str(b.timezone) ?? person.timezone,
          pronouns: str(b.pronouns) ?? person.pronouns,
          phoneE164: str(b.phoneE164) ?? person.phoneE164,
          email: str(b.email) ?? person.email,
          techComfort: b.techComfort ?? person.techComfort,
        });
        app.store.putPerson(person);
        return json(person);
      },
    },
    // Members' own credentials: ciphertext at rest, names only on the way out.
    {
      method: "GET",
      re: /^\/api\/people\/([^/]+)\/credentials$/,
      access: "self",
      scope: (c) => ({ personId: c.params[0] }),
      handle: ({ params }) => json({ services: app.vault.services(params[0]!) }),
    },
    {
      method: "POST",
      re: /^\/api\/people\/([^/]+)\/credentials$/,
      access: "self",
      scope: (c) => ({ personId: c.params[0] }),
      handle: ({ params, body: b }) => {
        const service = str(b.service);
        const secret = str(b.secret);
        if (!service || !secret) return bad("service and secret required");
        app.vault.put(params[0]!, service, secret);
        return json({ services: app.vault.services(params[0]!) });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/people\/([^/]+)\/credentials\/([^/]+)$/,
      access: "self",
      scope: (c) => ({ personId: c.params[0] }),
      handle: ({ params }) => {
        app.vault.remove(params[0]!, decodeURIComponent(params[1]!));
        return json({ services: app.vault.services(params[0]!) });
      },
    },

    // ---- agents
    {
      method: "POST",
      re: /^\/api\/agents$/,
      access: "signedIn",
      handle: ({ me, body: b }) => {
        const trust = parseTrust(b.trust);
        if (typeof trust === "string") return bad(trust);
        const ownerId = me ?? str(b.ownerId);
        if (!ownerId) return bad("ownerId required");
        const a = newAgent({ ownerId, name: str(b.name) ?? "", purpose: str(b.purpose) ?? "", instructions: str(b.instructions), trust });
        app.store.putAgent(a);
        return json(a);
      },
    },
    {
      method: "PATCH",
      re: /^\/api\/agents\/([^/]+)$/,
      access: "agentOwner",
      scope: (c) => agentScope(c.params[0]),
      handle: ({ params, body: b }) => {
        const a = app.store.getAgent(params[0]!);
        if (!a) return bad("no such agent", 404);
        const trust = parseTrust(b.trust);
        if (typeof trust === "string") return bad(trust);
        const effort = str(b.effort);
        if (effort && !EFFORTS.includes(effort)) return bad(`effort must be one of ${EFFORTS.join(", ")}`);
        const soul = b.soul && typeof b.soul === "object" && !Array.isArray(b.soul) ? (b.soul as object) : {};
        Object.assign(a, {
          name: str(b.name) ?? a.name,
          purpose: str(b.purpose) ?? a.purpose,
          instructions: str(b.instructions) ?? a.instructions,
          effort: effort ?? a.effort,
          trust: { ...a.trust, ...trust },
          soul: { ...a.soul, ...soul },
        });
        app.store.putAgent(a);
        return json(a);
      },
    },
    // Deploying ends training: the same check the Settings page shows.
    {
      method: "POST",
      re: /^\/api\/agents\/([^/]+)\/deploy$/,
      access: "agentOwner",
      scope: (c) => agentScope(c.params[0]),
      handle: ({ params }) => {
        const r = deployAgent(app.store, app.clock, params[0]!);
        if (!r.ok) return bad(r.why, r.why === "no such agent" ? 404 : 409);
        return json(r.agent);
      },
    },
    {
      method: "GET",
      re: /^\/api\/suggestions$/,
      access: "agentMember",
      scope: (c) => agentScope(c.url.searchParams.get("agentId") ?? undefined),
      handle: async ({ me, url }) => {
        const person = app.store.getPerson(me ?? url.searchParams.get("personId") ?? "");
        const agent = app.store.getAgent(url.searchParams.get("agentId") ?? "");
        if (!person || !agent) return bad("personId and agentId required");
        return json(await suggestions.forHome(person, agent));
      },
    },

    // ---- rooms
    {
      method: "POST",
      re: /^\/api\/rooms$/,
      access: "agentOwner",
      scope: (c) => agentScope(str(c.body.agentId)),
      handle: ({ me, body: b }) => {
        const agent = app.store.getAgent(str(b.agentId) ?? "");
        if (!agent) return bad("no such agent", 404);
        const kind = b.kind === "dm" ? "dm" : "group";
        const members = Array.isArray(b.members) ? (b.members as { personId?: unknown; role?: unknown; consented?: unknown }[]) : [];
        for (const m of members)
          if (typeof m.personId !== "string" || !ROLES.includes(m.role as MemberRole)) return bad(`each member needs a personId and a role in ${ROLES.join(", ")}`);
        const room = app.rooms.createRoom({
          agentId: agent.id,
          kind,
          focus: str(b.focus)?.slice(0, 500),
          channel: b.channel === "imessage" ? "imessage" : "web",
          name: str(b.name) ?? `${agent.name}'s room`,
          externalId: str(b.externalId),
          outreachHours: b.outreachHours as Room["outreachHours"] | undefined,
        });
        // The signed-in creator is the owner member whatever the body says.
        if (me) app.rooms.addMember(room.id, me, "owner", { consented: true });
        for (const m of members) if (m.personId !== me) app.rooms.addMember(room.id, m.personId as string, m.role as MemberRole, { consented: !!m.consented });
        return json(room);
      },
    },
    {
      // The circle's priorities for the assistant in this room (and its name, hours) belong to the room's owner.
      method: "PATCH",
      re: /^\/api\/rooms\/([^/]+)$/,
      access: "roomOwner",
      scope: (c) => roomScope(c.params[0]),
      handle: ({ params, body: b }) => {
        const room = app.store.getRoom(params[0]!);
        if (!room) return bad("no such room", 404);
        if (b.focus !== undefined) room.focus = str(b.focus)?.trim().slice(0, 500) || undefined;
        if (str(b.name)?.trim()) room.name = str(b.name)!.trim().slice(0, 80);
        if (b.outreachHours && typeof b.outreachHours === "object") {
          const h = b.outreachHours as { start?: unknown; end?: unknown };
          if (typeof h.start === "number" && typeof h.end === "number" && h.start >= 0 && h.end <= 24 && h.start < h.end) room.outreachHours = { start: h.start, end: h.end };
        }
        app.store.putRoom(room);
        return json(room);
      },
    },
    {
      method: "POST",
      re: /^\/api\/rooms\/([^/]+)\/members$/,
      access: "roomOwner",
      scope: (c) => roomScope(c.params[0]),
      handle: ({ params, body: b }) => {
        if (!app.store.getRoom(params[0]!)) return bad("no such room", 404);
        const personId = str(b.personId);
        const role = (str(b.role) ?? "member") as MemberRole;
        if (!personId || !app.store.getPerson(personId)) return bad("no such person", 404);
        if (!ROLES.includes(role)) return bad(`role must be one of ${ROLES.join(", ")}`);
        return json(app.rooms.addMember(params[0]!, personId, role, { consented: !!b.consented }));
      },
    },

    // ---- chat
    {
      method: "GET",
      re: /^\/api\/rooms\/([^/]+)\/messages$/,
      access: "roomMember",
      scope: (c) => roomScope(c.params[0]),
      handle: ({ params, url }) => {
        const roomId = params[0]!;
        if (!app.store.getRoom(roomId)) return bad("no such room", 404);
        // Each assistant message carries its run's recorded steps, so the UI can show "Completed N steps" from records.
        const msgs = app.store.messagesForRoom(roomId, intParam(url, "limit", 100, 1, 500)).map((m) => {
          if (m.role !== "assistant" || !m.runId || m.source === "notice") return m;
          const steps = app.store.toolCallsForRun(m.runId).map((c) => ({ name: c.name, label: c.labelDone, status: c.status, verified: !!c.evidence }));
          return { ...m, steps };
        });
        const session = app.store.latestSessionForRoom(roomId);
        const active = session ? app.store.activeRunForSession(session.id) : undefined;
        const activeSteps = active
          ? app.store.toolCallsForRun(active.id).map((c) => ({ name: c.name, label: c.status === "running" ? c.labelRunning : c.labelDone, status: c.status }))
          : [];
        return json({ messages: msgs, activeRun: active ? { id: active.id, status: active.status, trigger: active.trigger, steps: activeSteps } : null });
      },
    },
    {
      method: "POST",
      re: /^\/api\/rooms\/([^/]+)\/messages$/,
      access: "roomMember",
      scope: (c) => roomScope(c.params[0]),
      handle: async ({ params, me, body: b }) => {
        const roomId = params[0]!;
        if (!app.store.getRoom(roomId)) return bad("no such room", 404);
        const personId = me ?? str(b.personId);
        if (!personId) return bad("personId required");
        const run = await app.runtime.handleMessage({ roomId, personId, text: str(b.text) ?? "", dedupKey: str(b.dedupKey) });
        return json({ run, session: app.store.latestSessionForRoom(roomId) });
      },
    },
    {
      method: "GET",
      re: /^\/api\/sessions\/([^/]+)\/events$/,
      access: "roomMember",
      scope: (c) => roomScope(app.store.getSession(c.params[0]!)?.roomId),
      handle: ({ params, url }) => json(app.store.eventsAfter(params[0]!, intParam(url, "after", 0, 0, Number.MAX_SAFE_INTEGER))),
    },
    // Watch: replay after cursor, then stream live. NDJSON, one event per line, each with its seq.
    {
      method: "GET",
      re: /^\/api\/sessions\/([^/]+)\/watch$/,
      access: "roomMember",
      scope: (c) => roomScope(app.store.getSession(c.params[0]!)?.roomId),
      handle: ({ params, url }) => {
        const sessionId = params[0]!;
        let cursor = intParam(url, "after", 0, 0, Number.MAX_SAFE_INTEGER);
        return ndjson(
          new ReadableStream<string>({
            start(controller) {
              for (const e of app.store.eventsAfter(sessionId, cursor)) {
                controller.enqueue(`${JSON.stringify({ event: e })}\n`);
                cursor = e.seq;
              }
              const timer = setInterval(() => {
                try {
                  for (const e of app.store.eventsAfter(sessionId, cursor)) {
                    controller.enqueue(`${JSON.stringify({ event: e })}\n`);
                    cursor = e.seq;
                  }
                  controller.enqueue(`${JSON.stringify({ ping: cursor })}\n`);
                } catch {
                  clearInterval(timer);
                }
              }, 1000);
            },
          }),
        );
      },
    },
    {
      method: "GET",
      re: /^\/api\/deliveries\/watch$/,
      access: "signedIn",
      handle: ({ me }) =>
        ndjson(
          new ReadableStream<string>({
            start(c) {
              sockets.set(c, me);
              // A first line, so the client sees the stream open before anything is delivered.
              c.enqueue(`${JSON.stringify({ ping: 0 })}\n`);
            },
            cancel() {
              /* removed on next failed enqueue */
            },
          }),
        ),
    },
    {
      method: "GET",
      re: /^\/api\/runs\/([^/]+)$/,
      access: "roomMember",
      scope: (c) => roomScope(app.store.getRun(c.params[0]!)?.roomId),
      handle: ({ params }) => {
        const run = app.store.getRun(params[0]!);
        if (!run) return bad("no such run", 404);
        return json({ run, toolCalls: app.store.toolCallsForRun(run.id), plan: app.planner.get(run.id), events: app.store.eventsForRun(run.id) });
      },
    },
    {
      method: "POST",
      re: /^\/api\/runs\/([^/]+)\/stop$/,
      access: "roomMember",
      scope: (c) => roomScope(app.store.getRun(c.params[0]!)?.roomId),
      handle: async ({ params }) => {
        if (!app.store.getRun(params[0]!)) return bad("no such run", 404);
        await app.runtime.stop(params[0]!);
        return json({ ok: true });
      },
    },
    {
      method: "GET",
      re: /^\/api\/tasks$/,
      access: "signedIn",
      handle: ({ me, url }) =>
        json(inMyRooms(me, app.store.listTasks({ roomId: url.searchParams.get("roomId") ?? undefined, agentId: url.searchParams.get("agentId") ?? undefined }))),
    },

    // ---- home: needs you / on radar / last activity
    {
      method: "GET",
      re: /^\/api\/inbox$/,
      access: "agentMember",
      scope: (c) => agentScope(c.url.searchParams.get("agentId") ?? undefined),
      handle: ({ me, url }) => {
        const personId = me ?? url.searchParams.get("personId") ?? "";
        const box = app.attention.inbox(personId, url.searchParams.get("agentId") ?? "");
        // Radar and activity are per agent; a member sees only the rooms they are in.
        return json({ needsYou: box.needsYou, radar: inMyRooms(me, box.radar), inFlight: inMyRooms(me, box.inFlight), activity: inMyRooms(me, box.activity) });
      },
    },
    {
      method: "POST",
      re: /^\/api\/attention\/([^/]+)\/resolve$/,
      access: "assignee",
      scope: (c) => {
        const item = app.store.getAttention(c.params[0]!);
        return item ? { item } : undefined;
      },
      handle: async ({ params, me, body: b }) => {
        if (!app.store.getAttention(params[0]!)) return bad("no such item", 404);
        const run = await app.runtime.answerAttention(params[0]!, str(b.answer) ?? "", me ?? str(b.personId));
        return json({ ok: true, run });
      },
    },
    {
      method: "POST",
      re: /^\/api\/attention\/([^/]+)\/dismiss$/,
      access: "assignee",
      scope: (c) => {
        const item = app.store.getAttention(c.params[0]!);
        return item ? { item } : undefined;
      },
      handle: ({ params }) => json(app.attention.dismiss(params[0]!)),
    },

    // ---- schedules, commitments
    {
      method: "GET",
      re: /^\/api\/schedules$/,
      access: "signedIn",
      handle: ({ me, url }) => json(inMyRooms(me, app.store.listSchedules({ agentId: url.searchParams.get("agentId") ?? undefined }))),
    },
    {
      method: "POST",
      re: /^\/api\/schedules$/,
      access: "roomOwner",
      scope: (c) => roomScope(str(c.body.roomId)),
      handle: ({ body: b }) => {
        const room = app.store.getRoom(str(b.roomId) ?? "");
        if (!room) return bad("no such room", 404);
        const title = str(b.title)?.trim();
        const prompt = str(b.prompt)?.trim();
        if (!title || !prompt) return bad("title and prompt required");
        const runAt = b.runAt ? Date.parse(String(b.runAt)) : undefined;
        if (runAt !== undefined && !Number.isFinite(runAt)) return bad("runAt must be a date");
        const session = app.store.latestSessionForRoom(room.id);
        // A schedule made here was asked for by a person and discloses no outreach: the agent must still ask before contacting anyone.
        return json(
          Scheduler.createSchedule(app.store, app.clock, {
            agentId: room.agentId,
            roomId: room.id,
            sessionId: session?.id ?? "none",
            title,
            prompt,
            runAt,
            calendar: b.calendar as Calendar | undefined,
            authorization: { basis: "user_requested", disclosedOutreach: [], premise: str(b.premise) ?? "always" },
          }),
        );
      },
    },
    {
      method: "POST",
      re: /^\/api\/schedules\/([^/]+)\/pause$/,
      access: "roomOwner",
      scope: (c) => roomScope(app.store.getSchedule(c.params[0]!)?.roomId),
      handle: ({ params, body: b }) => {
        if (!app.store.getSchedule(params[0]!)) return bad("no such schedule", 404);
        app.scheduler.pause(params[0]!, !!b.paused);
        return json({ ok: true });
      },
    },
    {
      method: "GET",
      re: /^\/api\/commitments$/,
      access: "signedIn",
      handle: ({ me, url }) => json(inMyRooms(me, app.store.listCommitments({ roomId: url.searchParams.get("roomId") ?? undefined }))),
    },
    {
      method: "POST",
      re: /^\/api\/commitments\/([^/]+)$/,
      access: "roomMember",
      scope: (c) => roomScope(app.store.getCommitment(c.params[0]!)?.roomId),
      handle: ({ params, body: b }) => {
        const c = app.store.getCommitment(params[0]!);
        if (!c) return bad("no such responsibility", 404);
        const status = str(b.status) as Commitment["status"] | undefined;
        if (status && !["open", "done", "dropped", "blocked"].includes(status)) return bad("status must be open, done, dropped or blocked");
        const dueAt = b.dueAt !== undefined ? Number(b.dueAt) : undefined;
        if (dueAt !== undefined && !Number.isFinite(dueAt)) return bad("dueAt must be a number");
        return json(app.commitments.update(c.id, { status, dueAt, detail: str(b.detail), ownerId: str(b.ownerId) }));
      },
    },

    // ---- memory: the owner's admin view of everything the agent holds
    {
      method: "GET",
      re: /^\/api\/profiles$/,
      access: "agentOwner",
      scope: (c) => agentScope(c.url.searchParams.get("agentId") ?? undefined),
      handle: ({ url }) => {
        const agentId = url.searchParams.get("agentId") ?? "";
        const out: Profile[] = [];
        const add = (scope: MemoryScope, scopeId: string) => {
          const prof = app.store.getProfile(agentId, scope, scopeId);
          if (prof) out.push(prof);
        };
        add("agent", agentId);
        for (const r of app.store.listRooms(agentId)) add("room", r.id);
        for (const person of listPeople(app.store)) add("person", person.id);
        return json(out);
      },
    },
    {
      method: "GET",
      re: /^\/api\/memory$/,
      access: "agentOwner",
      scope: (c) => agentScope(c.url.searchParams.get("agentId") ?? undefined),
      handle: ({ url }) => {
        const agentId = url.searchParams.get("agentId") ?? "";
        // Room visibility (MemoryService.visibleIn) is what the agent sees inside a room. This is the owner's
        // admin view of their own agent's memory, so it reads the store directly; the policy above limits it to the owner.
        return json({
          memories: app.store.listMemories(agentId, { includeInactive: url.searchParams.get("all") === "1" }),
          consolidatedAt: app.store.getKv(`consolidated:${agentId}`),
        });
      },
    },
    {
      method: "POST",
      re: /^\/api\/memory$/,
      access: "agentOwner",
      scope: (c) => agentScope(str(c.body.agentId)),
      handle: ({ body: b }) => {
        const agentId = str(b.agentId);
        const text = str(b.text)?.trim();
        if (!agentId || !text) return bad("agentId and text required");
        const scope = (["agent", "person", "room"].includes(String(b.scope)) ? b.scope : "agent") as MemoryScope;
        return json(
          app.memory.write({
            agentId,
            scope,
            scopeId: str(b.scopeId) ?? agentId,
            type: (str(b.type) ?? "fact") as "fact",
            text,
            aliases: Array.isArray(b.aliases) ? (b.aliases as string[]) : undefined,
            visibleToRooms: Array.isArray(b.visibleToRooms) ? (b.visibleToRooms as string[]) : undefined,
          }),
        );
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/memory\/([^/]+)$/,
      access: "agentOwner",
      scope: (c) => agentScope(app.store.getMemory(c.params[0]!)?.agentId),
      handle: ({ params }) => {
        if (!app.store.getMemory(params[0]!)) return bad("no such memory", 404);
        app.memory.retract(params[0]!);
        return json({ ok: true });
      },
    },
    {
      method: "POST",
      re: /^\/api\/memory\/consolidate$/,
      access: "agentOwner",
      scope: (c) => agentScope(str(c.body.agentId)),
      handle: async ({ body: b }) => {
        const agent = app.store.getAgent(str(b.agentId) ?? "");
        if (!agent) return bad("no such agent", 404);
        return json(await app.consolidator.runFor(agent));
      },
    },

    // ---- machines: connected-app events and the scheduler tick, with a shared secret or an owner's sign-in
    {
      method: "POST",
      re: /^\/api\/events$/,
      access: "agentOwner",
      orToken: true,
      scope: (c) => agentScope(str(c.body.agentId) ?? app.store.getRoom(str(c.body.roomId) ?? "")?.agentId),
      handle: async ({ body: b }) => {
        const source = str(b.source)?.trim();
        const summary = str(b.summary)?.trim();
        if (!source || !summary) return bad("source and summary required");
        if (source.length > 200 || summary.length > 2000) return bad("source or summary too long");
        const run = await app.runtime.handleEvent({
          roomId: str(b.roomId),
          agentId: str(b.agentId),
          source,
          summary,
          detail: str(b.detail)?.slice(0, 8000),
          dedupKey: str(b.dedupKey),
        });
        return json({ run: run ? { id: run.id, status: run.status, quiet: !!run.quiet, outcome: run.outcome } : null });
      },
    },
    { method: "POST", re: /^\/api\/tick$/, access: "anyAgentOwner", orToken: true, handle: async () => json(await app.scheduler.tick()) },
  ];

  const server = Bun.serve({
    port: opts.port ?? Number(process.env.PORT ?? 3000),
    hostname: opts.hostname ?? "127.0.0.1",
    idleTimeout: 255,
    async fetch(req) {
      const res = await route(req);
      res.headers.set("x-content-type-options", "nosniff");
      res.headers.set("referrer-policy", "no-referrer");
      return res;
    },
  });

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/" || p === "/index.html") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp } });
      if (p === "/app.js") return asset("app.js", "text/javascript; charset=utf-8");
      if (p === "/styles.css") return asset("styles.css", "text/css; charset=utf-8");
      if (p === "/health") return json({ ok: true, now: app.clock.now(), auth: !!auth });
      if (!p.startsWith("/api/")) return bad("not found", 404);

      const hit = routes.flatMap((x) => (x.method === req.method ? [[x, p.match(x.re)] as const] : [])).find(([, m]) => m);
      if (!hit?.[1]) return bad("not found", 404);
      const body = await readBody(req);
      if (body instanceof Response) return body;
      const me = auth ? (await auth.personFor(req))?.id : undefined;
      const c: Ctx = { req, url, me, params: hit[1].slice(1), body };
      return permit(hit[0], c) ?? (await hit[0].handle(c));
    } catch (e) {
      console.error(`web: ${req.method} ${p} failed:`, e);
      return bad("internal error", 500);
    }
  }
  return server;
}

export type { Delivery };
