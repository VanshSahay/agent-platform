import { sha256 } from "../core/ids.ts";
import { hourIn, type Clock } from "../core/clock.ts";
import type { AgentSpec, Id, Room, Run } from "../core/types.ts";
import type { Store } from "../store/repos.ts";
import type { RoomService } from "../rooms/rooms.ts";
import type { AttentionService } from "../inbox/attention.ts";
import type { GateDecision, ToolContext } from "../tools/registry.ts";

export type GateInput = Parameters<ToolContext["gate"]>[0];

/**
 * Approval policy, the one place that decides whether an effect may happen now.
 * Pre-authorised: owner asking within trust; disclosed outreach on a schedule; small
 * purchases. Otherwise open an item for the right approver.
 */
export function decideGate(
  d: { store: Store; rooms: RoomService; attention: AttentionService; clock: Clock },
  run: Run,
  room: Room,
  agent: AgentSpec,
  accounts: { accountOwnerId: Id; needsApproval: boolean },
  g: GateInput,
): GateDecision {
  const { store, rooms, attention, clock } = d;
  const owner = store.getPerson(agent.ownerId);
  const zone = owner?.timezone ?? "UTC";

  // Working hours for outreach: a held item is not queued anywhere; the model is told to schedule it for the morning.
  if (g.outreach && g.outreach.how !== "community_post") {
    const h = hourIn(zone, clock.now());
    if (h < room.outreachHours.start || h >= room.outreachHours.end) {
      return {
        granted: false,
        held: `It is outside working hours (${room.outreachHours.start}:00 to ${room.outreachHours.end}:00 ${zone}). Contacting ${g.outreach.who} will wait until the morning; tell the room that and schedule it with schedule_action for the next morning, naming ${g.outreach.who} as disclosed outreach.`,
      };
    }
  }

  // Scheduled runs carry their own authorisation.
  if (run.scheduleId && g.outreach) {
    const sched = store.getSchedule(run.scheduleId);
    const disclosed = sched?.authorization.disclosedOutreach.find((d) => d.who.toLowerCase() === g.outreach!.who.toLowerCase() && d.how === g.outreach!.how);
    if (disclosed) return { granted: true, reason: `disclosed when scheduled: ${disclosed.why}` };
  }

  // An approval is a record bound to this run and to exactly this action (the gate key).
  // A yes is consumed by the first action it lets through; a no sticks for the run.
  const gateKey = sha256(g.key);
  const approval = store.approvalsFor(room.id, gateKey).find((a) => a.runId === run.id && (a.decision === "no" || !a.consumedAt));
  if (approval) {
    const who = store.getPerson(approval.decidedBy)?.displayName ?? "the approver";
    if (approval.decision === "yes") {
      approval.consumedAt = clock.now();
      store.putApproval(approval);
      return { granted: true, reason: `approved by ${who}` };
    }
    return { granted: false, held: `${who} declined this. Do not retry it; tell the room and try another approach or stop.` };
  }

  const requesterIsOwner = run.requesterId === agent.ownerId;
  const money = g.money ?? 0;
  if (g.kind === "purchase_approval" && agent.trust.spendingPaused) return { granted: false, held: "Spending is paused by the owner. Do not buy; tell them." };
  if (g.kind === "purchase_approval" && requesterIsOwner && money > 0 && money <= agent.trust.autoApproveUnderUsd) {
    return { granted: true, reason: `under the $${agent.trust.autoApproveUnderUsd} threshold` };
  }
  if (g.kind === "community_post_approval" && g.outreach && agent.trust.communityPostingAllowed.includes(g.outreach.who)) {
    return { granted: true, reason: "community pre-approved by the owner" };
  }
  if (g.kind === "outreach_approval" && requesterIsOwner && (agent.trust.autoAllow.includes("place_call") || agent.trust.autoAllow.includes("send_sms"))) {
    const tool = g.outreach?.how === "phone" ? "place_call" : "send_sms";
    if (agent.trust.autoAllow.includes(tool)) return { granted: true, reason: `${tool} is on the owner's trust list` };
  }

  // Who answers: the owner, whose money and accounts are at stake.
  const assignee = rooms.approversFor(room)[0] ?? owner;
  if (!assignee) throw new Error("no approver");
  const kind = run.requesterId && run.requesterId !== assignee.id && accounts.needsApproval ? "guest_request" : g.kind;
  const requesterName = run.requesterId ? (store.getPerson(run.requesterId)?.displayName ?? "someone") : agent.name;
  const twin = store.listAttention({ roomId: room.id, status: ["open"] }).find((a) => a.gateKey === gateKey && a.assigneeId === assignee.id);
  if (twin)
    return {
      granted: false,
      item: twin,
      notice: run.requesterId === assignee.id ? undefined : `${assignee.displayName} has already been asked about that; I'll continue once they answer.`,
    };
  const item = attention.open({
    agentId: agent.id,
    roomId: room.id,
    runId: run.id,
    assigneeId: assignee.id,
    requesterId: run.requesterId,
    kind,
    gateKey,
    title: g.title,
    detail: kind === "guest_request" ? `${requesterName} asked in "${room.name}". ${g.detail}` : g.detail,
    options: ["Yes", "No"],
    ttlMs: 3 * 24 * 60 * 60 * 1000,
  });
  const notice = run.requesterId === assignee.id ? undefined : `I've asked ${assignee.displayName} to OK that.`;
  return { granted: false, item, notice };
}
