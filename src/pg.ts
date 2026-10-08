// Postgres behind the same synchronous one/all/exec API the app uses with SQLite.
// A worker thread runs each query on one connection while the caller waits (Atomics.wait), so ~640 call sites keep working
// unchanged and transactions are naturally serialized. ~0.3ms per query locally.
// ponytail: one connection, blocking the event loop like bun:sqlite did; move hot paths to an async pool when load needs it.
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";

let worker: Worker | null = null;
export function connect(url: string) {
  if (worker) return;
  worker = new Worker(new URL("./pg-worker.mjs", import.meta.url), { workerData: { url } });
  worker.unref();
}
export function close() { worker?.terminate(); worker = null; }

/** Run raw Postgres SQL synchronously. */
export function query(sql: string, params: any[] = []): { rows: any[]; count: number } {
  if (!worker) throw new Error("Postgres not connected");
  const flag = new SharedArrayBuffer(4), f = new Int32Array(flag), { port1, port2 } = new MessageChannel();
  // SQLite habits: undefined binds as null, booleans as 0/1.
  const p = params.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
  worker.postMessage({ q: sql, params: p, port: port2, flag }, [port2]);
  if (Atomics.wait(f, 0, 0, Number(process.env.PG_QUERY_TIMEOUT_MS ?? 30_000)) === "timed-out") { port1.close(); throw new Error(`Postgres query timed out: ${sql.slice(0, 80)}`); }
  const m = receiveMessageOnPort(port1)?.message; port1.close();
  if (!m) throw new Error("Postgres worker returned nothing");
  if (m.error) throw Object.assign(new Error(`${m.error} — in: ${sql.slice(0, 160)}`), { code: m.code });
  return m;
}

// ---------------- SQLite → Postgres translation (only the subset this codebase uses) ----------------
// Tables whose `insert or replace` needs an explicit conflict target.
const UPSERT_KEYS: Record<string, { pk: string[]; cols?: string[] }> = {
  external_identities: { pk: ["platform", "external_user_id"] },
  provider_keys: { pk: ["workspace_id", "provider"], cols: ["workspace_id", "provider", "key_enc"] },
};

/** Translate one statement. Pure string work, cached by text. */
const cache = new Map<string, string>();
export function translate(sql: string): string {
  const hit = cache.get(sql); if (hit) return hit;
  let s = sql;
  const replace = s.match(/^\s*insert or replace into (\w+)\s*(\(([^)]*)\))?/i);
  if (replace) {
    const t = UPSERT_KEYS[replace[1]]; if (!t) throw new Error(`no upsert key for ${replace[1]}`);
    const cols = replace[3] ? replace[3].split(",").map((c) => c.trim()) : t.cols!;
    s = s.replace(/insert or replace into/i, "insert into") + ` on conflict (${t.pk.join(", ")}) do update set ${cols.filter((c) => !t.pk.includes(c)).map((c) => `${c}=excluded.${c}`).join(", ")}`;
  }
  if (/^\s*insert or ignore into/i.test(s)) s = s.replace(/insert or ignore into/i, "insert into") + " on conflict do nothing";
  // json_extract(x, '$.a.b') → text value at that path
  s = s.replace(/json_extract\(\s*([\w.]+)\s*,\s*'\$\.([\w.]+)'\s*\)/gi, (_m, col, path) => `(${col}::jsonb #>> '{${path.split(".").join(",")}}')`);
  // json_extract(x, '$[0]') → first array element as text
  s = s.replace(/json_extract\(\s*([\w.]+)\s*,\s*'\$\[(\d+)\]'\s*\)/gi, (_m, col, i) => `(${col}::jsonb #>> '{${i}}')`);
  s = s.replace(/json_array_length\(/gi, "jsonb_array_length(").replace(/jsonb_array_length\((\([^()]*\))\)/gi, "jsonb_array_length(($1)::jsonb)");
  s = rewriteCalls(s, "round", (args) => args.length === 2 ? `round((${args[0]})::numeric, ${args[1]})` : null); // Postgres rounds only exact decimals
  s = rewriteCalls(s, "max", (args) => args.length > 1 ? `greatest(${args.join(", ")})` : null); // SQLite's 2-arg max/min are scalar
  s = rewriteCalls(s, "min", (args) => args.length > 1 ? `least(${args.join(", ")})` : null);
  s = s.replace(/\bchar\(/gi, "chr(");
  s = s.replace(/\s+like\s+/gi, " ilike "); // SQLite LIKE is case-insensitive for ASCII
  // ? placeholders → $1..$n, skipping quoted literals
  let n = 0, out = "", q: string | null = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; out += ch; }
    else if (ch === "'" || ch === '"') { q = ch; out += ch; }
    else if (ch === "?") out += `$${++n}`;
    else out += ch;
  }
  cache.set(sql, out);
  return out;
}

/** Rewrite name(args…) calls with balanced parentheses; `fn` returns null to keep a call as is. */
function rewriteCalls(sql: string, name: string, fn: (args: string[]) => string | null): string {
  const re = new RegExp(`\\b${name}\\(`, "gi");
  let out = "", i = 0, m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    let depth = 1, j = m.index + m[0].length, start = j; const args: string[] = [];
    for (; j < sql.length && depth; j++) {
      const c = sql[j];
      if (c === "(") depth++; else if (c === ")") { if (--depth === 0) break; }
      else if (c === "," && depth === 1) { args.push(sql.slice(start, j).trim()); start = j + 1; }
    }
    args.push(sql.slice(start, j).trim());
    const inner = args.map((a) => rewriteCalls(a, name, fn)), rep = fn(inner);
    out += sql.slice(i, m.index) + (rep ?? `${m[0]}${inner.join(", ")})`);
    i = j + 1; re.lastIndex = i;
  }
  return out + sql.slice(i);
}

/** Translate the SQLite schema DDL to Postgres types. */
export function translateDdl(ddl: string): string {
  return ddl
    .replace(/create virtual table[^;]*;/gi, "") // FTS5 → a GIN index on memories (see below)
    .replace(/integer primary key autoincrement/gi, "bigserial primary key")
    .replace(/\binteger\b/gi, "bigint").replace(/\bint\b/gi, "bigint")
    .replace(/\breal\b/gi, "double precision").replace(/\bblob\b/gi, "bytea")
    + "\ncreate index if not exists memories_text_search on memories using gin (to_tsvector('simple', text));";
}
