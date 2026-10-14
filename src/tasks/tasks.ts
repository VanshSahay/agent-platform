import { newId } from "../core/ids.ts";
import { fmtWhen, type Clock } from "../core/clock.ts";
import type { Id, Session, Task } from "../core/types.ts";
import type { Store } from "../store/repos.ts";

/**
 * Delegated tasks. The main agent answers the room and hands long work to a
 * task agent that runs in its own session, so the room never blocks on it.
 * The task keeps a progress line and a delivery log: a resume after a wait
 * sees what was already said and does not say it again.
 */
export class TaskService {
  constructor(
    private store: Store,
    private clock: Clock,
  ) {}

  create(input: { agentId: Id; roomId: Id; requesterId?: Id; title: string; instructions: string; createdByRunId?: Id }): Task {
    const now = this.clock.now();
    const session: Session = { id: newId("ses"), roomId: input.roomId, agentId: input.agentId, taskId: undefined, createdAt: now, lastActivityAt: now };
    const t: Task = {
      id: newId("task"),
      agentId: input.agentId,
      roomId: input.roomId,
      sessionId: session.id,
      requesterId: input.requesterId,
      title: input.title,
      instructions: input.instructions,
      status: "running",
      progress: "Not started.",
      delivered: [],
      createdByRunId: input.createdByRunId,
      createdAt: now,
      updatedAt: now,
    };
    session.taskId = t.id;
    this.store.putSession(session);
    this.store.putTask(t);
    return t;
  }

  update(id: Id, patch: Partial<Pick<Task, "status" | "progress" | "runId">>): Task | undefined {
    const t = this.store.getTask(id);
    if (!t) return undefined;
    Object.assign(t, patch, { updatedAt: this.clock.now() });
    if (t.status === "done" || t.status === "failed" || t.status === "stopped") t.endedAt = t.endedAt ?? this.clock.now();
    this.store.putTask(t);
    return t;
  }

  /** Record what the room was told, so nothing is repeated after a resume. */
  delivered(id: Id, text: string): Task | undefined {
    const t = this.store.getTask(id);
    if (!t) return undefined;
    t.delivered.push({ at: this.clock.now(), text: text.slice(0, 500) });
    t.updatedAt = this.clock.now();
    this.store.putTask(t);
    return t;
  }

  inFlight(roomId: Id): Task[] {
    return this.store.listTasks({ roomId, status: ["running", "waiting"] });
  }

  describe(roomId: Id, zone: string): string {
    const tasks = this.store.listTasks({ roomId }).slice(0, 8);
    if (!tasks.length) return "(no delegated tasks)";
    return tasks
      .map((t) => {
        const last = t.delivered.at(-1);
        return `- [${t.id}] "${t.title}" — ${t.status}; progress: ${t.progress}${last ? `; last told the room ${fmtWhen(last.at, zone)}: "${last.text.slice(0, 120)}"` : "; nothing told the room yet"}`;
      })
      .join("\n");
  }
}
