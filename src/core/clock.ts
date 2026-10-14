/** Injectable clock so tests and the scheduler can move time deterministically. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
    return this.t;
  }
  /** Same as advance; reads better in harnesses that step between turns. */
  tick(ms: number) {
    return this.advance(ms);
  }
  set(t: number) {
    this.t = t;
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Hour of day (0-23) in a zone. */
export function hourIn(zone: string, at: number): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hour12: false }).format(new Date(at));
  const h = Number.parseInt(s, 10);
  return Number.isFinite(h) ? h % 24 : new Date(at).getUTCHours();
}

/** Calendar day (YYYY-MM-DD) of an instant in a zone; an unknown zone falls back to UTC. */
export function dayIn(ms: number, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const y = get("year");
    const m = get("month");
    const d = get("day");
    if (y && m && d) return `${y.padStart(4, "0")}-${m}-${d}`;
  } catch {
    // fall through to UTC
  }
  return new Date(ms).toISOString().slice(0, 10);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Next instant at hour:minute in zone strictly after `after`. Day-of-week filter optional. */
export function nextOccurrence(after: number, zone: string, hour: number, minute: number, daysOfWeek?: number[]): number {
  // Walk forward minute by minute until the local wall clock matches; cheap and zone-correct.
  // One formatter for the whole walk: building one per step was most of the cost.
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "numeric", weekday: "short", hour12: false });
  let t = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  for (let i = 0; i < 8 * 24 * 60; i++, t += MINUTE) {
    const parts = fmt.formatToParts(new Date(t));
    const h = Number(parts.find((p) => p.type === "hour")?.value) % 24;
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    const wd = WEEKDAYS.indexOf(parts.find((p) => p.type === "weekday")?.value ?? "");
    if (h === hour && m === minute && (!daysOfWeek?.length || daysOfWeek.includes(wd))) return t;
  }
  return after + DAY;
}

export function fmtWhen(at: number, zone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
}
