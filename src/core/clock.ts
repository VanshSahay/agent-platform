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

/** Next instant at hour:minute in zone strictly after `after`. Day-of-week filter optional. */
export function nextOccurrence(
  after: number,
  zone: string,
  hour: number,
  minute: number,
  daysOfWeek?: number[],
): number {
  // Walk forward in 15-minute steps until the local wall clock matches; cheap and zone-correct.
  let t = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  for (let i = 0; i < 8 * 24 * 60; i++, t += MINUTE) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hour12: false,
    }).formatToParts(new Date(t));
    const h = Number(parts.find((p) => p.type === "hour")?.value) % 24;
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")?.value ?? "");
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
