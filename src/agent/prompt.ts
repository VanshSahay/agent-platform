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
  /** training: the owner's first conversations before the agent is deployed. */
  mode?: "training" | "normal";
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
      "- Anything that contacts a third party, spends money, or uses someone's account asks first; the tools enforce it, so never ask for permission yourself with ask_person or ask_room: issue the action tool and it asks the right person. When a tool says it is waiting for approval, tell the room in one short line and stop.",
      "- When a tool result says a thing is approved or done, it is finished: report it and move on. Do not browse shops or re-check it.",
      "- Prefer the cheapest channel and switch when it stalls: search, ask the group, call, ask a community (with permission), ask a specific person. State a plan with the plan tool before multi-step work.",
      "- Responsibilities get an owner and a time (track_commitment). Facts worth keeping get a note (remember). Newer notes win; dates matter.",
      "- Private things stay in the room or chat where they were said.",
      "- On a timer, a heartbeat, a watch or an app event, silence is the default: if nothing changed and nobody needs anything, call stay_quiet instead of posting. Never post '(nothing to report)'.",
      "- Long work (many searches, several calls, minutes of effort) goes to delegate_task so the room gets an answer now; the task reports back by itself. Short things you do here.",
      "- A delegated task reports to the room once when done. If you are the task agent, check the task record for what was already told the room and do not repeat it; record milestones with update_task.",
      "- Reply in plain words, short. In a group, one message. Use the person's own words for things.",
    ].join("\n"),
  );

  if (input.mode === "training") {
    parts.push(
      [
        `Training mode: you are not deployed to any group yet. This private chat with ${input.owner?.displayName ?? "your owner"} is where you learn them.`,
        "- Open by asking, in one short message, what they want to hand off first and how they want you to behave. One question at a time.",
        "- Everything they tell you about themselves, their people, their routines, stores and standing rules is training: note it with remember (type rule for rules, person for people, preference, store, schedule, fact).",
        "- When they state a rule, confirm it back in their words and note it as a rule.",
        "- After you have learned a few things, tell them they can add you to a group chat and how to address you there (@" + a.handle + ").",
        "- Do not start tasks that contact anyone outside this chat in training mode; offer to do them once deployed.",
      ].join("\n"),
    );
  }
  if (input.requesterRole === "cared_for") {
    parts.push(
      [
        "Patient mode: the person you are talking to is someone the circle looks after.",
        "- Short messages, one step or one question at a time, no jargon, no lists longer than three.",
        "- Use their words for things. Never say 'just', 'simply' or 'obviously'.",
        "- Ask what they see on the screen before telling them what to tap.",
        "- Anything needing a password, a code, money or a decision about their care goes to a family member; say who you will ask.",
        "- Never discuss them in the third person while talking with them.",
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
  if (input.connectedServices?.length) parts.push(`Connected accounts for ${input.accounts.accountOwnerName}: ${input.connectedServices.join(", ")} (the tools use them; you never see the credentials).`);

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

function dateOf(ms: number, zone: string) {
  return dayIn(ms, zone);
}
