import { newId } from "../core/ids.ts";
import { DAY, HOUR, hourIn, nextOccurrence, type Clock } from "../core/clock.ts";
import type { Authorization, Calendar, Id, Schedule, StagedItem } from "../core/types.ts";
import type { Store } from "../store/repos.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { CommitmentService } from "../care/commitments.ts";
import type { AttentionService } from "../inbox/attention.ts";
import type { ModelClient } from "../model/types.ts";

/**
 * Timers. One tick does five things, each idempotent by dedup key:
 *  1. fire due schedules (after re-checking the premise),
 *  2. deliver staged outreach once working hours begin,
 *  3. nudge owners of responsibilities that are due,
 *  4. expire stale attention items,
 *  5. heartbeat: wake the agent on standing work at most once a day per room.
 */
export class Scheduler {
  constructor(
    private store: Store,
    private clock: Clock,
    private runtime: Runtime,
    private commitments: CommitmentService,
    private attention: AttentionService,
    private model: ModelClient,
    private opts: { heartbeatEveryMs?: number } = {},
  ) {}

  static createSchedule(
    store: Store,
    clock: Clock,
    input: {
      agentId: Id;
      roomId: Id;
      sessionId: Id;
      title: string;
      prompt: string;
      runAt?: number;
      calendar?: Calendar;
      authorization: Authorization;
      createdByRunId?: Id;
    },
  ): Schedule {
    const now = clock.now();
    const s: Schedule = {
      id: newId("sch"),
      agentId: input.agentId,
      roomId: input.roomId,
      sessionId: input.sessionId,
      title: input.title,
      prompt: input.prompt,
      calendar: input.calendar,
      runAt: input.runAt,
      authorization: input.authorization,
      paused: false,
      numRuns: 0,
      createdByRunId: input.createdByRunId,
      createdAt: now,
    };
    s.nextRunAt = computeNext(s, now);
    store.putSchedule(s);
    return s;
  }

  pause(id: Id, paused: boolean) {
    const s = this.store.getSchedule(id);
    if (!s) return;
    s.paused = paused;
    if (!paused && !s.nextRunAt) s.nextRunAt = computeNext(s, this.clock.now());
    this.store.putSchedule(s);
  }

  async tick(): Promise<{ fired: number; staged: number; nudged: number; expired: number; heartbeats: number }> {
    const now = this.clock.now();
    const out = { fired: 0, staged: 0, nudged: 0, expired: 0, heartbeats: 0 };

    for (const s of this.store.dueSchedules(now)) {
      await this.fire(s, now);
      out.fired += 1;
    }

    for (const item of this.store.dueStaged(now)) {
      const room = this.store.getRoom(item.roomId);
      const zone = room ? (this.store.getPerson(this.store.getAgent(room.agentId)?.ownerId ?? "")?.timezone ?? "UTC") : "UTC";
      const h = hourIn(zone, now);
      if (room && (h < room.outreachHours.start || h >= room.outreachHours.end)) continue;
      item.deliveredAt = now;
      this.store.putStaged(item);
      await this.runtime.startSystemRun({
        roomId: item.roomId,
        trigger: "scheduled_action",
        source: "staged_outreach",
        dedupKey: `staged:${item.id}`,
        text: `Working hours began. Deliver the held outreach now: ${JSON.stringify(item.payload)}. Re-check that it is still needed first; if not, say what you found instead.`,
      });
      out.staged += 1;
    }

    for (const c of this.commitments.takeDueNudges(now)) {
      const owner = this.store.getPerson(c.ownerId);
      const ben = c.beneficiaryId ? this.store.getPerson(c.beneficiaryId) : undefined;
      await this.runtime.startSystemRun({
        roomId: c.roomId,
        trigger: "follow_up",
        source: "commitment_nudge",
        dedupKey: `nudge:${c.id}:${c.nudges}`,
        text: `Follow-up on responsibility [${c.id}] "${c.title}"${ben ? ` for ${ben.displayName}` : ""}, owned by ${owner?.displayName ?? (c.ownerId === c.agentId ? "you" : c.ownerId)}${c.dueAt ? `, due ${new Date(c.dueAt).toISOString()}` : ""}. Status: ${c.status}, nudges so far: ${c.nudges}. If you own it, do it or report what blocks it. If a person owns it, check in with them in one line (ask_person for private, or the room if it was agreed there) and update the ledger from their answer.`,
      });
      out.nudged += 1;
    }

    out.expired = this.attention.expireDue(now).length;

    const every = this.opts.heartbeatEveryMs ?? DAY;
    for (const room of this.store.listRooms()) {
      const last = Number(this.store.getKv(`heartbeat:${room.id}`) ?? 0);
      if (now - last < every) continue;
      const open = this.commitments.open(room.id);
      const schedules = this.store.listSchedules({ roomId: room.id }).filter((s) => !s.paused);
      this.store.setKv(`heartbeat:${room.id}`, String(now));
      if (!open.length && !schedules.length) continue;
      await this.runtime.startSystemRun({
        roomId: room.id,
        trigger: "heartbeat",
        source: "heartbeat",
        dedupKey: `heartbeat:${room.id}:${Math.floor(now / every)}`,
        text: "Heartbeat check-in. Look at the ledger and the schedules. Only speak if something changed, slipped, or needs a person; otherwise reply with exactly: (nothing to report)",
      });
      out.heartbeats += 1;
    }
    return out;
  }

  private async fire(s: Schedule, now: number) {
    s.numRuns += 1;
    s.lastRunAt = now;
    s.nextRunAt = s.calendar ? computeNext(s, now) : undefined;
    this.store.putSchedule(s);

    const premiseCheck = await this.checkPremise(s);
    const runText = premiseCheck.holds
      ? `Scheduled action "${s.title}" fired. Your instructions when you scheduled it:\n${s.prompt}\n\nAuthorisation: basis ${s.authorization.basis}. Disclosed outreach: ${s.authorization.disclosedOutreach.map((d) => `${d.who} by ${d.how} (${d.why})`).join("; ") || "none"}. Anyone not named needs a fresh yes.\nPremise: "${s.authorization.premise}". Premise check: ${premiseCheck.note}\nBefore contacting anyone, verify the premise against the ledger, recent messages and your notes. If it no longer holds, say what you found instead.`
      : `Scheduled action "${s.title}" fired, but its premise ("${s.authorization.premise}") no longer seems to hold: ${premiseCheck.note}. Do not act on it. Tell the room what you found in one line, and pause or delete the schedule if it is done (it is paused for you now).`;
    if (!premiseCheck.holds) {
      s.paused = true;
      this.store.putSchedule(s);
    }
    await this.runtime.startSystemRun({ roomId: s.roomId, trigger: "scheduled_action", source: "scheduled_action", dedupKey: `schedule:${s.id}:${s.numRuns}`, text: runText, scheduleId: s.id });
  }

  /** Cheap model check of the premise against what the ledger and room say. Fails open (holds) when the model is silent. */
  private async checkPremise(s: Schedule): Promise<{ holds: boolean; note: string }> {
    const ledger = this.commitments.open(s.roomId).map((c) => `- ${c.title} [${c.status}]`).join("\n") || "(empty)";
    const recent = this.store
      .messagesForRoom(s.roomId, 15)
      .map((m) => `${m.role}: ${m.text.slice(0, 200)}`)
      .join("\n");
    const raw = await this.model.complete({
      system: 'Answer with JSON only: {"holds": true|false, "note": "<one sentence>"}. "holds" is false only when the evidence clearly shows the premise is no longer true.',
      prompt: `Premise: ${s.authorization.premise}\nLedger:\n${ledger}\nRecent messages:\n${recent}`,
      effort: "low",
      maxTokens: 300,
    });
    try {
      const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      if (typeof j.holds === "boolean") return { holds: j.holds, note: String(j.note ?? "") };
    } catch {
      /* fall through */
    }
    return { holds: true, note: "not verified automatically; verify before acting" };
  }

  /** Hold an outreach payload until working hours. */
  stage(input: Omit<StagedItem, "id" | "createdAt" | "deliveredAt">): StagedItem {
    const item: StagedItem = { ...input, id: newId("stg"), createdAt: this.clock.now() };
    this.store.putStaged(item);
    return item;
  }
}

export function computeNext(s: Schedule, now: number): number | undefined {
  if (s.runAt !== undefined) return s.numRuns === 0 ? s.runAt : undefined;
  const c = s.calendar;
  if (!c) return undefined;
  if (c.everyDays) {
    const base = s.lastRunAt ?? now;
    return nextOccurrence(base + (c.everyDays - 1) * DAY, c.timeZone, c.hour ?? 9, c.minute ?? 0);
  }
  if (c.hour === undefined) return now + HOUR;
  return nextOccurrence(now, c.timeZone, c.hour, c.minute ?? 0, c.dayOfWeek);
}
