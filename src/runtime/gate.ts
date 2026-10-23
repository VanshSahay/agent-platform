import { sha256 } from "../core/ids.ts";
import { contactKey } from "../tools/kit.ts";
import { hourIn, type Clock } from "../core/clock.ts";
import type { AgentSpec, Id, Room, Run, TrustPolicy } from "../core/types.ts";
import type { Store } from "../store/repos.ts";
import type { RoomService } from "../rooms/rooms.ts";
import type { AttentionService } from "../inbox/attention.ts";
import type { GateDecision, ToolContext } from "../tools/registry.ts";

export type GateInput = Parameters<ToolContext["gate"]>[0];

/** The trust of someone who set none: every purchase and every listed tool asks. */
const NO_TRUST: TrustPolicy = { autoAllow: [], autoApproveUnderUsd: 0, spendingPaused: false, communityPostingAllowed: [] };

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
    const contact = contactKey(g.outreach.contact ?? "");
    // Name and channel must match, and so must the number or address once one is known: a disclosure
    // made without one binds to the first contact used, so "Dr. Lee's office" cannot become any number.
    const disclosed = sched?.authorization.disclosedOutreach.find(
      (d) => d.who.toLowerCase() === g.outreach!.who.toLowerCase() && d.how === g.outreach!.how && (!d.contact || !contact || d.contact === contact),
    );
    if (disclosed && sched) {
      if (!disclosed.contact && contact) {
        disclosed.contact = contact;
        store.putSchedule(sched);
      }
      return { granted: true, reason: `disclosed when scheduled: ${disclosed.why}` };
    }
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

  // Whose money and whose trust (multiplayer-spec §7.3): a room owner is the payer of their
  // own purchases, with their per-person trust over the agent's default; everyone else spends
  // from the owner's side, and the owner answers. Per-person payment sources land with Stripe.
  // Shortcuts (threshold, allow list, communities) apply only when the request runs on the
  // requester's own accounts: a co-owner never borrows the agent owner's trust or accounts.
  // The agent owner's default is the agent's policy; a co-owner's default trusts nothing.
  const requesterRole = run.requesterId ? rooms.role(room.id, run.requesterId) : undefined;
  const ownAccounts = !!run.requesterId && accounts.accountOwnerId === run.requesterId;
  const requesterIsAnOwner = ownAccounts && (run.requesterId === agent.ownerId || requesterRole === "owner");
  const trustOf = (id: Id) => store.getPerson(id)?.trust ?? (id === agent.ownerId ? agent.trust : NO_TRUST);
  const payerIsRequester = g.kind === "purchase_approval" && requesterIsAnOwner;
  const payer = payerIsRequester ? store.getPerson(run.requesterId!) : undefined;
  const payerTrust = payerIsRequester ? trustOf(run.requesterId!) : agent.trust;
  const requesterTrust = requesterIsAnOwner ? trustOf(run.requesterId!) : NO_TRUST;
  const money = g.money ?? 0;
  if (g.kind === "purchase_approval" && payerTrust.spendingPaused) return { granted: false, held: "Spending is paused. Do not buy; tell them." };
  if (g.kind === "purchase_approval" && payerIsRequester && money > 0 && money <= payerTrust.autoApproveUnderUsd) {
    return { granted: true, reason: `under ${payer?.displayName ?? "the payer"}'s $${payerTrust.autoApproveUnderUsd} threshold` };
  }
  if (g.kind === "community_post_approval" && g.outreach && requesterTrust.communityPostingAllowed.some((c) => c.toLowerCase() === g.outreach!.who.toLowerCase())) {
    return { granted: true, reason: "community pre-approved by the owner" };
  }
  // The owner's trust list names tools that may run for the owner without asking; the key's first part is the tool.
  const tool = Array.isArray(g.key) ? String(g.key[0] ?? "") : "";
  if (requesterIsAnOwner && tool && requesterTrust.autoAllow.includes(tool))
    return { granted: true, reason: `${tool} is on ${store.getPerson(run.requesterId!)?.displayName ?? "the owner"}'s trust list` };

  // Who answers: the payer for their own purchase; the first owner otherwise, whose money and
  // accounts are at stake. For a co-owner the card goes to their own DM, not their partner's.
  const assignee = payerIsRequester ? payer! : (rooms.approversFor(room)[0] ?? owner);
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
