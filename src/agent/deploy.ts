import type { Clock } from "../core/clock.ts";
import type { AgentSpec } from "../core/types.ts";
import type { Store } from "../store/repos.ts";
import { deployable } from "./spec.ts";

export interface DeployStatus {
  ok: boolean;
  why?: string;
  /** Durable (non-observation) memories the agent has learned. */
  learned: number;
  /** Rule memories; stand in for spec rules when the owner taught them in chat. */
  rules: number;
}

/**
 * The one readiness check: what the UI shows and what deployAgent enforces.
 * Rules taught in the owner's chat live in memory, so they count towards the
 * spec's rule requirement when the spec itself lists none.
 */
export function deployStatus(store: Store, agent: AgentSpec): DeployStatus {
  const learned = store.listMemories(agent.id).filter((m) => m.type !== "observation").length;
  const rules = store.listMemories(agent.id, { type: "rule" }).length;
  const check = deployable({ ...agent, rules: agent.rules.length ? agent.rules : new Array(rules).fill("") }, learned);
  return { ok: check.ok, why: check.why, learned, rules };
}

/**
 * An agent is trained in the owner's private chat first. Deploying marks it
 * ready for group rooms.
 */
export function deployAgent(store: Store, clock: Clock, agentId: string): { ok: true; agent: AgentSpec } | { ok: false; why: string } {
  const agent = store.getAgent(agentId);
  if (!agent) return { ok: false, why: "no such agent" };
  const status = deployStatus(store, agent);
  if (!status.ok) return { ok: false, why: status.why ?? "not ready" };
  agent.deployedAt = agent.deployedAt ?? clock.now();
  store.putAgent(agent);
  return { ok: true, agent };
}

/** Kept for existing callers; deployStatus is the same check with the counts. */
export function deployCheck(store: Store, agent: AgentSpec): { ok: boolean; why?: string } {
  const { ok, why } = deployStatus(store, agent);
  return { ok, why };
}
