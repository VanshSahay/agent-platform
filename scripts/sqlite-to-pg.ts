// Copy an existing SQLite database into Postgres (one-off, when moving a deployment to Postgres + Temporal):
//   DATABASE_URL=postgres://… bun scripts/sqlite-to-pg.ts data.sqlite [--force]
// Refuses to write into a Postgres database that already has users unless --force.
import { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import * as pg from "../src/pg";

const [file, flag] = process.argv.slice(2);
if (!file || !process.env.DATABASE_URL) throw new Error("usage: DATABASE_URL=postgres://… bun scripts/sqlite-to-pg.ts <file.sqlite> [--force]");
const src = new Database(file, { readonly: true });
openDb(); // creates/migrates the Postgres schema
if (pg.query("select count(*) n from users").rows[0].n > 0 && flag !== "--force") throw new Error("target Postgres already has users; pass --force to copy anyway");

const pgCols = (t: string) => new Set(pg.query("select column_name c from information_schema.columns where table_name=$1", [t]).rows.map((r) => r.c));
const tables = (src.query("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like 'memories_fts%'").all() as any[]).map((r) => r.name);
for (const t of tables) {
  const cols = pgCols(t); if (!cols.size) { console.log(`skip ${t} (not in Postgres schema)`); continue; }
  const rows = src.query(`select * from ${t}`).all() as any[];
  if (!rows.length) continue;
  const keep = Object.keys(rows[0]).filter((c) => cols.has(c));
  pg.query("begin");
  for (let i = 0; i < rows.length; i += 200) { // batched multi-row inserts
    const batch = rows.slice(i, i + 200), params: any[] = [];
    const values = batch.map((r) => `(${keep.map((c) => { params.push(r[c] instanceof Uint8Array ? Buffer.from(r[c]) : r[c]); return `$${params.length}`; }).join(",")})`);
    pg.query(`insert into ${t} (${keep.join(",")}) values ${values.join(",")} on conflict do nothing`, params);
  }
  pg.query("commit");
  console.log(`${t}: ${rows.length}`);
}
// Serial columns copied with explicit values: move their sequences past the copied ids.
for (const r of pg.query(`select table_name t, column_name c from information_schema.columns where column_default like 'nextval%' and table_schema=current_schema()`).rows)
  pg.query(`select setval(pg_get_serial_sequence('${r.t}', '${r.c}'), coalesce((select max(${r.c}) from ${r.t}), 0) + 1, false)`);
console.log("done");
process.exit(0);
