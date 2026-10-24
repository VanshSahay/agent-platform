import { dayIn } from "../core/clock.ts";
import type { AgentSpec, Memory, Person, Plan, Room, RunTrigger } from "../core/types.ts";
import type { Skill } from "../skills/skills.ts";
import { skillIndex } from "../skills/skills.ts";

/**
 * The system prompt, assembled in a stable order and returned in two blocks so
 * the prefix caches: `stable` (identity and soul, owner instructions, how you
 * work, room priorities, standing rules, skills index) repeats on every turn
 * and run and is cached; `volatile` (who is being served, the room, profiles,
 * matched skill bodies, memories, ledger, plan, situation) follows it. A cache
 * miss in the stable block is a bug: only change it on purpose.
 */
export function buildSystemPrompt(input: {
  agent: AgentSpec;
  room: Room;
  roomDescription: string;
  requester?: Person;
  owner?: Person;
  now: number;
  trigger: RunTrigger;
  rules: Memory[];
  profiles: { label: string; text: string; derivedAt: number }[];
  memories: Memory[];
  skills: Skill[];
  matchedSkills: Skill[];
  ledger: string;
  plan?: Plan;
  planText?: string;
  accounts: { accountOwnerName: string; needsApproval: boolean };
  /** The room's own priorities, set when the circle added the assistant. */
  roomFocus?: string;
  requesterRole?: string;
  /** Delegated tasks in this room, with progress and what was already told the room. */
  tasksText?: string;
  /** Services the account owner for this request has connected (names only). */
  connectedServices?: string[];
}): { stable: string; volatile: string } {
  const a = input.agent;
  const zone = input.owner?.timezone ?? "UTC";
  const stable: string[] = [];
  const volatile: string[] = [];

  stable.push(`You are ${a.name}, ${input.owner?.displayName ?? "your owner"}'s personal assistant, working inside their chats. ${a.purpose}`);
  stable.push(
    [
      `Identity: ${a.soul.identity}`,
      `Personality: ${a.soul.personality}`,
      `Values: ${a.soul.values}`,
      `Operating principles: ${a.soul.operatingPrinciples}`,
      a.soul.failureRecovery ? `When stuck: ${a.soul.failureRecovery}` : "",
      a.soul.proactiveBehaviors ? `Proactively: ${a.soul.proactiveBehaviors}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  if (a.instructions.trim()) stable.push(`Owner's instructions:\n${a.instructions.trim()}`);

  stable.push(
    [
      "How you work:",
      // The rules live in skills/_core-rules.md so the harness loop can propose edits to them like any skill.
      input.skills.find((sk) => sk.name === "_core-rules")?.body ??
        "- Everything you do is a tool call that gets recorded; anything that contacts a third party, spends money or uses an account asks first.",
    ].join("\n"),
  );

  if (input.roomFocus) {
    stable.push(
      [
        `Priorities in this chat: ${input.roomFocus}`,
        "- These come first here, and you may step in without being named when a message plainly concerns them.",
        "- You are still a general assistant: anything else people ask for is yours to help with too.",
      ].join("\n"),
    );
  }

  if (input.rules.length) stable.push(`Standing rules from the owner (follow exactly):\n${input.rules.map((r) => `- ${r.text} (${dateOf(r.statedAt, zone)})`).join("\n")}`);

  if (input.skills.length) stable.push(`Procedures you can follow (read the matching ones below):\n${skillIndex(input.skills)}`);

  if (input.requester?.techComfort === "low") {
    volatile.push(
      [
        "The person you are talking to is not comfortable with technology.",
        "- Short messages, one step or one question at a time, no jargon, no lists longer than three.",
        "- Use their words for things. Never say 'just', 'simply' or 'obviously'.",
        "- Ask what they see on the screen before telling them what to tap.",
        "- Anything needing a password, a code or money: say who you will ask instead of asking them to read it out.",
      ].join("\n"),
    );
  }

  volatile.push(`Where you are:\n${input.roomDescription}`);
  const acc = input.accounts;
  volatile.push(
    acc.needsApproval
      ? `Accounts: this request would use ${acc.accountOwnerName}'s accounts and money, so anything that does must be approved by them (the tools will ask). Tell the group "I've asked ${acc.accountOwnerName} to OK that" when that happens, then continue once approved.`
      : `Accounts: this request may use ${acc.accountOwnerName}'s own accounts for their own request, within the trust settings.`,
  );

  for (const p of input.profiles) volatile.push(`${p.label} (summary as of ${dateOf(p.derivedAt, zone)}):\n${p.text}`);

  for (const s of input.matchedSkills) volatile.push(`Procedure "${s.name}":\n${s.body}`);

  if (input.memories.length) {
    volatile.push(
      `Relevant notes (newest first; dated):\n${input.memories
        .slice(0, 40)
        .map((m) => `- ${dateOf(m.statedAt, zone)} [${m.type}] ${m.text}`)
        .join("\n")}`,
    );
  }

  volatile.push(`Responsibilities ledger for this room:\n${input.ledger}`);
  if (input.tasksText) volatile.push(`Delegated tasks in this room:\n${input.tasksText}`);
  if (input.connectedServices?.length)
    volatile.push(`Connected accounts for ${input.accounts.accountOwnerName}: ${input.connectedServices.join(", ")} (the tools use them; you never see the credentials).`);

  if (input.plan && input.planText) volatile.push(`Current plan:\n${input.planText}`);

  const situation = [
    `Now: ${nowLine(input.now, zone)} (${zone}). Trigger: ${input.trigger}.`,
    `Coming days: ${comingDays(input.now, zone)}.`,
    input.requester
      ? `Speaking with: ${input.requester.displayName}${input.requester.pronouns ? ` (${input.requester.pronouns})` : ""}${input.requester.techComfort === "low" ? ", low tech comfort: one step at a time" : ""}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  volatile.push(situation);

  return { stable: stable.join("\n\n"), volatile: volatile.join("\n\n") };
}

function dateOf(ms: number, zone: string) {
  return dayIn(ms, zone);
}

/** Weekday and year spelled out: without them the model guessed, and "Thursday" landed a day late (eval run 13). */
export function nowLine(at: number, zone: string): string {
  // Built from parts: the joined format ("at" or a comma, a narrow space before AM) differs between ICU versions.
  const p = partsOf(at, zone, { weekday: "long", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${p("weekday")}, ${p("month")} ${p("day")}, ${p("year")}, ${p("hour")}:${p("minute")} ${p("dayPeriod")}`;
}

/** The next fourteen days as "Wed Oct 14", so a weekday is looked up, never computed. */
export function comingDays(at: number, zone: string): string {
  return Array.from({ length: 14 }, (_, i) => {
    const p = partsOf(at + (i + 1) * 86_400_000, zone, { weekday: "short", month: "short", day: "numeric" });
    return `${p("weekday")} ${p("month")} ${p("day")}`;
  }).join(", ");
}

function partsOf(at: number, zone: string, opts: Intl.DateTimeFormatOptions) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, ...opts }).formatToParts(new Date(at));
  return (type: Intl.DateTimeFormatPartTypes) => parts.find((x) => x.type === type)?.value ?? "";
}
