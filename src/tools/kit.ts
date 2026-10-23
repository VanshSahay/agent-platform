import type { Clock } from "../core/clock.ts";
import type { AgentSpec, ApproachKind, AttentionItem, AttentionKind, Authorization, Id, Room, Run, Session, Task } from "../core/types.ts";
import type { TaskService } from "../tasks/tasks.ts";
import type { ToolSpec } from "../model/types.ts";
import type { Store } from "../store/repos.ts";
import type { MemoryService } from "../memory/memory.ts";
import type { RoomService } from "../rooms/rooms.ts";
import type { AttentionService } from "../inbox/attention.ts";
import type { CommitmentService } from "../care/commitments.ts";
import type { Planner } from "../planning/planner.ts";
import type { Hands } from "./hands.ts";
import type { ModelClient } from "../model/types.ts";

export type ToolFamily =
  | "plan"
  | "search"
  | "people"
  | "calls"
  | "community"
  | "memory"
  | "schedule"
  | "ledger"
  | "money"
  | "google"
  | "knowledge"
  | "operator"
  | "shopping"
  | "wholesale"
  | "voice"
  | "contacts"
  | "email"
  | "mcp";

/** What a tool hands back to the runtime. */
export interface ToolResult {
  ok: boolean;
  /** What the model sees. Objects are JSON-encoded. */
  content: unknown;
  /** Provider evidence that the effect happened. */
  evidence?: string;
  /** The run must pause until this attention item is answered. */
  waitingOn?: AttentionItem;
  /** The approach stalled (no results, no answer); the planner should count it. */
  stall?: string;
  /** Message the agent should relay to the room verbatim (e.g. "I've asked Alex to OK that"). */
  roomNotice?: string;
  /** Plan progress signal when the tool embodies an approach. */
  approach?: ApproachKind;
  /** The run should end without saying anything; the reason goes in the record. */
  quiet?: string;
  /** The action was held (working hours, a decline): nothing happened, the plan step is not done. */
  held?: boolean;
  /** A done label for this call, replacing the registry's generic one (Fo: "Handyman listings searched"). */
  label?: string;
}

export type GateDecision = { granted: true; reason: string } | { granted: false; item: AttentionItem; notice?: string } | { granted: false; held: string };

export interface ToolContext {
  store: Store;
  clock: Clock;
  memory: MemoryService;
  rooms: RoomService;
  attention: AttentionService;
  commitments: CommitmentService;
  planner: Planner;
  hands: Hands;
  agent: AgentSpec;
  room: Room;
  session: Session;
  run: Run;
  requesterId?: Id;
  tasks: TaskService;
  /** Which services the person whose accounts this request may use has connected. Never the secrets. */
  vault: { services(): string[]; has(service: string): boolean; use<T>(service: string, fn: (secret: string) => T): T | undefined; put(service: string, secret: string): void };
  /** The model, for the few tools that read an image or write prose on their own. */
  model: ModelClient;
  /** The boot-level providers this server has wired (what a `needs` on a tool means). */
  providers: ReadonlySet<string>;
  /** Where links to artifacts, dashboards and settings pages point. */
  publicUrl: string;
  /** Whose accounts this request may use (the requester with consent, else the owner). */
  accountOwnerId: Id;
  /** Hand a task to a task agent; it starts once this run has replied. */
  delegate(task: Task): void;
  /** Pass a note into a running task; false when it is not running. */
  steerTask(taskId: Id, text: string): boolean;
  /** Ask for a yes before an effect, or learn it was pre-authorised. */
  gate(input: {
    kind: AttentionKind;
    title: string;
    detail: string;
    money?: number;
    outreach?: { who: string; how: "phone" | "sms" | "email" | "community_post"; contact?: string };
    /** What a yes permits: the tool and the payload that matters (number, text, amount, merchant). An approval covers exactly this. */
    key: unknown[];
  }): GateDecision;
  /** Stop a run (a task's run) from a tool. */
  stopRun(runId: Id): void;
  /** Send a message to a person's private chat with the agent (cards, questions). */
  dm(personId: Id, text: string): void;
  /** Resolve a member by name or id inside this room. */
  findMember(nameOrId: string): { id: Id; name: string } | undefined;
  progress(text: string): void;
}

export interface ToolDef {
  spec: ToolSpec;
  family: ToolFamily;
  labels: { running: string; done: string; failed?: string };
  /** Writes or contacts someone. Side-effect tools ask first unless trusted. */
  sideEffect: boolean;
  /**
   * The boot-level provider this tool needs (google, email, speech, payments,
   * phone, browser, images). A tool without `needs` is always offered. This is
   * about what the server wired, not who connected what: per-person connection
   * stays inside the tool, which reports notConnected.
   */
  needs?: string;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Mark a whole family as needing one provider (e.g. all of Google needs the OAuth app). */
export function withNeeds<T extends ToolDef>(defs: T[], needs: string): T[] {
  return defs.map((t) => ({ ...t, needs }));
}

export const obj = (properties: Record<string, unknown>, required: string[] = []): ToolSpec["input_schema"] =>
  ({ type: "object", properties, required, additionalProperties: false }) as ToolSpec["input_schema"];
export const str = (description: string) => ({ type: "string", description });
export const num = (description: string) => ({ type: "number", description });

export const s = (v: unknown) => (typeof v === "string" ? v : "");
export const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export type Outreach = Authorization["disclosedOutreach"][number];
export const HOWS = new Set(["phone", "email", "sms", "community_post"]);
/** Only well-formed entries become pre-approved outreach; anything else is dropped. */
export function parseOutreach(v: unknown): Outreach[] {
  if (!Array.isArray(v)) return [];
  const out: Outreach[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    if (typeof o.who === "string" && o.who.trim() && typeof o.how === "string" && HOWS.has(o.how))
      out.push({ who: o.who.trim(), how: o.how as Outreach["how"], why: s(o.why) || "not stated", contact: contactKey(s(o.contact)) || undefined });
  }
  return out.slice(0, 10);
}
export const describeOutreach = (xs: Outreach[]) => xs.map((d) => `${d.who}${d.contact ? ` <${d.contact}>` : ""} by ${d.how} (${d.why})`).join("; ");

/**
 * The one way a tool answers a gate that did not open: a working-hours hold is reported as held, a pending
 * card pauses the run with the waiting text. Returns undefined when the gate is granted.
 */
export function askFirst(gate: GateDecision, waiting: string, extra: Partial<ToolResult> = {}): ToolResult | undefined {
  if (gate.granted) return undefined;
  if ("held" in gate) return { ok: true, content: gate.held, held: true, ...extra };
  return { ok: true, content: waiting, waitingOn: gate.item, roomNotice: gate.notice, ...extra };
}

/** A phone number or address in one comparable form: digits with the plus, or a lowercased email. */
export const contactKey = (v: string) => {
  const t = v.trim().toLowerCase();
  if (!t) return "";
  return t.includes("@") ? t : t.replace(/[^+\d]/g, "");
};
/** "https://www.ubereats.com/orders" and "ubereats.com" both mean ubereats.com. */
/**
 * A URL the server may fetch on a member's behalf: http(s), and not the box itself or the
 * network behind it. Checked by hostname, not by resolving it (ponytail: a DNS answer that
 * points at 10.x gets through; resolve first if this ever runs somewhere with private services).
 */
export function publicUrl(v: string): URL | undefined {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return undefined;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return undefined;
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return undefined;
  return u;
}

export function siteOf(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]!
    .replace(/[^a-z0-9.-]/g, "");
}
