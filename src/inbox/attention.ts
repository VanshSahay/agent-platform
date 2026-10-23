import { newId } from "../core/ids.ts";
import type { Clock } from "../core/clock.ts";
import type { AttentionItem, AttentionKind, ConnectCard, Id, Run } from "../core/types.ts";
import type { Store } from "../store/repos.ts";

/**
 * The "Need your input" queue. One item per question only a person can
 * answer. Resolving an item resumes the run that opened it.
 */
export class AttentionService {
  private closedHooks: ((item: AttentionItem) => void)[] = [];
  constructor(
    private store: Store,
    private clock: Clock,
  ) {}

  /** The runtime listens so a run waiting on a dismissed or expired item does not wait forever. */
  onClosed(fn: (item: AttentionItem) => void) {
    this.closedHooks.push(fn);
  }
  private closed(item: AttentionItem) {
    for (const fn of this.closedHooks) fn(item);
  }

  open(input: {
    agentId: Id;
    roomId: Id;
    runId?: Id;
    assigneeId: Id;
    requesterId?: Id;
    kind: AttentionKind;
    gateKey?: string;
    card?: ConnectCard;
    title: string;
    detail: string;
    options?: string[];
    ttlMs?: number;
  }): AttentionItem {
    const now = this.clock.now();
    const item: AttentionItem = {
      id: newId("att"),
      agentId: input.agentId,
      roomId: input.roomId,
      runId: input.runId,
      assigneeId: input.assigneeId,
      requesterId: input.requesterId,
      kind: input.kind,
      gateKey: input.gateKey,
      card: input.card,
      title: input.title,
      detail: input.detail,
      options: input.options,
      status: "open",
      createdAt: now,
      expiresAt: input.ttlMs ? now + input.ttlMs : undefined,
    };
    this.store.putAttention(item);
    return item;
  }

  resolve(id: Id, answer: string, answeredBy?: Id): AttentionItem {
    const item = this.store.getAttention(id);
    if (!item) throw new Error(`attention ${id} not found`);
    if (item.status !== "open") return item;
    item.status = "resolved";
    item.answer = answer;
    item.answeredBy = answeredBy ?? item.assigneeId;
    item.resolvedAt = this.clock.now();
    this.store.putAttention(item);
    return item;
  }

  dismiss(id: Id) {
    const item = this.store.getAttention(id);
    if (item?.status !== "open") return item;
    item.status = "dismissed";
    item.resolvedAt = this.clock.now();
    this.store.putAttention(item);
    this.closed(item);
    return item;
  }

  expireDue(now = this.clock.now()): AttentionItem[] {
    const out: AttentionItem[] = [];
    for (const item of this.store.listAttention({ status: ["open"] })) {
      if (item.expiresAt && item.expiresAt <= now) {
        item.status = "expired";
        item.resolvedAt = now;
        this.store.putAttention(item);
        this.closed(item);
        out.push(item);
      }
    }
    return out;
  }

  openFor(assigneeId: Id): AttentionItem[] {
    return this.store.listAttention({ assigneeId, status: ["open"] });
  }

  /** The three home tabs. */
  inbox(personId: Id, agentId: Id) {
    const needsYou = this.openFor(personId).filter((a) => a.agentId === agentId);
    const radar = this.store
      .listSchedules({ agentId })
      .filter((s) => !s.paused)
      .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
    const inFlight = this.store.listRuns({ agentId, status: ["running", "waiting"] }).map((r) => this.withWait(r));
    const tasks = this.store.listTasks({ agentId, status: ["running", "waiting"] });
    const activity = this.store.listRuns({ agentId, status: ["done", "failed", "stopped"], limit: 30 });
    return { needsYou, radar, inFlight, tasks, activity };
  }

  /** What a waiting run waits on. A sign-in nobody but the account holder can give is "blocked", not just slow. */
  private withWait(run: Run): Run & { state: "running" | "waiting" | "blocked"; waitingFor?: { kind: AttentionKind; assigneeId: Id; title: string } } {
    const item = run.waitingOn ? this.store.getAttention(run.waitingOn) : undefined;
    if (run.status !== "waiting" || !item) return { ...run, state: run.status === "waiting" ? "waiting" : "running" };
    const blocked = item.kind === "credential_fix" || item.kind === "connect_account" || item.status !== "open";
    return { ...run, state: blocked ? "blocked" : "waiting", waitingFor: { kind: item.kind, assigneeId: item.assigneeId, title: item.title } };
  }
}

export const KIND_LABEL: Record<AttentionKind, string> = {
  decision: "Decision needed",
  information: "Information needed",
  action: "Action needed",
  purchase_approval: "Purchase approval",
  outreach_approval: "OK to contact someone",
  community_post_approval: "OK to post publicly",
  guest_request: "Someone asked for your help",
  credential_fix: "Sign-in needed",
  connect_account: "Sign in to a site",
  suggested_action: "Suggestion",
};
