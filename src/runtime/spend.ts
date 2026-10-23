import type { Database } from "bun:sqlite";

/**
 * What a run costs, by provider. Each hook records the cheapest honest figure its
 * provider gives back; the summary adds them up per provider and per run. Hosting has
 * no per-run figure, so it appears as a flat monthly line prorated over the window.
 */
export type SpendProvider = "openrouter" | "apify" | "browserbase" | "liteapi" | "fly";

export interface SpendEntry {
  provider: SpendProvider;
  usd: number;
  /** Human units, e.g. "1200 in / 300 out tokens", "apify run abc 0.21 CU", "browserbase 42 s". */
  units: string;
  runId?: string;
  sessionId?: string;
  note?: string;
  /** ISO time; defaults to now. */
  at?: string;
}

export interface SpendSummary {
  since: string;
  until: string;
  totalUsd: number;
  byProvider: Record<string, { usd: number; count: number }>;
  byRun: { runId: string; usd: number; byProvider: Record<string, number> }[];
  /** FLY_USD_PER_MONTH spread over the window; zero when unset. */
  hostingUsd: number;
}

const DAY_MS = 24 * 3600 * 1000;
const MONTH_DAYS = 30.4375; // 365.25 / 12, so a month's line prorates the same whatever the calendar month

export function recordSpend(db: Database, e: SpendEntry): void {
  db.run("INSERT INTO spend(at, provider, usd, units, run_id, session_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    e.at ?? new Date().toISOString(),
    e.provider,
    Number.isFinite(e.usd) ? e.usd : 0,
    e.units,
    e.runId ?? null,
    e.sessionId ?? null,
    e.note ?? null,
  ]);
}

export function spendSummary(db: Database, opts: { since: string; until?: string; flyUsdPerMonth?: number }): SpendSummary {
  const until = opts.until ?? new Date().toISOString();
  const rows = db.query("SELECT provider, usd, run_id FROM spend WHERE at >= ? AND at <= ? ORDER BY at").all(opts.since, until) as {
    provider: string;
    usd: number;
    run_id: string | null;
  }[];
  const byProvider: SpendSummary["byProvider"] = {};
  const runs = new Map<string, { usd: number; byProvider: Record<string, number> }>();
  let total = 0;
  for (const r of rows) {
    total += r.usd;
    const p = byProvider[r.provider] ?? { usd: 0, count: 0 };
    byProvider[r.provider] = p;
    p.usd += r.usd;
    p.count++;
    if (r.run_id) {
      const run = runs.get(r.run_id) ?? { usd: 0, byProvider: {} };
      run.usd += r.usd;
      run.byProvider[r.provider] = (run.byProvider[r.provider] ?? 0) + r.usd;
      runs.set(r.run_id, run);
    }
  }
  const windowMs = Math.max(0, Date.parse(until) - Date.parse(opts.since));
  const hostingUsd = round((opts.flyUsdPerMonth ?? 0) * (windowMs / (MONTH_DAYS * DAY_MS)));
  if (hostingUsd > 0) byProvider.fly = { usd: hostingUsd, count: 0 };
  for (const p of Object.values(byProvider)) p.usd = round(p.usd);
  return {
    since: opts.since,
    until,
    totalUsd: round(total + hostingUsd),
    byProvider,
    byRun: [...runs.entries()].map(([runId, r]) => ({ runId, usd: round(r.usd), byProvider: r.byProvider })).sort((a, b) => b.usd - a.usd),
    hostingUsd,
  };
}

/** Start of today (UTC) as ISO: the default window for "what did we spend today". */
export const startOfDayIso = (now = Date.now()) => new Date(Math.floor(now / DAY_MS) * DAY_MS).toISOString();
export const daysAgoIso = (days: number, now = Date.now()) => new Date(now - days * DAY_MS).toISOString();

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * The sink the hooks write to. Hands and the model are built before the database opens, so
 * the log starts detached and keeps entries until `attach`; after that every record is a row.
 */
export class SpendLog {
  private pending: SpendEntry[] = [];
  constructor(private db?: Database) {}
  attach(db: Database) {
    this.db = db;
    for (const e of this.pending.splice(0)) recordSpend(db, e);
  }
  record(e: SpendEntry) {
    const entry = { ...e, at: e.at ?? new Date().toISOString() };
    if (this.db) recordSpend(this.db, entry);
    else this.pending.push(entry);
  }
}
