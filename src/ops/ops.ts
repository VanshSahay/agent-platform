import type { Clock } from "../core/clock.ts";
import type { Store } from "../store/repos.ts";

export type ChannelState = { state: "starting" | "up" | "down"; at: number; detail?: string };

/**
 * What an operator needs to keep the deployment alive: an error log that survives a restart,
 * a heartbeat per background loop, and the state of each chat channel. /health reads it.
 */
export class Ops {
  private beats = new Map<string, { at: number; every: number }>();
  private channels = new Map<string, ChannelState>();
  readonly bootAt: number;

  constructor(
    private store: Store,
    private clock: Clock,
  ) {
    this.bootAt = clock.now();
  }

  /** Log to stderr and to the database, with anything shaped like a secret removed first. */
  error(source: string, e: unknown) {
    const message = redact(e instanceof Error ? e.message : String(e)).slice(0, 2000);
    console.error(`${source}:`, message);
    try {
      this.store.logError(this.clock.now(), source, message);
    } catch {
      /* a full disk must not take the process down with it */
    }
  }

  /** A loop expected to run every `every` ms checks in; a missed three in a row is unhealthy. */
  beat(name: string, every: number) {
    this.beats.set(name, { at: this.clock.now(), every });
  }

  /** Register a loop before its first beat, so a loop that never ran is noticed too. */
  expect(name: string, every: number) {
    if (!this.beats.has(name)) this.beats.set(name, { at: this.clock.now(), every });
  }

  channel(name: string, state: ChannelState["state"], detail?: string) {
    this.channels.set(name, { state, at: this.clock.now(), detail: detail ? redact(detail).slice(0, 200) : undefined });
  }

  health() {
    const now = this.clock.now();
    let db = true;
    try {
      this.store.db.query("SELECT 1").get();
    } catch {
      db = false;
    }
    const loops = Object.fromEntries([...this.beats].map(([k, b]) => [k, { lastAt: b.at, ok: now - b.at <= 3 * b.every }]));
    const channels = Object.fromEntries([...this.channels].map(([k, c]) => [k, { state: c.state, since: c.at }]));
    const recentErrors = db ? this.store.listErrors({ since: now - 3600_000, limit: 1000 }).length : 0;
    // A channel that is down is reported but does not fail the check: restarting the machine will not fix the provider.
    const ok = db && Object.values(loops).every((l) => l.ok);
    return { ok, now, bootAt: this.bootAt, db, loops, channels, recentErrors };
  }
}

const SECRETS: [RegExp, string][] = [
  [/\b(sk|pk|rk)[-_](live|test|ant|or|proj)?[-_]?[A-Za-z0-9_-]{12,}/g, "[key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/(\b(key|token|secret|password|api_key|apikey|access_token|signingKey)["']?\s*[=:]\s*["']?)[^&\s,"']+/gi, "$1[redacted]"],
  [/\b(xox[abposr]-[A-Za-z0-9-]{8,})/g, "[slack-token]"],
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[long-token]"],
];

export function redact(s: string): string {
  return SECRETS.reduce((t, [re, w]) => t.replace(re, w), s);
}
