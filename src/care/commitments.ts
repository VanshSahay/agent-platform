import { newId } from "../core/ids.ts";
import { DAY, HOUR, type Clock } from "../core/clock.ts";
import type { Commitment, Id } from "../core/types.ts";
import type { Store } from "../store/repos.ts";

/**
 * The responsibilities ledger. "Jo's flight lands at 2 on the 22nd,
 * Sam drives" is two commitments: the pickup (beneficiary Jo, owner the
 * agent, who confirms it) and the ride (owner Ben). The agent nudges owners
 * before due time and reports to the room when things close.
 */
export class CommitmentService {
  constructor(
    private store: Store,
    private clock: Clock,
  ) {}

  track(input: { roomId: Id; agentId: Id; ownerId: Id; beneficiaryId?: Id; title: string; detail?: string; dueAt?: number; sourceRunId?: Id }): Commitment {
    const now = this.clock.now();
    const c: Commitment = {
      id: newId("cmt"),
      roomId: input.roomId,
      agentId: input.agentId,
      ownerId: input.ownerId,
      beneficiaryId: input.beneficiaryId,
      title: input.title,
      detail: input.detail,
      dueAt: input.dueAt,
      status: "open",
      nudges: 0,
      nextNudgeAt: firstNudge(now, input.dueAt),
      sourceRunId: input.sourceRunId,
      createdAt: now,
    };
    this.store.putCommitment(c);
    return c;
  }

  update(id: Id, patch: { status?: Commitment["status"]; dueAt?: number; detail?: string; ownerId?: Id }): Commitment {
    const c = this.store.getCommitment(id);
    if (!c) throw new Error(`commitment ${id} not found`);
    if (patch.status) {
      c.status = patch.status;
      if (patch.status !== "open") {
        c.closedAt = this.clock.now();
        c.nextNudgeAt = undefined;
      } else {
        // Reopened (or unblocked): nudging starts over, else it would never fire again.
        c.closedAt = undefined;
        c.nudges = 0;
        c.nextNudgeAt = firstNudge(this.clock.now(), patch.dueAt ?? c.dueAt);
      }
    }
    if (patch.dueAt !== undefined) {
      c.dueAt = patch.dueAt;
      c.nextNudgeAt = firstNudge(this.clock.now(), patch.dueAt);
    }
    if (patch.detail !== undefined) c.detail = patch.detail;
    if (patch.ownerId) c.ownerId = patch.ownerId;
    this.store.putCommitment(c);
    return c;
  }

  /** Called by the scheduler: returns commitments whose nudge is due and advances their nudge clock. */
  /** `held` leaves a commitment due for later (its agent is paused) instead of spending a nudge on it. */
  takeDueNudges(now = this.clock.now(), held: (c: Commitment) => boolean = () => false): Commitment[] {
    const due = this.store.dueCommitments(now).filter((c) => !held(c));
    for (const c of due) {
      c.nudges += 1;
      // Nudge again a day later, then every day until done; stop after 3 nudges past due.
      const overdue = c.dueAt !== undefined && now > c.dueAt;
      c.nextNudgeAt = overdue && c.nudges >= 3 ? undefined : now + DAY;
      if (overdue && c.nudges >= 3) c.status = "blocked";
      this.store.putCommitment(c);
    }
    return due;
  }

  open(roomId: Id): Commitment[] {
    return this.store.listCommitments({ roomId, status: ["open", "blocked"] }).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
  }

  describe(roomId: Id, nameOf: (id: Id) => string, zone: string): string {
    const open = this.open(roomId);
    if (!open.length) return "No open responsibilities.";
    return open
      .map((c) => {
        const due = c.dueAt
          ? ` due ${new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(c.dueAt))}`
          : "";
        const forWhom = c.beneficiaryId ? ` for ${nameOf(c.beneficiaryId)}` : "";
        return `- [${c.id}] ${c.title}${forWhom}, ${nameOf(c.ownerId)}${due}${c.status === "blocked" ? " (overdue, needs a decision)" : ""}`;
      })
      .join("\n");
  }
}

/** First nudge: a day before due, or in a day if there is no due date or it is sooner than that. */
function firstNudge(now: number, dueAt?: number): number {
  if (!dueAt) return now + 2 * DAY;
  const dayBefore = dueAt - DAY;
  if (dayBefore > now + HOUR) return dayBefore;
  return Math.max(now + HOUR, dueAt - 2 * HOUR);
}
