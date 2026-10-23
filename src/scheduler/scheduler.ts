import { newId } from "../core/ids.ts";
import { DAY, HOUR, nextOccurrence, type Clock } from "../core/clock.ts";
import type { DocState } from "../channels/artifacts.ts";
import type { Authorization, Calendar, Commitment, Id, Schedule } from "../core/types.ts";
import type { Store } from "../store/repos.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { CommitmentService } from "../care/commitments.ts";
import type { AttentionService } from "../inbox/attention.ts";
import type { ModelClient } from "../model/types.ts";

/**
 * Timers. One tick does five things, each idempotent by dedup key:
 *  1. fire due schedules (after re-checking the premise),
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
    private opts: { heartbeatEveryMs?: number; onError?: (source: string, e: unknown) => void } = {},
  ) {}

  private fail(source: string, e: unknown) {
    if (this.opts.onError) this.opts.onError(source, e);
    else console.error(`${source}:`, (e as Error).message);
  }

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
      watch?: Schedule["watch"];
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
      watch: input.watch,
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

  async tick(): Promise<{ fired: number; nudged: number; expired: number; heartbeats: number; edited: number }> {
    const now = this.clock.now();
    const out = { fired: 0, nudged: 0, expired: 0, heartbeats: 0, edited: 0 };

    // Each item on its own: one bad firing must not skip the rest of the tick.
    // A paused agent's work stays due and fires once it is back on.
    const paused = (agentId: Id) => !!this.store.getAgent(agentId)?.paused;
    for (const s of this.store.dueSchedules(now)) {
      if (paused(s.agentId)) continue;
      try {
        await this.fire(s, now);
        out.fired += 1;
      } catch (e) {
        this.fail(`schedule ${s.id}`, e);
      }
    }

    // Page edits become events, at most one run per page per burst: the diff since the
    // assistant last looked names the claims, and the run decides what is a commitment
    // (multiplayer-spec §10.3: "Sam claimed: bring the stove" is a responsibility).
    for (const id of JSON.parse(this.store.getKv("artedit:pending") ?? "[]") as string[]) {
      const n = Number(this.store.getKv(`artedit:${id}`) ?? 0);
      const seenN = Number(this.store.getKv(`artedit:seen:${id}`) ?? 0);
      const latest = JSON.parse(this.store.getKv(`artedit:${id}:${n}`) ?? "null") as { state: DocState } | null;
      const seen = JSON.parse(this.store.getKv(`artedit:${id}:${seenN}`) ?? "null") as { state: DocState } | null;
      const art = this.store.getArtifact(id);
      // Ticks and additions post nothing (multiplayer-spec §10.3), so only a change in who brings what costs a run.
      const diff = n === seenN || !art?.roomId || !this.store.getRoom(art.roomId) ? "" : pageDiff(seen?.state, latest?.state, { claimsOnly: true });
      const done = () => {
        this.store.setKv(`artedit:seen:${id}`, String(n));
        for (let i = seenN; i < n; i++) this.store.deleteKv(`artedit:${id}:${i}`); // keep only the newest snapshot
        this.store.setKv("artedit:pending", JSON.stringify((JSON.parse(this.store.getKv("artedit:pending") ?? "[]") as string[]).filter((x) => x !== id)));
      };
      if (!diff || !art?.roomId) {
        done();
        continue;
      }
      try {
        await this.runtime.handleEvent({
          roomId: art.roomId,
          source: "artifact_edit",
          dedupKey: `art:${id}:${n}`,
          summary: `The page "${art.title}" changed: ${diff}. Each claim a person made for themselves is a responsibility: read_page the page, then track_commitment with them as owner for claims not already in the ledger (put the page item in the detail). When someone put another member down, ask that member privately to confirm first (ask_person) and track it only on their yes. Ticks and additions need nothing.`,
        });
        out.edited += 1;
        done();
      } catch (e) {
        this.fail(`artifact edit ${id}`, e);
      }
    }

    for (const c of this.commitments.takeDueNudges(now, (c) => paused(c.agentId))) {
      try {
        await this.nudge(c, now, out);
      } catch (e) {
        this.fail(`nudge ${c.id}`, e);
      }
    }

    out.expired = this.attention.expireDue(now).length;

    const every = this.opts.heartbeatEveryMs ?? DAY;
    for (const room of this.store.listRooms()) {
      if (paused(room.agentId)) continue;
      const last = Number(this.store.getKv(`heartbeat:${room.id}`) ?? 0);
      if (now - last < every) continue;
      const open = this.commitments.open(room.id);
      const schedules = this.store.listSchedules({ roomId: room.id }).filter((s) => !s.paused);
      this.store.setKv(`heartbeat:${room.id}`, String(now));
      if (!open.length && !schedules.length) continue;
      try {
        await this.runtime.startSystemRun({
          roomId: room.id,
          trigger: "heartbeat",
          source: "heartbeat",
          dedupKey: `heartbeat:${room.id}:${Math.floor(now / every)}`,
          text: "Heartbeat check-in. Look at the ledger, the schedules and the tasks. Responsibilities are nudged automatically and schedules fire on their own: never reschedule, cancel or add a reminder for them here. Only speak if something changed, slipped, or needs a person; otherwise call stay_quiet.",
        });
        out.heartbeats += 1;
      } catch (e) {
        this.fail(`heartbeat ${room.id}`, e);
      }
    }
    return out;
  }

  private async nudge(c: Commitment, _now: number, out: { nudged: number }) {
    {
      const owner = this.store.getPerson(c.ownerId);
      const ben = c.beneficiaryId ? this.store.getPerson(c.beneficiaryId) : undefined;
      if (c.status === "blocked") {
        // Nudging stopped working: the owner must decide.
        const room = this.store.getRoom(c.roomId);
        const agent = room ? this.store.getAgent(room.agentId) : undefined;
        if (room && agent) {
          const assignee = agent.ownerId;
          const already = this.store.listAttention({ roomId: room.id, status: ["open"] }).some((a) => a.title === `"${c.title}" is stuck`);
          if (!already) {
            this.attention.open({
              agentId: agent.id,
              roomId: room.id,
              assigneeId: assignee,
              kind: "decision",
              title: `"${c.title}" is stuck`,
              detail: `${owner?.displayName ?? "The owner"} has not confirmed it after ${c.nudges} reminders${c.dueAt ? ` and it was due ${new Date(c.dueAt).toISOString().slice(0, 10)}` : ""}. Reassign it, drop it, or say what should happen.`,
              options: ["Reassign to me", "Drop it", "Keep nudging"],
              ttlMs: 7 * 24 * 60 * 60 * 1000,
            });
            out.nudged += 1;
          }
        }
        return;
      }
      await this.runtime.startSystemRun({
        roomId: c.roomId,
        trigger: "follow_up",
        source: "commitment_nudge",
        dedupKey: `nudge:${c.id}:${c.nudges}`,
        text: `Follow-up on responsibility [${c.id}] "${c.title}"${ben ? ` for ${ben.displayName}` : ""}, owned by ${owner?.displayName ?? (c.ownerId === c.agentId ? "you" : c.ownerId)}${c.dueAt ? `, due ${new Date(c.dueAt).toISOString()}` : ""}. Status: ${c.status}, nudges so far: ${c.nudges}. If you own it, do it or report what blocks it. If a person owns it, check in with them privately in one line with ask_person (multiplayer-spec §10.1: a nudge goes to the member's own chat, not the group; only a guest, who has no private chat with you, gets one line in the group naming them), and update the ledger from their answer.`,
      });
      out.nudged += 1;
    }
  }

  private async fire(s: Schedule, now: number) {
    s.numRuns += 1;
    s.lastRunAt = now;
    s.nextRunAt = s.calendar ? computeNext(s, now) : undefined;
    this.store.putSchedule(s);

    // A watch is an alert rule: the run checks the condition itself and stays quiet unless it holds.
    if (s.watch) {
      if (s.watch.until !== undefined && now > s.watch.until) {
        s.paused = true;
        this.store.putSchedule(s);
        return;
      }
      // A previous check is still running or waiting on someone: do not stack another.
      if (this.store.listRuns({ roomId: s.roomId, status: ["running", "waiting"], limit: 50 }).some((r) => r.scheduleId === s.id)) return;
      const run = await this.runtime.startSystemRun({
        roomId: s.roomId,
        trigger: "scheduled_action",
        source: "watch",
        dedupKey: `schedule:${s.id}:${s.numRuns}`,
        text: `Watch "${s.title}" (check ${s.numRuns}). ${s.prompt}\nAuthorisation: disclosed outreach: ${s.authorization.disclosedOutreach.map((d) => `${d.who} by ${d.how} (${d.why})`).join("; ") || "none"}. Anyone not named needs a fresh yes.`,
        scheduleId: s.id,
      });
      if (run && run.status === "done" && !run.quiet) {
        const fresh = this.store.getSchedule(s.id);
        if (fresh) {
          fresh.paused = true;
          this.store.putSchedule(fresh);
        }
      }
      return;
    }

    const premiseCheck = await this.checkPremise(s);
    const runText = premiseCheck.holds
      ? `Scheduled action "${s.title}" fired. Your instructions when you scheduled it:\n${s.prompt}\n\nAuthorisation: basis ${s.authorization.basis}. Disclosed outreach: ${s.authorization.disclosedOutreach.map((d) => `${d.who} by ${d.how} (${d.why})`).join("; ") || "none"}. Anyone not named needs a fresh yes.\nPremise: "${s.authorization.premise}". Premise check: ${premiseCheck.note}\nBefore contacting anyone, verify the premise against the ledger, recent messages and your notes. If it no longer holds, say what you found instead.`
      : `Scheduled action "${s.title}" fired, but its premise ("${s.authorization.premise}") no longer seems to hold: ${premiseCheck.note}. Do not act on it. Tell the room what you found in one line, and pause or delete the schedule if it is done (it is paused for you now).`;
    if (!premiseCheck.holds) {
      s.paused = true;
      this.store.putSchedule(s);
    }
    await this.runtime.startSystemRun({
      roomId: s.roomId,
      trigger: "scheduled_action",
      source: "scheduled_action",
      dedupKey: `schedule:${s.id}:${s.numRuns}`,
      text: runText,
      scheduleId: s.id,
    });
  }

  /** Cheap model check of the premise against what the ledger and room say. Fails open (holds) when the model is silent. */
  private async checkPremise(s: Schedule): Promise<{ holds: boolean; note: string }> {
    const ledger =
      this.commitments
        .open(s.roomId)
        .map((c) => `- ${c.title} [${c.status}]`)
        .join("\n") || "(empty)";
    const recent = this.store
      .messagesForRoom(s.roomId, 15)
      .map((m) => `${m.role}: ${m.text.slice(0, 200)}`)
      .join("\n");
    let raw = "";
    try {
      raw = await this.model.complete({
        system: 'Answer with JSON only: {"holds": true|false, "note": "<one sentence>"}. "holds" is false only when the evidence clearly shows the premise is no longer true.',
        prompt: `Premise: ${s.authorization.premise}\nLedger:\n${ledger}\nRecent messages:\n${recent}`,
        effort: "low",
        maxTokens: 300,
      });
    } catch (e) {
      console.warn(`premise check for ${s.id} failed open:`, (e as Error).message);
      return { holds: true, note: "not verified (model unavailable); verify before acting" };
    }
    try {
      const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      if (typeof j.holds === "boolean") return { holds: j.holds, note: String(j.note ?? "") };
    } catch {
      console.warn(`premise check for ${s.id} returned no JSON; failing open`);
    }
    return { holds: true, note: "not verified automatically; verify before acting" };
  }
}

/** The human-readable delta between two page snapshots; empty when nothing a person did changed. */
export function pageDiff(seen: DocState | null | undefined, latest: DocState | null | undefined, opts: { claimsOnly?: boolean } = {}): string {
  if (!latest) return "";
  const parts: string[] = [];
  const claimed = latest.claimed ?? {};
  const seenClaimed = seen?.claimed ?? {};
  for (const [k, who] of Object.entries(claimed)) {
    if (seenClaimed[k] === who) continue;
    const by = latest.claimedBy?.[k];
    parts.push(by && by !== who ? `${by} put ${who} down for "${k}" (${who} has not confirmed)` : `${who} claimed "${k}"`);
  }
  for (const k of Object.keys(seenClaimed)) if (!(k in claimed)) parts.push(`the claim on "${k}" was dropped`);
  if (opts.claimsOnly) return parts.join("; ");
  const checked = latest.checked ?? {};
  const seenChecked = seen?.checked ?? {};
  for (const [k, who] of Object.entries(checked)) if (seenChecked[k] !== who) parts.push(`${who} ticked "${k}"`);
  const added = Object.values(latest.added ?? {}).flat().length;
  const seenAdded = Object.values(seen?.added ?? {}).flat().length;
  if (added > seenAdded) parts.push(`${added - seenAdded} item(s) were added to the page`);
  return parts.join("; ");
}

export function computeNext(s: Schedule, now: number): number | undefined {
  if (s.runAt !== undefined) return s.numRuns === 0 ? s.runAt : undefined;
  const c = s.calendar;
  if (!c) return undefined;
  if (c.everyHours) return (s.lastRunAt ?? now) + c.everyHours * HOUR;
  if (c.everyDays) {
    const base = s.lastRunAt ?? now;
    return nextOccurrence(base + (c.everyDays - 1) * DAY, c.timeZone, c.hour ?? 9, c.minute ?? 0);
  }
  if (c.hour === undefined) return now + HOUR;
  return nextOccurrence(now, c.timeZone, c.hour, c.minute ?? 0, c.dayOfWeek);
}
