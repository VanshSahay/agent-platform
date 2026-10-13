import { fmtWhen } from "../core/clock.ts";
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
  extra?: string;
}): string {
  const a = input.agent;
  const zone = input.owner?.timezone ?? "UTC";
  const parts: string[] = [];

  parts.push(`You are ${a.name}, a personal agent deployed by ${input.owner?.displayName ?? "your owner"} into their chats. Purpose: ${a.purpose}`);
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
      "- Everything you do is a tool call that gets recorded. A reply that claims an action with no record is corrected. Never say something is done unless a tool result says so.",
      "- Anything that contacts a third party, spends money, or uses someone's account asks first; the tools enforce it. When a tool says it is waiting for approval, tell the room in one short line and stop.",
      "- Prefer the cheapest channel and switch when it stalls: search, ask the group, call, ask a community (with permission), ask a specific person. State a plan with the plan tool before multi-step work.",
      "- Responsibilities get an owner and a time (track_commitment). Facts worth keeping get a note (remember). Newer notes win; dates matter.",
      "- Private things stay in the room or chat where they were said.",
      "- Reply in plain words, short. In a group, one message. Use the person's own words for things.",
    ].join("\n"),
  );

  if (input.rules.length) parts.push(`Standing rules from the owner (follow exactly):\n${input.rules.map((r) => `- ${r.text} (${dateOf(r.statedAt)})`).join("\n")}`);

  if (input.skills.length) parts.push(`Procedures you can follow (read the matching ones below):\n${skillIndex(input.skills)}`);

  parts.push(`Where you are:\n${input.roomDescription}`);
  const acc = input.accounts;
  parts.push(
    acc.needsApproval
      ? `Accounts: this request would use ${acc.accountOwnerName}'s accounts and money, so anything that does must be approved by them (the tools will ask). Tell the group "I've asked ${acc.accountOwnerName} to OK that" when that happens, then continue once approved.`
      : `Accounts: this request may use ${acc.accountOwnerName}'s own accounts for their own request, within the trust settings.`,
  );

  for (const p of input.profiles) parts.push(`${p.label} (summary as of ${dateOf(p.derivedAt)}):\n${p.text}`);

  for (const s of input.matchedSkills) parts.push(`Procedure "${s.name}":\n${s.body}`);

  if (input.memories.length) {
    parts.push(
      `Relevant notes (newest first; dated):\n${input.memories
        .slice(0, 40)
        .map((m) => `- ${dateOf(m.statedAt)} [${m.type}] ${m.text}`)
        .join("\n")}`,
    );
  }

  parts.push(`Responsibilities ledger for this room:\n${input.ledger}`);

  if (input.plan && input.planText) parts.push(`Current plan:\n${input.planText}`);

  const situation = [
    `Now: ${fmtWhen(input.now, zone)} (${zone}). Trigger: ${input.trigger}.`,
    input.requester ? `Speaking with: ${input.requester.displayName}${input.requester.pronouns ? ` (${input.requester.pronouns})` : ""}${input.requester.techComfort === "low" ? ", low tech comfort: one step at a time" : ""}.` : "",
    input.readOnly ? "This room is read-only for you; answer questions but take no actions." : "",
    input.extra ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  parts.push(situation);

  return parts.join("\n\n");
}

function dateOf(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}
