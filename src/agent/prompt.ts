import { dayIn, fmtWhen } from "../core/clock.ts";
import type { AgentSpec, Memory, Person, Plan, Room, RunTrigger } from "../core/types.ts";
import type { Skill } from "../skills/skills.ts";
import { skillIndex } from "../skills/skills.ts";

/**
 * The system prompt, assembled in a stable order so the prefix caches:
 * identity and soul (stable per agent) -> standing rules -> skills index ->
 * room and people -> profiles -> matched skill bodies -> dated memories ->
 * ledger -> plan -> situation (volatile, last).
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
  readOnly?: boolean;
  accounts: { accountOwnerName: string; needsApproval: boolean };
  /** The room's own priorities, set when the circle added the assistant. */
  roomFocus?: string;
  requesterRole?: string;
  /** Delegated tasks in this room, with progress and what was already told the room. */
  tasksText?: string;
  /** Services the account owner for this request has connected (names only). */
  connectedServices?: string[];
  extra?: string;
}): string {
  const a = input.agent;
  const zone = input.owner?.timezone ?? "UTC";
  const parts: string[] = [];

  parts.push(`You are ${a.name}, ${input.owner?.displayName ?? "your owner"}'s personal assistant, working inside their chats. ${a.purpose}`);
  parts.push(
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
  if (a.instructions.trim()) parts.push(`Owner's instructions:\n${a.instructions.trim()}`);

  parts.push(
    [
      "How you work:",
      // The rules live in skills/_core-rules.md so the harness loop can propose edits to them like any skill.
      input.skills.find((sk) => sk.name === "_core-rules")?.body ??
        "- Everything you do is a tool call that gets recorded; anything that contacts a third party, spends money or uses an account asks first.",
    ].join("\n"),
  );

  if (input.roomFocus) {
    parts.push(
      [
        `Priorities in this chat: ${input.roomFocus}`,
        "- These come first here, and you may step in without being named when a message plainly concerns them.",
        "- You are still a general assistant: anything else people ask for is yours to help with too.",
      ].join("\n"),
    );
  }
  if (input.requester?.techComfort === "low") {
    parts.push(
      [
        "The person you are talking to is not comfortable with technology.",
        "- Short messages, one step or one question at a time, no jargon, no lists longer than three.",
        "- Use their words for things. Never say 'just', 'simply' or 'obviously'.",
        "- Ask what they see on the screen before telling them what to tap.",
        "- Anything needing a password, a code or money: say who you will ask instead of asking them to read it out.",
      ].join("\n"),
    );
  }

  if (input.rules.length) parts.push(`Standing rules from the owner (follow exactly):\n${input.rules.map((r) => `- ${r.text} (${dateOf(r.statedAt, zone)})`).join("\n")}`);

  if (input.skills.length) parts.push(`Procedures you can follow (read the matching ones below):\n${skillIndex(input.skills)}`);

  parts.push(`Where you are:\n${input.roomDescription}`);
  const acc = input.accounts;
  parts.push(
    acc.needsApproval
      ? `Accounts: this request would use ${acc.accountOwnerName}'s accounts and money, so anything that does must be approved by them (the tools will ask). Tell the group "I've asked ${acc.accountOwnerName} to OK that" when that happens, then continue once approved.`
      : `Accounts: this request may use ${acc.accountOwnerName}'s own accounts for their own request, within the trust settings.`,
  );

  for (const p of input.profiles) parts.push(`${p.label} (summary as of ${dateOf(p.derivedAt, zone)}):\n${p.text}`);

  for (const s of input.matchedSkills) parts.push(`Procedure "${s.name}":\n${s.body}`);

  if (input.memories.length) {
    parts.push(
      `Relevant notes (newest first; dated):\n${input.memories
        .slice(0, 40)
        .map((m) => `- ${dateOf(m.statedAt, zone)} [${m.type}] ${m.text}`)
        .join("\n")}`,
    );
  }

  parts.push(`Responsibilities ledger for this room:\n${input.ledger}`);
  if (input.tasksText) parts.push(`Delegated tasks in this room:\n${input.tasksText}`);
  if (input.connectedServices?.length)
    parts.push(`Connected accounts for ${input.accounts.accountOwnerName}: ${input.connectedServices.join(", ")} (the tools use them; you never see the credentials).`);

  if (input.plan && input.planText) parts.push(`Current plan:\n${input.planText}`);

  const situation = [
    `Now: ${fmtWhen(input.now, zone)} (${zone}). Trigger: ${input.trigger}.`,
    input.requester
      ? `Speaking with: ${input.requester.displayName}${input.requester.pronouns ? ` (${input.requester.pronouns})` : ""}${input.requester.techComfort === "low" ? ", low tech comfort: one step at a time" : ""}.`
      : "",
    input.readOnly ? "This room is read-only for you; answer questions but take no actions." : "",
    input.extra ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  parts.push(situation);

  return parts.join("\n\n");
}

function dateOf(ms: number, zone: string) {
  return dayIn(ms, zone);
}
