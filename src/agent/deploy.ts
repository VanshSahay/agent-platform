import type { AgentSpec } from "../core/types.ts";
import type { Store } from "../store/repos.ts";
import type { Clock } from "../core/clock.ts";
import { deployable } from "./spec.ts";

/**
 * An agent is trained in the owner's private chat first. Deploying marks it
 * ready for group rooms; the check is the same one the UI shows.
 */
export function deployAgent(store: Store, clock: Clock, agentId: string): { ok: true; agent: AgentSpec } | { ok: false; why: string } {
  const agent = store.getAgent(agentId);
  if (!agent) return { ok: false, why: "no such agent" };
  const learned = store.listMemories(agent.id).filter((m) => m.type !== "observation").length;
  const rules = store.listMemories(agent.id, { type: "rule" }).length;
  const check = deployable({ ...agent, rules: agent.rules.length ? agent.rules : new Array(rules).fill("") }, learned);
  if (!check.ok) return { ok: false, why: check.why ?? "not ready" };
  agent.deployedAt = agent.deployedAt ?? clock.now();
  store.putAgent(agent);
  return { ok: true, agent };
}

export function deployCheck(store: Store, agent: AgentSpec): { ok: boolean; why?: string } {
  const learned = store.listMemories(agent.id).filter((m) => m.type !== "observation").length;
  const rules = store.listMemories(agent.id, { type: "rule" }).length;
  return deployable({ ...agent, rules: agent.rules.length ? agent.rules : new Array(rules).fill("") }, learned);
}
