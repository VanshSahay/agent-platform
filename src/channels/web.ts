import { readFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newAgent } from "../agent/spec.ts";
import { agentForChannel, setAgentForChannel } from "../agent/routing.ts";
import type { App } from "../app.ts";
import type { AgentSpec, AttentionItem, Calendar, Commitment, MemberRole, Memory, MemoryScope, Message, Person, Profile, Room, TrustPolicy } from "../core/types.ts";
import { newId } from "../core/ids.ts";
import { buildFooter, type Delivery } from "../runtime/runtime.ts";
import { daysAgoIso, spendSummary, startOfDayIso } from "../runtime/spend.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import { SuggestionService } from "../inbox/suggestions.ts";
import QRCode from "qrcode";
import { listPeople, peopleVisibleTo, publicPerson } from "../store/queries.ts";
import { publicUrl } from "../tools/kit.ts";
import { ALWAYS_TOOLS, TOOLS } from "../tools/registry.ts";
import { privateProfileId } from "../memory/consolidate.ts";
import type { IMessageHandle } from "./imessage.ts";
import { LINK_CODE_TTL_MS, mintLinkCode } from "./handles.ts";
import { Auth, authConfig, frontendApiFromKey } from "./auth.ts";
import { googleAuthUrl, googleExchange } from "../tools/providers/google.ts";
import { artifactPage, type DocState, emptyState, type FlightsData, type HotelsData, parseDocument, privatePage } from "./artifacts.ts";

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
  | "anyAgentOwner" // I own at least one agent
  | "operator" // runs this deployment: OPERATOR_EMAILS, else the owner of the oldest agent
  | "token"; // the operator's EVENT_TOKEN only; no signed-in person, owner included
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
  /** Chat channels that are up (filled in as they connect), with the number people text. */
  channels?: ChannelInfo[];
}

export interface ChannelInfo {
  channel: string;
  /** A dedicated line's number. Absent on the shared pool, where each person is assigned their own. */
  phone?: string;
  mode?: "dedicated" | "shared";
  handle?: Pick<IMessageHandle, "register" | "assigned" | "textFirst">;
}

const ROLES: MemberRole[] = ["owner", "member", "guest"];
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

/** The sentence of text around the first word of the query, trimmed to one line. */
function snippetAround(text: string, q: string): string {
  const flat = text.replace(/\s+/g, " ");
  const word = q.split(/\s+/)[0] ?? "";
  const i = flat.toLowerCase().indexOf(word.toLowerCase());
  const start = Math.max(0, i - 40);
  const out = flat.slice(start, start + 120);
  return `${start > 0 ? "…" : ""}${out}${start + 120 < flat.length ? "…" : ""}`;
}

async function readBody(req: Request): Promise<Body | Response> {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) return {};
  // Uploads are multipart; the route reads the form itself, so the body must stay unread here.
  if ((req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return {};
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

/** Changes every time the server starts; open pages reload when they see a new one. */
const BOOT = randomBytes(6).toString("hex");

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
    ["img-src 'self' data: https:"].filter(Boolean).join(" "),
    // Sign-in cards embed the Browserbase live view.
    `frame-src https://www.browserbase.com https://*.browserbase.com${cfg ? " https://challenges.cloudflare.com" : ""}`,
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

  const inviteFor = (token: string): { room: Room } | undefined => {
    if (!/^[A-Za-z0-9_-]{8,}$/.test(token)) return undefined;
    const raw = app.store.getKv(`invite:${token}`);
    if (!raw) return undefined;
    const room = app.store.getRoom((JSON.parse(raw) as { roomId: string }).roomId);
    return room ? { room } : undefined;
  };

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
  // Full records for yourself and for the owner of an agent (who adds and edits people); a projection for everyone else.
  const personFor = (me: string | undefined, p: Person | undefined) => (!p || !me || p.id === me || app.store.listAgents(me).length > 0 ? p : publicPerson(p));
  const peopleFor = (me: string | undefined) => (me ? peopleVisibleTo(app.store, me) : listPeople(app.store)).map((p) => personFor(me, p)!);

  /** The policy. With Clerk off nothing is checked beyond the token routes, as before. */
  function permit(route: Route, c: Ctx): Response | undefined {
    if (route.access === "public") return;
    const bearer = bearerOf(c.req);
    if ((route.orToken || route.access === "token") && eventToken && bearer && sameSecret(bearer, eventToken)) return;
    if (route.access === "token") return eventToken ? bad("not found", 404) : bad("EVENT_TOKEN is not configured", 503);
    if (!auth) return;
    if (!c.me) return route.orToken && !eventToken ? bad("EVENT_TOKEN is not configured", 503) : bad("sign in required", 401);
    const me = c.me;
    if (route.access === "signedIn") return;
    const s = route.scope ? route.scope(c) : {};
    if (!s) return bad("not found", 404);
    const ok: Record<Exclude<Access, "public" | "signedIn" | "token">, () => boolean> = {
      self: () => s.personId === me,
      roomMember: () => !!s.room && isMember(s.room.id, me),
      roomOwner: () => !!s.room && ownsRoom(s.room, me),
      agentOwner: () => s.agent?.ownerId === me,
      agentMember: () => !!s.agent && reachesAgent(s.agent, me),
      assignee: () => s.item?.assigneeId === me,
      anyAgentOwner: () => app.store.listAgents(me).length > 0,
      operator: () => isOperator(me),
    };
    return ok[route.access]() ? undefined : bad("not allowed", 403);
  }

  const isOperator = (me: string) => {
    const listed = (process.env.OPERATOR_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (listed.length) return listed.includes(app.store.getPerson(me)?.email?.toLowerCase() ?? "");
    return app.store.listAgents()[0]?.ownerId === me;
  };

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
        const people = peopleFor(c.me);
        return json({
          agents,
          people,
          rooms: rooms.map((r) => ({ ...r, members: app.rooms.members(r.id).map((m) => ({ ...m, person: personFor(c.me, app.store.getPerson(m.personId)) })) })),
        });
      },
    },

    // ---- people
    { method: "GET", re: /^\/api\/people$/, access: "signedIn", handle: (c) => json(peopleFor(c.me)) },
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
          sendAsMe: typeof b.sendAsMe === "boolean" ? b.sendAsMe : person.sendAsMe,
          addresses: Array.isArray(b.addresses) ? (b.addresses as Person["addresses"]) : person.addresses,
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

    // ---- operations: the error log, for whoever runs the deployment
    {
      method: "GET",
      re: /^\/api\/ops\/errors$/,
      access: "operator",
      handle: ({ url }) =>
        json({
          health: app.ops.health(),
          errors: app.store.listErrors({ since: Number(url.searchParams.get("since") ?? 0), limit: Math.min(Number(url.searchParams.get("limit") ?? 100), 500) }),
        }),
    },
    // ---- agents
    {
      // What an owner can narrow an agent to: skills by name, tools by family. The coordination core is always on.
      method: "GET",
      re: /^\/api\/agents\/options$/,
      access: "signedIn",
      handle: () =>
        json({
          skills: app.skills.filter((s) => !s.name.startsWith("_")).map((s) => ({ name: s.name, when: s.when })),
          families: [...new Set(TOOLS.filter((t) => !ALWAYS_TOOLS.has(t.spec.name)).map((t) => t.family))].sort(),
        }),
    },
    {
      method: "POST",
      re: /^\/api\/agents$/,
      access: "signedIn",
      handle: ({ me, body: b }) => {
        const trust = parseTrust(b.trust);
        if (typeof trust === "string") return bad(trust);
        const ownerId = me ?? str(b.ownerId);
        if (!ownerId) return bad("ownerId required");
        const name = str(b.name)?.trim() ?? "";
        if (!name) return bad("name required");
        const handle = app.store.freeHandle(
          name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, ""),
        );
        const a = newAgent({ ownerId, name, handle, purpose: str(b.purpose) ?? "", instructions: str(b.instructions), trust, createdAt: app.clock.now() });
        app.store.putAgent(a);
        return json(a);
      },
    },
    {
      method: "PATCH",
      re: /^\/api\/agents\/([^/]+)$/,
      access: "agentOwner",
      scope: (c) => agentScope(c.params[0]),
      handle: async ({ params, me, body: b }) => {
        const a = app.store.getAgent(params[0]!);
        if (!a) return bad("no such agent", 404);
        const trust = parseTrust(b.trust);
        if (typeof trust === "string") return bad(trust);
        const effort = str(b.effort);
        if (effort && !EFFORTS.includes(effort)) return bad(`effort must be one of ${EFFORTS.join(", ")}`);
        const soul = b.soul && typeof b.soul === "object" && !Array.isArray(b.soul) ? (b.soul as object) : {};
        const list = (v: unknown, name: string): string[] | null | undefined | string => {
          if (v === undefined) return undefined;
          if (v === null) return null; // null clears the list: everything again
          return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length <= 80) ? (v as string[]).slice(0, 200) : `${name} must be a list of names, or null`;
        };
        const skills = list(b.skills, "skills");
        const tools = list(b.tools, "tools");
        if (typeof skills === "string") return bad(skills);
        if (typeof tools === "string") return bad(tools);
        const model = str(b.model)?.trim();
        Object.assign(a, {
          name: str(b.name) ?? a.name,
          purpose: str(b.purpose) ?? a.purpose,
          instructions: str(b.instructions) ?? a.instructions,
          effort: effort ?? a.effort,
          trust: { ...a.trust, ...trust },
          soul: { ...a.soul, ...soul },
          // A model the owner names is kept across restarts; an empty one goes back to the deployment default.
          ...(model !== undefined ? (model ? { model: model.slice(0, 120), modelPinned: true } : { modelPinned: false }) : {}),
          ...(skills !== undefined ? { skills: skills ?? undefined } : {}),
          ...(tools !== undefined ? { tools: tools ?? undefined } : {}),
          ...(typeof b.paused === "boolean" ? { paused: b.paused || undefined } : {}),
        });
        app.store.putAgent(a);
        // Switching off stops what is in flight too; each stop tells its chat what had already been done.
        if (b.paused === true) for (const r of app.store.listRuns({ agentId: a.id, status: ["running", "waiting"] })) await app.runtime.stop(r.id, me);
        return json(a);
      },
    },
    {
      // Which of the owner's agents answers on a channel line: adding that agent to a group is adding the line.
      method: "PUT",
      re: /^\/api\/channels\/([a-z]+)\/agent$/,
      access: "anyAgentOwner",
      handle: ({ params, me, body: b }) => {
        const agent = app.store.getAgent(str(b.agentId) ?? "");
        if (!agent) return bad("no such agent", 404);
        if (auth && agent.ownerId !== me) return bad("you can only put an agent you own on a line", 403);
        setAgentForChannel(app.store, params[0]!, agent.id);
        return json({ channel: params[0], agentId: agent.id });
      },
    },
    // ---- channels: where the assistant can be texted, and linking a phone to a person
    {
      method: "GET",
      re: /^\/api\/channels$/,
      access: "signedIn",
      handle: async ({ me, url }) => {
        const person = app.store.getPerson(me ?? url.searchParams.get("personId") ?? "");
        const im = (opts.channels ?? []).find((c) => c.channel === "imessage");
        // Shared pool: the number to text is per person, known once they are registered.
        const assigned = im?.mode === "shared" && person?.phoneE164 && im.handle ? ((await im.handle.assigned(person.phoneE164)) ?? null) : null;
        return json({
          channels: (opts.channels ?? []).map((c) => ({
            channel: c.channel,
            phone: c.phone ?? null,
            mode: c.mode ?? (c.phone ? "dedicated" : "shared"),
            agentId: agentForChannel(app.store, c.channel)?.id ?? null,
          })),
          linked: { phone: person?.phoneE164 ?? null, email: person?.email ?? null },
          mine: { phone: im?.phone ?? assigned },
        });
      },
    },
    {
      // Shared pool: register the person's own iMessage handle with Photon, then text them first so the
      // number is in their Messages. The handle is theirs to give; the project's credentials stay here.
      method: "POST",
      re: /^\/api\/channels\/register$/,
      access: "signedIn",
      handle: async ({ me, body: b }) => {
        const person = app.store.getPerson(me ?? str(b.personId) ?? "");
        if (!person) return bad("personId required");
        const phone = (str(b.phone) ?? "").replace(/[^+\d]/g, "");
        if (!/^\+\d{8,15}$/.test(phone)) return bad("phone must be in E.164, like +14085550100");
        const im = (opts.channels ?? []).find((c) => c.channel === "imessage");
        if (!im?.handle) return bad("iMessage is not connected on this server", 404);
        const agent = agentForChannel(app.store, "imessage");
        try {
          const { assignedPhone } = await im.handle.register(phone, person.displayName);
          app.store.putPerson({ ...person, phoneE164: phone });
          await im.handle.textFirst(phone, `Hi ${person.displayName.split(" ")[0]}, it's ${agent?.name ?? "your assistant"}. Save this number and text me here any time.`);
          return json({ assignedPhone, texted: true });
        } catch (e) {
          return bad((e as Error).message, 502);
        }
      },
    },
    {
      method: "GET",
      re: /^\/api\/channels\/vcard$/,
      access: "signedIn",
      handle: async ({ me, url }) => {
        const agent = agentForChannel(app.store, "imessage");
        const im = (opts.channels ?? []).find((c) => c.channel === "imessage");
        const person = app.store.getPerson(me ?? url.searchParams.get("personId") ?? "");
        const phone = im?.phone ?? (person?.phoneE164 && im?.handle ? await im.handle.assigned(person.phoneE164) : undefined);
        if (!agent || !phone) return bad("no number yet", 404);
        const vcf = `BEGIN:VCARD\nVERSION:3.0\nFN:${agent.name}\nTEL;TYPE=CELL:${phone}\nNOTE:${agent.name}, the assistant in your chats\nEND:VCARD\n`;
        return new Response(vcf, { headers: { "content-type": "text/vcard; charset=utf-8", "content-disposition": `attachment; filename="${agent.name}.vcf"` } });
      },
    },
    {
      method: "POST",
      re: /^\/api\/channels\/link-code$/,
      access: "signedIn",
      handle: async ({ me, body: b }) => {
        const person = app.store.getPerson(me ?? str(b.personId) ?? "");
        if (!person) return bad("personId required");
        const im = (opts.channels ?? []).find((c) => c.channel === "imessage");
        const phone = im?.phone ?? (person.phoneE164 && im?.handle ? await im.handle.assigned(person.phoneE164) : undefined);
        const code = mintLinkCode(app.store, person.id, app.clock.now());
        // "sms:<number>?&body=" opens Messages with the code typed, on iOS and Android alike.
        const sms = phone ? `sms:${phone}?&body=${encodeURIComponent(code)}` : null;
        const qr = sms ? await QRCode.toString(sms, { type: "svg", margin: 1, width: 180 }) : null;
        return json({ code, phone: phone ?? null, sms, qr, expiresInMs: LINK_CODE_TTL_MS });
      },
    },
    {
      method: "GET",
      re: /^\/api\/rooms\/starters$/,
      access: "signedIn",
      handle: async ({ me, url }) => {
        const person = app.store.getPerson(me ?? url.searchParams.get("personId") ?? "");
        const agent = app.store.getAgent(url.searchParams.get("agentId") ?? "") ?? app.store.listAgents()[0];
        if (!person || !agent) return bad("personId and agentId required");
        return json({ names: await suggestions.roomStarters(person, agent) });
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
      handle: ({ params, me, body: b }) => {
        const room = app.store.getRoom(params[0]!);
        if (!room) return bad("no such room", 404);
        if (b.focus !== undefined) room.focus = str(b.focus)?.trim().slice(0, 500) || undefined;
        if (str(b.name)?.trim()) room.name = str(b.name)!.trim().slice(0, 80);
        // Hand the chat to another of the caller's agents. Notes the old agent kept stay with it.
        if (str(b.agentId) && b.agentId !== room.agentId) {
          const target = app.store.getAgent(str(b.agentId)!);
          if (!target) return bad("no such agent", 404);
          if (auth && target.ownerId !== me) return bad("you can only hand a chat to an agent you own", 403);
          room.agentId = target.id;
        }
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
        const role = (str(b.role) ?? "member") as MemberRole;
        if (!ROLES.includes(role) || role === "owner") return bad("role must be member or guest");
        // An existing person by id, or someone new by name with a phone or email so a later text or sign-in lands on them.
        const person = str(b.personId)
          ? app.store.getPerson(str(b.personId)!)
          : app.rooms.findOrCreatePerson({ displayName: str(b.displayName), email: str(b.email), phoneE164: str(b.phoneE164) });
        if (!person) return bad("give a personId, or a displayName with an email or phone");
        const existing = app.store.getMembership(params[0]!, person.id);
        // Adding someone who texted in as a stranger gives them their seat.
        if (existing) return json({ membership: existing.role === "guest" ? app.rooms.setRole(params[0]!, person.id, "member") : existing, person });
        return json({ membership: app.rooms.addMember(params[0]!, person.id, role, { consented: !!b.consented }), person });
      },
    },
    {
      method: "PATCH",
      re: /^\/api\/rooms\/([^/]+)\/members\/([^/]+)$/,
      access: "roomOwner",
      scope: (c) => roomScope(c.params[0]),
      handle: ({ params, body: b }) => {
        const role = str(b.role) as MemberRole | undefined;
        if (!role || !ROLES.includes(role)) return bad("role must be member, guest or owner");
        // A member may be promoted to co-owner; a guest first becomes a member. An existing owner cannot be changed here.
        const current = app.store.getMembership(params[0]!, params[1]!);
        if (!current || current.role === "owner") return bad("no such member, or the owner", 404);
        const m = role === "owner" ? app.rooms.promoteOwner(params[0]!, params[1]!) : app.rooms.setRole(params[0]!, params[1]!, role);
        return m ? json(m) : bad("only a member can be promoted", 400);
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/rooms\/([^/]+)\/members\/([^/]+)$/,
      access: "roomOwner",
      scope: (c) => roomScope(c.params[0]),
      handle: ({ params }) => (app.rooms.removeMember(params[0]!, params[1]!) ? json({ ok: true }) : bad("no such member, or the owner", 404)),
    },

    // ---- chat
    {
      method: "GET",
      re: /^\/api\/rooms\/([^/]+)\/messages$/,
      access: "roomMember",
      scope: (c) => roomScope(c.params[0]),
      handle: ({ params, url, me }) => {
        const roomId = params[0]!;
        if (!app.store.getRoom(roomId)) return bad("no such room", 404);
        // A message addressed to one member (a sign-in card, an owner-only note) is shown only to them.
        const viewer = me ?? url.searchParams.get("personId") ?? undefined;
        const visible = (m: Message) => m.visibleTo.length === 0 || (viewer !== undefined && m.visibleTo.includes(viewer));
        // Each assistant message carries its run's recorded steps, so the UI can show "Completed N steps" from records.
        const msgs = app.store
          .messagesForRoom(roomId, intParam(url, "limit", 100, 1, 500))
          .filter(visible)
          .map((m) => {
            if (m.role !== "assistant" || !m.runId || m.source === "notice" || m.source === "card" || m.source === "narration") return m;
            const calls = app.store.toolCallsForRun(m.runId);
            const steps = calls.map((c) => ({ name: c.name, label: c.labelDone, status: c.status, verified: !!c.evidence }));
            // The stored text ends with the record footer; the client renders steps from records instead and never parses text for a footer.
            const footer = buildFooter(calls);
            const text = footer && m.text.endsWith(`\n${footer}`) ? m.text.slice(0, -(footer.length + 1)) : m.text;
            return { ...m, text, steps };
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
    // ---- connections: Google (OAuth), Slack token, MCP servers, HTTP APIs; all per person, all in the vault
    {
      method: "GET",
      re: /^\/api\/connections\/info$/,
      access: "signedIn",
      handle: ({ url, me }) => {
        const personId = me ?? url.searchParams.get("personId") ?? undefined;
        const services = personId ? app.vault.services(personId) : [];
        return json({
          googleConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
          agentEmail: app.hands.email.address(),
          google: services.includes("google"),

          slack: services.includes("slack"),
          mcp: services.filter((x) => x.startsWith("mcp:")).map((x) => x.slice(4)),
          apis: services.filter((x) => x.startsWith("api:")).map((x) => x.slice(4)),
          sites: services.filter((x) => x.startsWith("browser:")).map((x) => x.slice(8)),
        });
      },
    },
    {
      method: "GET",
      re: /^\/api\/connections\/google\/link$/,
      access: "signedIn",
      handle: ({ url, me, req }) => {
        const personId = me ?? url.searchParams.get("personId");
        if (!personId) return bad("personId required");
        const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
        if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return bad("Google is not configured on this server (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)", 503);
        const state = randomBytes(12).toString("base64url");
        app.store.setKv(`oauth:google:${state}`, JSON.stringify({ personId, at: app.clock.now() }));
        const redirectUri = `${process.env.PUBLIC_URL ?? new URL(req.url).origin}/oauth/google/callback`;
        return json({ url: googleAuthUrl({ clientId: GOOGLE_CLIENT_ID, redirectUri }, state) });
      },
    },
    {
      method: "POST",
      re: /^\/api\/people\/([^/]+)\/connections$/,
      access: "self",
      scope: (c) => ({ personId: c.params[0] }),
      handle: ({ params, body: b }) => {
        const kind = str(b.kind);
        const name = (str(b.name) ?? "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-");
        if (kind === "slack") {
          if (!str(b.token)) return bad("token required");
          app.vault.put(params[0]!, "slack", str(b.token)!);
        } else if (kind === "mcp") {
          if (!name || !str(b.url)) return bad("name and url required");
          if (!publicUrl(str(b.url)!)) return bad("url must be a public http(s) address");
          app.vault.put(params[0]!, `mcp:${name}`, JSON.stringify({ url: str(b.url), token: str(b.token) || undefined }));
        } else if (kind === "api") {
          if (!name || !str(b.baseUrl)) return bad("name and baseUrl required");
          if (!publicUrl(str(b.baseUrl)!) || (str(b.openapiUrl) && !publicUrl(str(b.openapiUrl)!))) return bad("baseUrl and openapiUrl must be public http(s) addresses");
          app.vault.put(
            params[0]!,
            `api:${name}`,
            JSON.stringify({ baseUrl: str(b.baseUrl), openapiUrl: str(b.openapiUrl) || undefined, token: str(b.token) || undefined, header: str(b.header) || undefined }),
          );
        } else return bad("kind must be slack, mcp or api");
        return json({ services: app.vault.services(params[0]!) });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/people\/([^/]+)\/connections\/([^/]+)$/,
      access: "self",
      scope: (c) => ({ personId: c.params[0] }),
      handle: ({ params }) => {
        app.vault.remove(params[0]!, decodeURIComponent(params[1]!));
        return json({ services: app.vault.services(params[0]!) });
      },
    },
    // ---- a document's shared state: who ticked what, who brings what, what was added on the page
    {
      method: "GET",
      re: /^\/api\/artifacts\/([^/]+)$/,
      access: "public",
      handle: ({ params, me }) => {
        const art = app.store.getArtifact(params[0]!);
        if (!art) return bad("not found", 404);
        if (art.share !== "link" && auth && (!me || !art.roomId || !isMember(art.roomId, me))) return bad("sign in as a member of that chat", 403);
        const d = art.data as { state?: DocState; markdown?: string; subtitle?: string; kpis?: unknown[]; rows?: HotelsData["rows"] };
        // Who is in the chat is for its members; a visitor holding a link sees the page, not the people.
        const insider = !auth || (!!me && !!art.roomId && isMember(art.roomId, me));
        const members = insider && art.roomId ? app.rooms.memberIds(art.roomId).map((id) => app.store.getPerson(id)?.displayName ?? id) : [];
        const state = d.state ?? emptyState();
        // A glance for the chat's preview card: how many items, how many done, or the first line of a note.
        const sections = art.kind === "document" ? parseDocument(d.markdown ?? "", art.title) : [];
        const items = sections.reduce((n, s) => n + s.items.length, 0) + Object.values(state.added).reduce((n, l) => n + l.length, 0);
        const flightRows = art.kind === "flights" ? ((art.data as FlightsData).rows ?? []) : [];
        const excerpt =
          art.kind === "document"
            ? sections
                .flatMap((s) => s.notes)[0]
                ?.replace(/[*_`#]/g, "")
                .slice(0, 140)
            : art.kind === "dashboard"
              ? d.subtitle
              : art.kind === "hotels"
                ? `${(d.rows ?? []).length} hotels, ${(d.rows ?? []).filter((r) => r.pub && r.pub.totalUsd > r.oursUsd).length} cheaper through us`
                : art.kind === "flights"
                  ? `${flightRows.length} itineraries, ${flightRows.filter((r) => r.ours && r.pub && r.pub.totalUsd > r.ours.totalUsd + 1).length} cheaper through us`
                  : undefined;
        // The chat card shows the first three itineraries as one line each.
        const flights =
          art.kind === "flights"
            ? flightRows.slice(0, 3).map((r) => ({
                name: `${r.airline} ${r.flights.join(" › ")} · ${r.departAt.slice(11, 16)}–${r.arriveAt.slice(11, 16)}${r.stops ? ` · ${r.stops} stop` : " · nonstop"}`,
                oursUsd: r.ours?.totalUsd,
                pubUsd: r.pub?.totalUsd,
                seller: r.pub?.seller,
              }))
            : undefined;
        // The chat card shows the first three hotels: name, our price, the public one.
        const hotels =
          art.kind === "hotels"
            ? (d.rows ?? []).slice(0, 3).map((r: { name: string; photo?: string; oursUsd: number; pub?: { totalUsd: number; seller: string } }) => ({
                name: r.name,
                photo: r.photo,
                oursUsd: r.oursUsd,
                pubUsd: r.pub?.totalUsd,
                seller: r.pub?.seller,
              }))
            : undefined;
        return json({
          id: art.id,
          title: art.title,
          kind: art.kind,
          state,
          members,
          me: me ? app.store.getPerson(me)?.displayName : undefined,
          summary: {
            items,
            done: Object.keys(state.checked).length,
            excerpt,
            hotels,
            flights,
            sections: sections
              .filter((s) => s.title)
              .map((s) => s.title)
              .slice(0, 6),
          },
        });
      },
    },
    // ---- a member opens a page to anyone with the link (or closes it again)
    {
      method: "PATCH",
      re: /^\/api\/artifacts\/([^/]+)\/share$/,
      access: "public",
      handle: ({ params, me, body: b }) => {
        const art = app.store.getArtifact(params[0]!);
        if (!art) return bad("not found", 404);
        if (auth && (!me || !art.roomId || !isMember(art.roomId, me))) return bad("sign in as a member of that chat", 403);
        if (b.share !== "link" && b.share !== "room") return bad("share must be link or room");
        art.share = b.share;
        app.store.putArtifact(art);
        return json({ share: art.share });
      },
    },
    {
      method: "PATCH",
      re: /^\/api\/artifacts\/([^/]+)\/state$/,
      access: "public",
      handle: ({ params, me, body: b }) => {
        const art = app.store.getArtifact(params[0]!);
        if (art?.kind !== "document") return bad("not found", 404);
        if (auth && (!me || !art.roomId || !isMember(art.roomId, me))) return bad("sign in as a member of that chat", 403);
        const who = (me ? app.store.getPerson(me)?.displayName : str(b.me)) || "someone";
        const d = art.data as { markdown?: string; state?: DocState };
        const st = d.state ?? emptyState();
        const before = JSON.stringify(st);
        const checked = b.checked && typeof b.checked === "object" ? (b.checked as Record<string, string | null>) : {};
        for (const [k, v] of Object.entries(checked)) {
          if (v === null) delete st.checked[k];
          else st.checked[k] = who;
        }
        const claimed = b.claimed && typeof b.claimed === "object" ? (b.claimed as Record<string, string | null>) : {};
        // A claim names a member of this chat, and the page records who set it: putting someone else
        // down is allowed, but it is an ask for them to confirm, never a responsibility made for them.
        const names = new Set((art.roomId ? app.rooms.memberIds(art.roomId) : []).map((id) => app.store.getPerson(id)?.displayName ?? id));
        st.claimedBy = st.claimedBy ?? {};
        for (const [k, v] of Object.entries(claimed)) {
          if (v === null) {
            delete st.claimed[k];
            delete st.claimedBy[k];
          } else if (names.has(String(v))) {
            st.claimed[k] = String(v).slice(0, 80);
            st.claimedBy[k] = who;
          }
        }
        const add = b.add && typeof b.add === "object" ? (b.add as { section?: string; text?: string }) : undefined;
        if (add?.section && add.text) {
          const list = st.added[add.section] ?? [];
          if (list.length < 200) list.push({ key: `${add.section}:add-${app.clock.now().toString(36)}`, text: String(add.text).slice(0, 200), by: who });
          st.added[add.section] = list;
        }
        art.data = { ...d, state: st };
        app.store.putArtifact(art);
        // Page edits are events: record the new snapshot for the scheduler's diff, which is
        // how a claim becomes a tracked responsibility (multiplayer-spec §10.3).
        if (JSON.stringify(st) === before) return json(st); // nothing a person did changed: no edit, no event
        const n = Number(app.store.getKv(`artedit:${art.id}`) ?? 0) + 1;
        app.store.setKv(`artedit:${art.id}`, String(n));
        app.store.setKv(`artedit:${art.id}:${n}`, JSON.stringify({ by: who, state: st }));
        const pending = JSON.parse(app.store.getKv("artedit:pending") ?? "[]") as string[];
        if (!pending.includes(art.id)) pending.push(art.id);
        app.store.setKv("artedit:pending", JSON.stringify(pending));
        return json(st);
      },
    },
    // ---- artifacts: what the agent made (documents, dashboards, images, audio, files)
    {
      method: "GET",
      re: /^\/api\/artifacts$/,
      access: "agentMember",
      scope: (c) => agentScope(c.url.searchParams.get("agentId") ?? undefined),
      handle: ({ url, me }) => {
        const agentId = url.searchParams.get("agentId") ?? "";
        const rooms = new Set(me ? app.store.roomsForPerson(me) : app.store.listRooms(agentId).map((r) => r.id));
        return json(
          app.store
            .listArtifacts(agentId, { limit: 100 })
            .filter((a) => a.share === "link" || !a.roomId || rooms.has(a.roomId))
            .map(({ data: _d, ...rest }) => rest),
        );
      },
    },
    {
      method: "POST",
      re: /^\/api\/files$/,
      access: "signedIn",
      handle: async ({ req, url, me }) => {
        const form = await req.formData().catch(() => undefined);
        const file = form?.get("file");
        if (!(file instanceof File)) return bad("multipart form with a file");
        if (file.size > 10 * 1024 * 1024) return bad("10 MB at most", 413);
        const roomId = str((form?.get("roomId") as string | null) ?? undefined);
        const room = roomId ? app.store.getRoom(roomId) : undefined;
        if (!room) return bad("roomId required", 404);
        if (me && !isMember(room.id, me)) return bad("not a member of that chat", 403);
        const agentId = room.agentId;
        const bytes = Buffer.from(await file.arrayBuffer());
        const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : "file";
        const art = {
          id: newId("art"),
          agentId,
          roomId: roomId || undefined,
          kind: kind as "image" | "audio" | "file",
          title: file.name,
          data: {
            base64: bytes.toString("base64"),
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            uploadedBy: me ?? url.searchParams.get("personId") ?? undefined,
          },
          share: "room" as const,
          createdAt: app.clock.now(),
        };
        app.store.putArtifact(art);
        return json({ id: art.id, url: `/d/${art.id}` });
      },
    },
    // Invites: how a group becomes multiplayer. The owner mints a link; whoever opens it joins the room as a member.
    {
      method: "POST",
      re: /^\/api\/rooms\/([^/]+)\/invites$/,
      access: "roomOwner",
      scope: (c) => roomScope(c.params[0]),
      handle: ({ params, req, me, body: b }) => {
        const room = app.store.getRoom(params[0]!);
        if (!room) return bad("no such room", 404);
        const token = randomBytes(12).toString("base64url");
        app.store.setKv(`invite:${token}`, JSON.stringify({ roomId: room.id, createdBy: me ?? str(b.personId) ?? room.agentId, createdAt: app.clock.now() }));
        const base = process.env.PUBLIC_URL ?? new URL(req.url).origin;
        return json({ token, url: `${base}/#join=${token}` });
      },
    },
    {
      method: "GET",
      re: /^\/api\/invites\/([^/]+)$/,
      access: "public",
      handle: ({ params }) => {
        const inv = inviteFor(params[0]!);
        if (!inv) return bad("that invite link is not valid", 404);
        return json({ roomName: inv.room.name, agentName: app.store.getAgent(inv.room.agentId)?.name ?? "the assistant", members: app.rooms.members(inv.room.id).length });
      },
    },
    {
      method: "POST",
      re: /^\/api\/invites\/([^/]+)\/accept$/,
      access: "signedIn",
      handle: ({ params, me, body: b }) => {
        const inv = inviteFor(params[0]!);
        if (!inv) return bad("that invite link is not valid", 404);
        // Signed in: the caller joins. Local dev: an existing person by id, or a new one by name.
        let personId = me ?? str(b.personId);
        if (!personId) {
          const name = str(b.displayName)?.trim();
          if (!name) return bad("displayName required");
          personId = app.rooms.createPerson({ displayName: name.slice(0, 80), timezone: str(b.timezone) ?? "UTC" }).id;
        }
        if (!app.store.getPerson(personId)) return bad("no such person", 404);
        if (!app.store.getMembership(inv.room.id, personId)) app.rooms.addMember(inv.room.id, personId, "member");
        return json({ room: inv.room, personId });
      },
    },
    // Chat search, as Fo does it: a room-name match plus message hits with a snippet, one row per room, newest first.
    {
      method: "GET",
      re: /^\/api\/search$/,
      access: "signedIn",
      handle: ({ url, me }) => {
        const viewer = me ?? url.searchParams.get("personId") ?? undefined;
        const q = (url.searchParams.get("q") ?? "").trim().slice(0, 256);
        if (!viewer) return bad("personId required");
        if (q.length < 3) return json({ results: [] });
        const rooms = app.store.roomsForPerson(viewer);
        const seen = new Set<string>();
        const results: { roomId: string; roomName: string; snippet: string; who?: string; at: number }[] = [];
        for (const m of app.store.searchMessages(rooms, q, 80)) {
          if (seen.has(m.roomId) || (m.visibleTo.length && !m.visibleTo.includes(viewer))) continue;
          const room = app.store.getRoom(m.roomId);
          if (!room) continue;
          seen.add(m.roomId);
          const who = m.role === "assistant" ? app.store.getAgent(m.authorId)?.name : app.store.getPerson(m.authorId)?.displayName;
          results.push({ roomId: room.id, roomName: room.name, snippet: snippetAround(m.text, q), who, at: m.at });
        }
        for (const id of rooms) {
          const room = app.store.getRoom(id);
          if (room && !seen.has(id) && room.name.toLowerCase().includes(q.toLowerCase())) results.push({ roomId: id, roomName: room.name, snippet: "", at: 0 });
        }
        return json({ results: results.slice(0, 10) });
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
              // A first line, so the client sees the stream open before anything is delivered. It carries this
              // server's boot id: a page that sees a new one reloads itself, so nobody runs a stale script.
              c.enqueue(`${JSON.stringify({ ping: 0, boot: BOOT })}\n`);
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
      handle: ({ params, me }) => {
        const run = app.store.getRun(params[0]!);
        if (!run) return bad("no such run", 404);
        const room = app.store.getRoom(run.roomId);
        // Tool inputs and results can hold a signed-in page or an inbox; those are for the
        // requester and the owner. Other members see what the chat saw: labels and evidence.
        const full = !me || run.requesterId === me || (room && ownsRoom(room, me));
        const calls = app.store.toolCallsForRun(run.id).map((c) => (full ? c : { ...c, input: {}, result: undefined }));
        const events = app.store.eventsForRun(run.id).filter((e) => full || !["delta", "tool_end"].includes(e.type));
        return json({ run, toolCalls: calls, plan: app.planner.get(run.id), events });
      },
    },
    {
      method: "POST",
      re: /^\/api\/runs\/([^/]+)\/stop$/,
      access: "roomMember",
      scope: (c) => roomScope(app.store.getRun(c.params[0]!)?.roomId),
      handle: async ({ params, me }) => {
        const run = app.store.getRun(params[0]!);
        if (!run) return bad("no such run", 404);
        const room = app.store.getRoom(run.roomId);
        if (me && run.requesterId !== me && !(room && ownsRoom(room, me))) return bad("only the person who asked, or the owner, can stop this", 403);
        await app.runtime.stop(run.id, me);
        return json({ ok: true });
      },
    },
    {
      // Cancel delegated work: only the person who asked for it, or the owner, as with a run.
      method: "POST",
      re: /^\/api\/tasks\/([^/]+)\/stop$/,
      access: "roomMember",
      scope: (c) => roomScope(app.store.getTask(c.params[0]!)?.roomId),
      handle: async ({ params, me }) => {
        const task = app.store.getTask(params[0]!);
        if (!task) return bad("no such task", 404);
        const room = app.store.getRoom(task.roomId);
        if (me && task.requesterId !== me && !(room && ownsRoom(room, me))) return bad("only the person who asked, or the owner, can stop this", 403);
        await app.runtime.stopTask(task.id, me);
        return json(app.store.getTask(task.id));
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
        // What a run waits on is named to the person it waits on and the room's owner; others see only who.
        const inFlight = inMyRooms(me, box.inFlight).map((r) => {
          if (!r.waitingFor || !me || r.waitingFor.assigneeId === me) return r;
          const room = app.store.getRoom(r.roomId);
          return room && ownsRoom(room, me) ? r : { ...r, waitingFor: { ...r.waitingFor, title: "" } };
        });
        return json({ needsYou: box.needsYou, radar: inMyRooms(me, box.radar), inFlight, tasks: inMyRooms(me, box.tasks), activity: inMyRooms(me, box.activity) });
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
        const cal = b.calendar && typeof b.calendar === "object" ? (b.calendar as Record<string, unknown>) : undefined;
        if (!runAt && !cal) return bad("runAt or calendar required");
        const zone = app.store.getPerson(app.store.getAgent(room.agentId)?.ownerId ?? "")?.timezone ?? "UTC";
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
        const calendar: Calendar | undefined = cal
          ? {
              hour: num(cal.hour),
              minute: num(cal.minute) ?? 0,
              dayOfWeek: Array.isArray(cal.dayOfWeek) ? cal.dayOfWeek.filter((d): d is number => typeof d === "number") : undefined,
              everyDays: num(cal.everyDays),
              everyHours: num(cal.everyHours),
              timeZone: zone,
            }
          : undefined;
        if (calendar && calendar.hour === undefined && !calendar.everyHours) return bad("calendar needs hour or everyHours");
        // A schedule made here was asked for by a person and discloses no outreach: the agent must still ask before contacting anyone.
        return json(
          Scheduler.createSchedule(app.store, app.clock, {
            agentId: room.agentId,
            roomId: room.id,
            sessionId: session?.id ?? "none",
            title,
            prompt,
            runAt,
            calendar,
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
      handle: ({ params, body: b, me }) => {
        const c = app.store.getCommitment(params[0]!);
        if (!c) return bad("no such responsibility", 404);
        const room = app.store.getRoom(c.roomId);
        if (me && c.ownerId !== me && !(room && ownsRoom(room, me))) return bad("only its owner, or the chat's owner, can change this", 403);
        const ownerId = str(b.ownerId);
        if (ownerId && !isMember(c.roomId, ownerId)) return bad("ownerId must be a member of the chat");
        const status = str(b.status) as Commitment["status"] | undefined;
        if (status && !["open", "done", "dropped", "blocked"].includes(status)) return bad("status must be open, done, dropped or blocked");
        const dueAt = b.dueAt !== undefined ? Number(b.dueAt) : undefined;
        if (dueAt !== undefined && !Number.isFinite(dueAt)) return bad("dueAt must be a number");
        return json(app.commitments.update(c.id, { status, dueAt, detail: str(b.detail), ownerId }));
      },
    },

    // ---- memory: the owner's admin view of everything the agent holds
    {
      method: "GET",
      re: /^\/api\/profiles$/,
      access: "agentOwner",
      scope: (c) => agentScope(c.url.searchParams.get("agentId") ?? undefined),
      handle: ({ url, me }) => {
        const agentId = url.searchParams.get("agentId") ?? "";
        const out: Profile[] = [];
        const add = (scope: MemoryScope, scopeId: string) => {
          const prof = app.store.getProfile(agentId, scope, scopeId);
          if (prof) out.push(prof);
        };
        add("agent", agentId);
        for (const r of app.store.listRooms(agentId)) if (r.kind === "group") add("room", r.id);
        // Public person profiles only: what a person told the assistant privately shapes their private profile, which stays theirs.
        for (const person of listPeople(app.store)) add("person", person.id);
        if (me) add("person", privateProfileId(me));
        return json(out);
      },
    },
    {
      method: "GET",
      re: /^\/api\/memory$/,
      access: "agentOwner",
      scope: (c) => agentScope(c.url.searchParams.get("agentId") ?? undefined),
      handle: ({ url, me }) => {
        const agentId = url.searchParams.get("agentId") ?? "";
        // Room visibility (MemoryService.visibleIn) is what the agent sees inside a room. This is the owner's
        // admin view, limited to the owner by the policy above, and it keeps one promise: a note another
        // member made in their own private chat is theirs. Shown: agent and group notes, the owner's own
        // notes, and notes about people that some group may see.
        const groupIds = new Set(
          app.store
            .listRooms(agentId)
            .filter((r) => r.kind === "group")
            .map((r) => r.id),
        );
        const ownerDm = me ? app.rooms.dmFor(app.store.getAgent(agentId)!, me).id : undefined;
        const shownToOwner = (m: Memory) =>
          m.scope === "agent" ||
          (m.scope === "room" && groupIds.has(m.scopeId)) ||
          (m.scope === "person" && (m.scopeId === me || m.visibleToRooms.some((rid) => groupIds.has(rid) || rid === ownerDm)));
        return json({
          memories: app.store.listMemories(agentId, { includeInactive: url.searchParams.get("all") === "1" }).filter(shownToOwner),
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
    // What the deployment has cost, for the operator only (EVENT_TOKEN; `bun run spend`), never for a signed-in person.
    {
      method: "GET",
      re: /^\/api\/spend$/,
      access: "token",
      handle: (c) => {
        const now = app.clock.now();
        const raw = c.url.searchParams.get("since");
        const since = raw === "week" ? daysAgoIso(7, now) : raw && !Number.isNaN(Date.parse(raw)) ? new Date(Date.parse(raw)).toISOString() : startOfDayIso(now);
        return json(spendSummary(app.store.db, { since, until: new Date(now).toISOString(), flyUsdPerMonth: Number(process.env.FLY_USD_PER_MONTH ?? 0) || 0 }));
      },
    },
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
      if (p === "/welcome") return asset("landing.html", "text/html; charset=utf-8");
      if (p === "/landing.css") return asset("landing.css", "text/css; charset=utf-8");
      if (p === "/styles.css") return asset("styles.css", "text/css; charset=utf-8");
      if (p === "/health") {
        // Public and cheap: states and times only, never an error's text (that is /api/ops/errors, for operators).
        const h = app.ops.health();
        return json({ ...h, auth: !!auth }, h.ok ? 200 : 503);
      }
      if (p === "/oauth/google/callback") {
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        const raw = app.store.getKv(`oauth:google:${state}`);
        if (!raw || !code) return bad("that sign-in link is not valid any more", 400);
        app.store.deleteKv(`oauth:google:${state}`);
        const { personId } = JSON.parse(raw) as { personId: string };
        const redirectUri = `${process.env.PUBLIC_URL ?? url.origin}/oauth/google/callback`;
        const tok = await googleExchange({ clientId: process.env.GOOGLE_CLIENT_ID ?? "", clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "", redirectUri }, code);
        app.vault.put(personId, "google", JSON.stringify({ refresh_token: tok.refresh_token, email: tok.email }));
        const person = app.store.getPerson(personId);
        if (person && tok.email && !person.email) {
          person.email = tok.email;
          app.store.putPerson(person);
        }
        return new Response(null, { status: 302, headers: { location: "/#settings" } });
      }
      if (p.startsWith("/d/")) {
        const art = app.store.getArtifact(p.slice(3).split("/")[0] ?? "");
        if (!art) return bad("not found", 404);
        const me = auth ? (await auth.personFor(req))?.id : undefined;
        const member = !auth || !art.roomId || (!!me && !!app.store.getMembership(art.roomId, me));
        if (art.share !== "link" && !member) return privatePage(cfg && fapi ? { publishableKey: cfg.publishableKey, frontendApi: fapi } : undefined);
        return artifactPage(art, url.searchParams.has("raw"), { member });
      }
      if (!p.startsWith("/api/")) return bad("not found", 404);

      const hit = routes.flatMap((x) => (x.method === req.method ? [[x, p.match(x.re)] as const] : [])).find(([, m]) => m);
      if (!hit?.[1]) return bad("not found", 404);
      const body = await readBody(req);
      if (body instanceof Response) return body;
      const me = auth ? (await auth.personFor(req))?.id : undefined;
      const c: Ctx = { req, url, me, params: hit[1].slice(1), body };
      return permit(hit[0], c) ?? (await hit[0].handle(c));
    } catch (e) {
      app.ops.error(`web ${req.method} ${p}`, e);
      return bad("internal error", 500);
    }
  }
  return server;
}

export type { Delivery };
