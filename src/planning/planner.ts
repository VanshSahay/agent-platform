import { newId } from "../core/ids.ts";
import type { Clock } from "../core/clock.ts";
import type { ApproachKind, Id, Plan, PlanStep } from "../core/types.ts";
import type { Store } from "../store/repos.ts";

/**
 * Resourcefulness is a policy, not a prompt hope. The planner keeps one plan
 * per run; each step names an approach and the fallbacks to try when it
 * stalls. The model proposes steps through the `plan` tool; the runtime marks
 * progress from tool results; when a step fails twice, the next approach is
 * activated and the model is told so.
 *
 * Default ladder for "find someone / find out something" tasks, cheapest and
 * least intrusive first:
 *   search -> browse -> ask_room -> call -> community_post (needs a yes) -> ask_person
 */
export const DEFAULT_LADDER: ApproachKind[] = ["search", "browse", "ask_room", "call", "community_post", "ask_person"];

export const APPROACH_LABEL: Record<ApproachKind, string> = {
  search: "search the web",
  ask_room: "ask the group",
  ask_person: "ask a specific person",
  call: "call a business",
  community_post: "ask a local community (needs your OK)",
  browse: "use a website",
  wait: "wait for a reply",
};

export const MAX_ATTEMPTS_PER_STEP = 2;

export class Planner {
  constructor(
    private store: Store,
    private clock: Clock,
  ) {}

  create(runId: Id, goal: string, steps: { text: string; approach: ApproachKind; alternatives?: ApproachKind[] }[], opts: { auto?: boolean } = {}): Plan {
    const now = this.clock.now();
    const plan: Plan = {
      id: newId("plan"),
      runId,
      goal,
      auto: opts.auto || undefined,
      steps: steps.map((s, i) => ({
        id: `s${i + 1}`,
        text: s.text,
        approach: s.approach,
        status: i === 0 ? "active" : "pending",
        alternatives: s.alternatives ?? ladderAfter(s.approach),
        attempts: 0,
      })),
      cursor: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.store.putPlan(plan);
    return plan;
  }

  get(runId: Id): Plan | undefined {
    return this.store.planForRun(runId);
  }

  /** Record that the active step produced a usable result. */
  complete(runId: Id, evidence: string): Plan | undefined {
    const plan = this.get(runId);
    if (!plan) return;
    // An automatic plan has one step, "do what was asked"; a good search result does not finish it, the reply does.
    if (plan.auto) return plan;
    const step = plan.steps[plan.cursor];
    if (!step) return plan;
    step.status = "done";
    step.evidence = evidence;
    plan.cursor += 1;
    const next = plan.steps[plan.cursor];
    if (next) next.status = "active";
    plan.updatedAt = this.clock.now();
    this.store.putPlan(plan);
    return plan;
  }

  /**
   * Record that the active step's approach did not work. After
   * MAX_ATTEMPTS_PER_STEP the next alternative approach becomes the step's
   * approach; when alternatives run out the step fails and the plan moves on.
   * Returns what changed so the runtime can tell the model. This is the floor:
   * the model can rewrite the course sooner through revise().
   */
  stall(runId: Id, reason: string): { plan: Plan; switchedTo?: ApproachKind; exhausted?: boolean } | undefined {
    const plan = this.get(runId);
    if (!plan) return;
    const step = plan.steps[plan.cursor];
    if (!step) return { plan };
    step.attempts += 1;
    step.evidence = reason;
    let switchedTo: ApproachKind | undefined;
    let exhausted = false;
    if (step.attempts >= MAX_ATTEMPTS_PER_STEP) {
      const next = step.alternatives.shift();
      if (next) {
        step.approach = next;
        step.attempts = 0;
        switchedTo = next;
      } else {
        step.status = "failed";
        exhausted = true;
        plan.cursor += 1;
        const n = plan.steps[plan.cursor];
        if (n) n.status = "active";
      }
    }
    plan.updatedAt = this.clock.now();
    this.store.putPlan(plan);
    return { plan, switchedTo, exhausted };
  }

  /**
   * The model rewrites the remaining course from what it learned (the
   * revise_plan tool). Finished steps stay as history; the active step is
   * marked skipped with the reason, and the pending ones are replaced by what
   * the model now knows. Without a plan there is nothing to revise.
   */
  revise(runId: Id, evidence: string, steps: { text: string; approach: ApproachKind; alternatives?: ApproachKind[] }[]): Plan | undefined {
    const plan = this.get(runId);
    if (!plan) return undefined;
    const n = (plan.revisions ?? 0) + 1;
    const history = plan.steps.slice(0, plan.cursor);
    const active = plan.steps[plan.cursor];
    if (active) {
      active.status = "skipped";
      active.evidence = evidence;
    }
    const fresh = steps.map((s, i) => ({
      id: `r${n}s${i + 1}`,
      text: s.text,
      approach: s.approach,
      status: i === 0 ? ("active" as const) : ("pending" as const),
      alternatives: s.alternatives ?? ladderAfter(s.approach),
      attempts: 0,
    }));
    plan.steps = [...history, ...(active ? [active] : []), ...fresh];
    plan.cursor = plan.steps.indexOf(fresh[0]!);
    plan.revisions = n;
    plan.updatedAt = this.clock.now();
    this.store.putPlan(plan);
    return plan;
  }

  describe(plan: Plan): string {
    const lines = plan.steps.map((s) => {
      const mark = s.status === "done" ? "x" : s.status === "active" ? ">" : s.status === "failed" ? "!" : s.status === "skipped" ? "-" : " ";
      const alt = s.alternatives.length ? ` (then: ${s.alternatives.map((a) => APPROACH_LABEL[a]).join(", ")})` : "";
      return `[${mark}] ${s.id} ${s.text} via ${APPROACH_LABEL[s.approach]}${alt}${s.attempts ? ` attempts=${s.attempts}` : ""}`;
    });
    return `Goal: ${plan.goal}\n${lines.join("\n")}`;
  }

  activeStep(plan: Plan): PlanStep | undefined {
    return plan.steps[plan.cursor];
  }
}

function ladderAfter(a: ApproachKind): ApproachKind[] {
  const i = DEFAULT_LADDER.indexOf(a);
  return i >= 0 ? DEFAULT_LADDER.slice(i + 1) : [];
}
