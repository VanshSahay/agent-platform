import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock, type Clock } from "./core/clock.ts";
import type { Delivery } from "./runtime/runtime.ts";
import { openDb } from "./store/db.ts";
import { Store } from "./store/repos.ts";
import { MemoryService } from "./memory/memory.ts";
import { Consolidator } from "./memory/consolidate.ts";
import { TaskService } from "./tasks/tasks.ts";
import { Vault } from "./tools/vault.ts";
import { RoomService } from "./rooms/rooms.ts";
import { AttentionService } from "./inbox/attention.ts";
import { CommitmentService } from "./care/commitments.ts";
import { Planner } from "./planning/planner.ts";
import { Runtime } from "./runtime/runtime.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import { loadSkills } from "./skills/skills.ts";
import { Ops } from "./ops/ops.ts";
import type { Skill } from "./skills/skills.ts";
import type { ModelClient } from "./model/types.ts";
import { fakeHands, type Hands } from "./tools/hands.ts";

export interface App {
  store: Store;
  clock: Clock;
  model: ModelClient;
  memory: MemoryService;
  consolidator: Consolidator;
  rooms: RoomService;
  attention: AttentionService;
  commitments: CommitmentService;
  planner: Planner;
  runtime: Runtime;
  scheduler: Scheduler;
  hands: Hands;
  tasks: TaskService;
  vault: Vault;
  skills: Skill[];
  ops: Ops;
  /** Subscribe to outbound deliveries (channel adapters, UI streams, tests). */
  onDeliver(fn: (d: Delivery) => void): () => void;
}

/** Compose the product. Everything is injectable so tests run offline. */
export function createApp(opts: {
  dbPath?: string;
  clock?: Clock;
  model: ModelClient;
  hands?: Hands;
  skillsDir?: string;
  heartbeatEveryMs?: number;
  maxTurns?: number;
  compactAfter?: number;
  masterKey?: string;
  publicUrl?: string;
  /** Boot-level providers wired on this server. Default: every hand (tests and offline runs; the fakes are all "wired"). */
  providers?: string[];
}): App {
  const clock = opts.clock ?? systemClock;
  const store = new Store(openDb(opts.dbPath ?? ":memory:"));
  const memory = new MemoryService(store, clock);
  const rooms = new RoomService(store, clock);
  const attention = new AttentionService(store, clock);
  const commitments = new CommitmentService(store, clock);
  const planner = new Planner(store, clock);
  const hands = opts.hands ?? fakeHands();
  const here = dirname(fileURLToPath(import.meta.url));
  const skills = loadSkills(opts.skillsDir ?? join(here, "..", "skills"));
  const listeners = new Set<(d: Delivery) => void>();
  const deliver = (d: Delivery) => {
    for (const l of listeners) l(d);
  };
  const tasks = new TaskService(store, clock);
  const ops = new Ops(store, clock);
  const onError = (source: string, e: unknown) => ops.error(source, e);
  const vault = new Vault(store, clock, opts.masterKey ?? "dev-only-master-key");
  const runtime = new Runtime({
    store,
    clock,
    model: opts.model,
    memory,
    rooms,
    attention,
    commitments,
    planner,
    hands,
    skills,
    tasks,
    vault,
    deliver,
    maxTurns: opts.maxTurns,
    compactAfter: opts.compactAfter,
    publicUrl: opts.publicUrl,
    onError,
    providers: new Set(opts.providers ?? ["google", "email", "slack", "speech", "images", "payments", "phone", "browser", "hotels", "flights", "community"]),
  });
  const scheduler = new Scheduler(store, clock, runtime, commitments, attention, opts.model, { heartbeatEveryMs: opts.heartbeatEveryMs, onError });
  const consolidator = new Consolidator(store, clock, opts.model, memory);
  return {
    store,
    clock,
    model: opts.model,
    memory,
    consolidator,
    rooms,
    attention,
    commitments,
    planner,
    runtime,
    scheduler,
    hands,
    tasks,
    vault,
    skills,
    ops,
    onDeliver(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
