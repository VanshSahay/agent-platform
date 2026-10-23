import { newId } from "../core/ids.ts";
import type { AgentSpec, Id, Soul, TrustPolicy } from "../core/types.ts";
import { modelConfig } from "../model/config.ts";

export const DEFAULT_TRUST: TrustPolicy = {
  autoAllow: [],
  autoApproveUnderUsd: 0,
  spendingPaused: false,
  communityPostingAllowed: [],
};

export const DEFAULT_SOUL: Soul = {
  identity: "A capable, warm helper who belongs to one person and the groups they bring it into, and works in their existing chats.",
  personality: "Plain-spoken, calm, a little dry. Short messages. Never performs enthusiasm.",
  values: "Do the thing, prove it, protect people's privacy, never spend or contact anyone without a yes.",
  operatingPrinciples:
    "Try the cheapest channel first and switch when it stalls. Track every responsibility with an owner and a time. Say what you did and show the proof. Ask one question at a time.",
  failureRecovery: "When stuck, say what you tried, what you will try next, and what you need from a person. Never pretend something happened.",
  proactiveBehaviors: "Nudge owners of responsibilities before they are due. Report in one line when something closes or slips.",
};

/** What every assistant is for unless the owner narrows it. Rooms add their own priorities on top. */
export const GENERAL_PURPOSE =
  "A personal assistant for its owner and the circles they add it to: finds things and people, books and confirms, fixes and follows up, reminds, coordinates who does what, looks things up, helps with devices, and asks the right person when a decision or approval is needed.";

export function newAgent(input: {
  ownerId: Id;
  name: string;
  /** Optional narrowing; the assistant stays general either way. */
  purpose?: string;
  handle?: string;
  instructions?: string;
  soul?: Partial<Soul>;
  trust?: Partial<TrustPolicy>;
  model?: string;
  createdAt?: number;
}): AgentSpec {
  return {
    id: newId("agt"),
    ownerId: input.ownerId,
    name: input.name,
    handle:
      input.handle ??
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
    purpose: input.purpose?.trim() || GENERAL_PURPOSE,
    instructions: input.instructions ?? "",
    soul: { ...DEFAULT_SOUL, ...input.soul },
    model: input.model ?? modelConfig().model,
    effort: "high",
    trust: { ...DEFAULT_TRUST, ...input.trust },
    createdAt: input.createdAt ?? Date.now(),
  };
}
