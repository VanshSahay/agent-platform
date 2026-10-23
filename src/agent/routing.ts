import type { AgentSpec } from "../core/types.ts";
import type { Store } from "../store/repos.ts";

/**
 * Which agent answers on a channel line (iMessage, WhatsApp…). One deployment can hold many agents;
 * each line points at one of them, chosen by its owner in Settings, so adding an agent to a group
 * is adding that agent's line to the group — no code change. Without a choice, the first agent answers.
 */
export function agentForChannel(store: Store, channel: string): AgentSpec | undefined {
  const chosen = store.getKv(`channel-agent:${channel}`);
  return (chosen ? store.getAgent(chosen) : undefined) ?? store.listAgents()[0];
}

export function setAgentForChannel(store: Store, channel: string, agentId: string) {
  store.setKv(`channel-agent:${channel}`, agentId);
}
