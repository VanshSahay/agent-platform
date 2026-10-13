import { newId } from "../core/ids.ts";
import type { AgentSpec, Id, Soul, TrustPolicy } from "../core/types.ts";
import { DEFAULT_MODEL } from "../model/anthropic.ts";

export const DEFAULT_TRUST: TrustPolicy = {
  autoAllow: [],
  autoApproveUnderUsd: 0,
  spendingPaused: false,
  communityPostingAllowed: [],
};

export const DEFAULT_SOUL: Soul = {
  identity: "A capable, warm helper who belongs to one family or circle of friends and works in their existing chats.",
  personality: "Plain-spoken, calm, a little dry. Short messages. Never performs enthusiasm.",
  values: "Do the thing, prove it, protect people's privacy, never spend or contact anyone without a yes.",
  operatingPrinciples:
    "Try the cheapest channel first and switch when it stalls. Track every responsibility with an owner and a time. Say what you did and show the proof. Ask one question at a time.",
  failureRecovery: "When stuck, say what you tried, what you will try next, and what you need from a person. Never pretend something happened.",
  proactiveBehaviors: "Nudge owners of responsibilities before they are due. Report in one line when something closes or slips.",
};

export function newAgent(input: { ownerId: Id; name: string; purpose: string; handle?: string; instructions?: string; soul?: Partial<Soul>; trust?: Partial<TrustPolicy> }): AgentSpec {
  return {
    id: newId("agt"),
    ownerId: input.ownerId,
    name: input.name,
    handle: input.handle ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    purpose: input.purpose,
    instructions: input.instructions ?? "",
    soul: { ...DEFAULT_SOUL, ...input.soul },
    model: DEFAULT_MODEL,
    effort: "high",
    trust: { ...DEFAULT_TRUST, ...input.trust },
    rules: [],
    createdAt: Date.now(),
  };
}

/** An agent can be deployed into a group once it has a name and has learned a few things. */
export function deployable(agent: AgentSpec, memoryCount: number): { ok: boolean; why?: string } {
  if (!agent.name.trim()) return { ok: false, why: "needs a name" };
  if (!agent.purpose.trim()) return { ok: false, why: "needs a purpose" };
  if (memoryCount < 3 && agent.rules.length < 1) return { ok: false, why: "train it first: tell it a few things about you and one rule" };
  return { ok: true };
}
