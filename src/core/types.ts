// Domain types for Circle: a personal agent that lives in the group chats
// people already have. Every object here is persisted; the runtime never
// keeps authoritative state in memory.

export type Id = string;
export type UnixMs = number;

// ---------- People and rooms ----------

export interface Person {
  id: Id;
  displayName: string;
  pronouns?: string;
  timezone: string; // IANA
  phoneE164?: string;
  email?: string;
  /** How patient and detailed the agent should be with this person. */
  techComfort?: "low" | "medium" | "high";
  /** Saved delivery addresses, for checkout and forms. */
  addresses?: Address[];
  /** May the agent send email from this person's own Gmail? Off until they turn it on; each send still asks. */
  sendAsMe?: boolean;
  /** Two records were one human (multiplayer-spec §11): this record's data moved to the id it names. */
  mergedInto?: Id;
  /** Per-person trust for an owner (multiplayer-spec §7.3): their own threshold, pause and allow list. The agent's policy is the default. */
  trust?: TrustPolicy;
  /** Records merged INTO this one; their old messages still point at them. */
  mergedFrom?: Id[];
  createdAt: UnixMs;
}

export interface Address {
  id: Id;
  label: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode?: string;
  country: string;
}

/** Something the agent made that people can open: a document, a dashboard, a file, an image, audio, a call recording. */
export interface Artifact {
  id: Id;
  agentId: Id;
  roomId?: Id;
  runId?: Id;
  kind: "document" | "dashboard" | "hotels" | "flights" | "file" | "image" | "audio";
  title: string;
  /** Markdown for documents, a dashboard spec, or a file's metadata (name, mime, size, path). */
  data: unknown;
  /** Anyone with the link, or members of the room only. */
  share: "room" | "link";
  createdAt: UnixMs;
}

export type RoomKind = "dm" | "group";
export type ChannelKind = "web" | "imessage" | "sms" | "whatsapp" | "telegram" | "slack" | "console" | "voice";

/**
 * Roles inside a room.
 * owner  : the person who set the agent up; their accounts and money, and the approvals that go with them.
 * member : a signed-up person; once they consent, their own accounts serve their own requests.
 * guest  : never signed up; served through the owner, who OKs anything that uses accounts or money.
 */
export type MemberRole = "owner" | "member" | "guest";

export interface Room {
  id: Id;
  agentId: Id;
  kind: RoomKind;
  channel: ChannelKind;
  /** Channel-specific thread identity, e.g. the iMessage chat guid. */
  externalId?: string;
  name: string;
  /** What this circle added the assistant for: its priorities here. It stays a general assistant for everything else. */
  focus?: string;
  /** Working hours in the room owner's zone for third-party outreach. */
  outreachHours: { start: number; end: number }; // 24h clock, e.g. 8..20
  createdAt: UnixMs;
}

export interface Membership {
  roomId: Id;
  personId: Id;
  role: MemberRole;
  /** Member said "yes, use my accounts for my own asks" once. */
  consentedAt?: UnixMs;
  joinedAt: UnixMs;
}

// ---------- Agent ----------

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Soul {
  identity: string;
  personality: string;
  values: string;
  operatingPrinciples: string;
  failureRecovery?: string;
  proactiveBehaviors?: string;
}

export interface TrustPolicy {
  /** Tool names that may run without asking. Everything else that writes asks first. */
  autoAllow: string[];
  /** Purchases at or under this amount do not ask. 0 means always ask. */
  autoApproveUnderUsd: number;
  spendingPaused: boolean;
  /** Posting to public communities (Reddit, Rednote) always needs a yes unless listed here by community. */
  communityPostingAllowed: string[];
}

export interface AgentSpec {
  id: Id;
  ownerId: Id;
  name: string;
  handle: string;
  purpose: string;
  instructions: string;
  soul: Soul;
  model: string;
  /** The owner chose this model; boot leaves it alone instead of following the deployment default. */
  modelPinned?: boolean;
  /** The owner's off switch: no run starts, schedules wait, until it is turned back on. */
  paused?: boolean;
  effort: Effort;
  trust: TrustPolicy;
  /** Procedures this agent may use, by skill name; absent means all. Core rules always apply. */
  skills?: string[];
  /** Tools this agent may use, by tool name or family; absent means every tool the server wired. */
  tools?: string[];
  createdAt: UnixMs;
}

// ---------- Memory ----------

export type MemoryType =
  | "rule"
  | "preference"
  | "person"
  | "schedule"
  | "store"
  | "inventory"
  | "decision"
  | "fact"
  | "lesson" // something the agent taught someone, and how far they got
  | "observation"; // raw, written by the agent during a run; promoted by consolidation

export type MemoryScope = "agent" | "person" | "room";

export interface Memory {
  id: Id;
  agentId: Id;
  scope: MemoryScope;
  /** personId for scope=person, roomId for scope=room, agentId for scope=agent. */
  scopeId: Id;
  type: MemoryType;
  /** Who said it or whom it is about; used for privacy routing. */
  subjectPersonId?: Id;
  /** Rooms allowed to see this memory. Empty means only the scope itself. */
  visibleToRooms: Id[];
  text: string;
  /** Alternate words a keyword search should hit (Instinct-style). */
  aliases: string[];
  statedAt: UnixMs;
  /** Set when a newer memory corrects this one. */
  supersededBy?: Id;
  /** Explicit "that is not happening" or "forget that". */
  retractedAt?: UnixMs;
  sourceRunId?: Id;
  createdAt: UnixMs;
}

export interface Profile {
  agentId: Id;
  scope: MemoryScope;
  scopeId: Id;
  /** Short always-on summary the agent reads first. */
  text: string;
  derivedAt: UnixMs;
}

// ---------- Sessions, runs and events ----------

export type RunStatus = "running" | "waiting" | "done" | "failed" | "stopped";

export type RunTrigger =
  | "message" // a person wrote in the room
  | "scheduled_action"
  | "heartbeat"
  | "follow_up" // a commitment nudge
  | "approval" // an approval came back
  | "steer"
  | "task" // a delegated task's own run
  | "event"; // a connected app sent something

export interface Session {
  id: Id;
  roomId: Id;
  agentId: Id;
  title?: string;
  /** room: the room's own conversation; task: a task agent's private session. The room lookup never returns a task session. */
  kind: "room" | "task";
  /** A task agent's private session; the room session stays free. */
  taskId?: Id;
  /** Compaction: older messages folded into prose so the context stays short. */
  summary?: string;
  summaryThroughAt?: UnixMs;
  /** The last message folded into the summary; the cut is by position, so two messages in one millisecond cannot straddle it. */
  summaryThroughId?: Id;
  createdAt: UnixMs;
  lastActivityAt: UnixMs;
}

/**
 * A delegated task: long work handed to a task agent that runs in its own
 * session, keeps a progress line, and records what it has delivered so a
 * resume never reports the same thing twice.
 */
export interface Task {
  id: Id;
  agentId: Id;
  roomId: Id;
  sessionId: Id;
  requesterId?: Id;
  title: string;
  instructions: string;
  status: "running" | "waiting" | "done" | "failed" | "stopped";
  progress: string;
  runId?: Id;
  delivered: { at: UnixMs; text: string }[];
  createdByRunId?: Id;
  createdAt: UnixMs;
  updatedAt: UnixMs;
  endedAt?: UnixMs;
}

export interface Run {
  /** What was asked, for message and task runs: the ground the same-errand check compares against. */
  requestText?: string;
  id: Id;
  sessionId: Id;
  roomId: Id;
  agentId: Id;
  trigger: RunTrigger;
  /** Who caused it; absent for timers. */
  requesterId?: Id;
  status: RunStatus;
  /** Why it is waiting, when status=waiting. */
  waitingOn?: Id; // attention item id
  /** The schedule that fired this run, if any; carries its authorisation. */
  scheduleId?: Id;
  /** The delegated task this run works on, if any. */
  taskId?: Id;
  /** Ended without saying anything: silence was the right outcome. */
  quiet?: boolean;
  /** The system message that triggered this run (timers, events), folded away if the run stays quiet. */
  triggerMessageId?: Id;
  dedupKey?: string;
  startedAt: UnixMs;
  endedAt?: UnixMs;
  /** One line, in the agent's words, for the activity tab. */
  outcome?: string;
  failureReason?: string;
}

export type RunEventType =
  | "started"
  | "delta"
  | "progress"
  | "agent_state"
  | "plan"
  | "tool_start"
  | "tool_end"
  | "user_message"
  | "steer_queued"
  | "steer_applied"
  | "gate_opened"
  | "gate_resolved"
  | "resumed"
  | "run_queued"
  | "reply"
  | "error"
  | "done";

export type AgentState = "idle" | "working" | "analyzing" | "calling" | "waiting" | "blocked" | "done" | "failed";

export interface RunEvent {
  /** Monotonic within a session; this is the watch cursor. */
  seq: number;
  runId: Id;
  sessionId: Id;
  type: RunEventType;
  at: UnixMs;
  data: Record<string, unknown>;
}

export type ToolStatus = "running" | "done" | "failed" | "stopped";

export interface ToolCallRecord {
  id: Id;
  runId: Id;
  name: string;
  family: string;
  status: ToolStatus;
  input: unknown;
  result?: unknown;
  labelRunning: string;
  labelDone: string;
  /** Provider evidence the result is real (call sid, message id, URL, etc.). */
  evidence?: string;
  /** SHA-256 of name+input+result for the integrity footer. */
  fingerprint: string;
  startedAt: UnixMs;
  endedAt?: UnixMs;
}

// ---------- Messages ----------

export type MessageRole = "user" | "assistant" | "system";

export interface Message {
  id: Id;
  sessionId: Id;
  roomId: Id;
  runId?: Id;
  role: MessageRole;
  /** Person who wrote it (user) or the agent id (assistant). */
  authorId: Id;
  text: string;
  /** For system turns: scheduled_action | heartbeat | approval | commitment ... */
  source?: string;
  /** Members allowed to see it; empty means the whole room. */
  visibleTo: Id[];
  /** A trigger whose run stayed quiet: kept in the record, left out of the model's history. */
  folded?: boolean;
  /** An embedded card the UI renders inside the chat. */
  card?: ConnectCard;
  at: UnixMs;
}

// ---------- Attention (needs you) ----------

export type AttentionKind =
  | "decision" // approve or choose
  | "information" // the agent needs a fact only a person has
  | "action" // a person must do something (sign in, pay, show up)
  | "purchase_approval"
  | "outreach_approval" // contacting a third party
  | "community_post_approval"
  | "guest_request" // a guest asked for something that uses the owner's accounts
  | "credential_fix"
  | "connect_account" // a member signs in to a site in an embedded browser; the agent never sees the password
  | "suggested_action";

/** A rich card carried by an attention item and by the chat message that shows it. */
export interface ConnectCard {
  kind: "connect_account";
  itemId: Id;
  site: string;
  /** The embeddable live view of the sign-in browser. */
  liveViewUrl: string;
  status: "open" | "done" | "cancelled";
}

export type AttentionStatus = "open" | "resolved" | "dismissed" | "expired";

export interface AttentionItem {
  id: Id;
  agentId: Id;
  roomId: Id;
  runId?: Id;
  /** The person who must answer. */
  assigneeId: Id;
  /** The person who asked, when different (guest requests). */
  requesterId?: Id;
  kind: AttentionKind;
  /** What a yes would permit: sha256 of the tool and the payload that matters. Set for gates. */
  gateKey?: string;
  /** An embedded card (a sign-in browser) instead of a plain yes/no. */
  card?: ConnectCard;
  title: string;
  detail: string;
  /** Choices for a decision, if any. */
  options?: string[];
  status: AttentionStatus;
  answer?: string;
  /** Who answered; may differ from the assignee when an owner or decider answers on their behalf. */
  answeredBy?: Id;
  createdAt: UnixMs;
  resolvedAt?: UnixMs;
  expiresAt?: UnixMs;
}

// ---------- Schedules ----------

export interface Calendar {
  hour?: number;
  minute?: number;
  dayOfWeek?: number[]; // 0..6
  dayOfMonth?: number[];
  everyDays?: number;
  /** Interval schedules (watches) run every N hours from the last run. */
  everyHours?: number;
  timeZone: string;
}

/**
 * What the owner authorised when the schedule was created. The run re-reads
 * this before acting and re-checks the premise against live state.
 */
export interface Authorization {
  basis: "user_requested" | "standing_rule" | "agent_initiative";
  /**
   * Third parties the owner was told about: name, how, why, and the number or address when known.
   * A disclosure without a contact binds to the first one used, so a later run cannot reach a
   * different number under the same name. Anyone else needs a fresh yes.
   */
  disclosedOutreach: { who: string; how: "phone" | "email" | "sms" | "community_post"; why: string; contact?: string }[];
  /** What must still be true for the action to make sense. */
  premise: string;
}

export interface Schedule {
  id: Id;
  agentId: Id;
  roomId: Id;
  sessionId: Id;
  title: string;
  prompt: string;
  calendar?: Calendar;
  runAt?: UnixMs;
  authorization: Authorization;
  /** An alert rule: the run checks the condition and stays quiet unless it holds. */
  watch?: { condition: string; action: string; until?: UnixMs };
  paused: boolean;
  numRuns: number;
  nextRunAt?: UnixMs;
  lastRunAt?: UnixMs;
  createdByRunId?: Id;
  createdAt: UnixMs;
}

/**
 * A recorded yes or no. Gates match on the gate key (tool plus the payload
 * that matters: number, text, amount, merchant), bound to the run that asked,
 * and an approval is consumed the first time it lets an action through.
 */
export interface Approval {
  id: Id;
  agentId: Id;
  roomId: Id;
  runId: Id;
  itemId: Id;
  gateKey: string;
  decision: "yes" | "no";
  decidedBy: Id;
  decidedAt: UnixMs;
  consumedAt?: UnixMs;
}

// ---------- Responsibilities ----------

export type CommitmentStatus = "open" | "done" | "dropped" | "blocked";

/**
 * A thing someone (a member or the agent) said they would do. The agent
 * follows these up; this is what makes "it tracks responsibilities" real.
 */
export interface Commitment {
  id: Id;
  roomId: Id;
  agentId: Id;
  /** personId, or the agent id when the agent owns it. */
  ownerId: Id;
  /** Who it is for (the cared-for parent, for example). */
  beneficiaryId?: Id;
  title: string;
  detail?: string;
  dueAt?: UnixMs;
  status: CommitmentStatus;
  /** How many nudges have gone out. */
  nudges: number;
  nextNudgeAt?: UnixMs;
  sourceRunId?: Id;
  createdAt: UnixMs;
  closedAt?: UnixMs;
}

// ---------- Plans ----------

export type ApproachKind = "search" | "ask_room" | "ask_person" | "call" | "community_post" | "browse" | "wait";

export interface PlanStep {
  id: Id;
  text: string;
  approach: ApproachKind;
  status: "pending" | "active" | "done" | "failed" | "skipped";
  /** Fallbacks to try, in order, if this step fails or stalls. */
  alternatives: ApproachKind[];
  attempts: number;
  evidence?: string;
}

export interface Plan {
  id: Id;
  runId: Id;
  goal: string;
  /** Opened by the runtime on the first approach-shaped tool call, not by the model. */
  auto?: boolean;
  steps: PlanStep[];
  /** Index of the active step. */
  cursor: number;
  createdAt: UnixMs;
  updatedAt: UnixMs;
  /** How many times the model rewrote the remaining course (revise_plan). */
  revisions?: number;
}
