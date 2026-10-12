// Postgres through Bun's built-in client. Every call is awaited; migrations are numbered SQL files in migrations/.
import { SQL } from "bun";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { readdirSync } from "node:fs";

export const sql = new SQL(process.env.DATABASE_URL ?? "postgres://localhost:5433/agent", { max: 10 });

export async function migrate() {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at bigint not null)`;
  const done = new Set((await sql`select name from schema_migrations`).map((r: any) => r.name));
  const dir = new URL("../migrations/", import.meta.url).pathname;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    await sql.unsafe(await Bun.file(dir + f).text());
    await sql`insert into schema_migrations values (${f}, ${Date.now()})`;
  }
}

export const now = () => Date.now();
export const id = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** jsonb comes back parsed; text columns holding JSON don't. Accept both. */
export const J = (v: any, fallback: any = null): any => { if (v == null) return fallback; if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return fallback; } };
export const one = async <T = any>(rows: Promise<any[]> | any[]): Promise<T | null> => ((await rows) as any[])[0] ?? null;

// ---- credentials at rest: envelope encryption, one data key per value, master key from the environment ----
function masterKey() {
  const k = process.env.MASTER_KEY;
  if (!k) { if (process.env.NODE_ENV === "production") throw new Error("MASTER_KEY required in production"); return createHash("sha256").update("dev-only-master-key").digest(); }
  return createHash("sha256").update(k).digest();
}
const gcm = (key: Buffer, plain: Buffer) => { const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv); const enc = Buffer.concat([c.update(plain), c.final()]); return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64"); };
const ungcm = (key: Buffer, b64: string) => { const b = Buffer.from(b64, "base64"), d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]); };
export function seal(value: unknown): string {
  const dek = randomBytes(32);
  return JSON.stringify({ k: gcm(masterKey(), dek), d: gcm(dek, Buffer.from(JSON.stringify(value))) });
}
export function unseal<T = any>(sealed: string | null | undefined): T | null {
  if (!sealed) return null;
  const { k, d } = JSON.parse(sealed);
  return JSON.parse(ungcm(ungcm(masterKey(), k), d).toString());
}

// ---- time in a person's zone (reminders, "today") ----
export const PLATFORM_TZ = () => process.env.PLATFORM_TZ ?? "America/New_York";
// Postgres bigints arrive as strings: every time helper coerces.
export function zoned(ts: number | string | bigint, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" }).formatToParts(new Date(Number(ts))).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month - 1, d: +p.day, h: +p.hour, m: +p.minute, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
/** Wall-clock time in tz → epoch ms (two passes handle the offset). */
export function fromZoned(y: number, mo: number, d: number, h: number, m: number, tz: string) {
  let guess = Date.UTC(y, mo, d, h, m);
  for (let i = 0; i < 2; i++) { const z = zoned(guess, tz); guess += Date.UTC(y, mo, d, h, m) - Date.UTC(z.y, z.mo, z.d, z.h, z.m); }
  return guess;
}
export const fmtLocal = (ts: number | string | bigint, tz: string) => new Date(Number(ts)).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** Start of today (midnight) in tz: the daily caps reset here. */
export const startOfToday = (tz = PLATFORM_TZ()) => { const z = zoned(now(), tz); return fromZoned(z.y, z.mo, z.d, 0, 0, tz); };

export async function recordUsage(u: { user_id?: string | null; run_id?: string | null; kind: "model" | "browser" | "media"; qty: number; cost_usd?: number; model?: string }) {
  await sql`insert into usage (user_id, run_id, kind, qty, cost_usd, model, ts) values (${u.user_id ?? null}, ${u.run_id ?? null}, ${u.kind}, ${u.qty}, ${u.cost_usd ?? 0}, ${u.model ?? null}, ${now()})`;
}
export const spentToday = async (kind: "model" | "browser") =>
  Number((await one<any>(sql`select coalesce(sum(${kind === "model" ? sql`cost_usd` : sql`qty`}),0) v from usage where kind=${kind} and ts>=${startOfToday()}`))?.v ?? 0);
