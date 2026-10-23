// What running Circle has cost, for the operator at a terminal: `bun run spend` here, `bun run spend:prod` on Fly.
// Reads the SQLite file directly; nothing in the product shows this.
import { Database } from "bun:sqlite";
import { daysAgoIso, spendSummary, startOfDayIso } from "./runtime/spend.ts";

import { existsSync } from "node:fs";

const path = process.env.DB_PATH ?? ["data/circle.sqlite", "data/local.sqlite"].find(existsSync);
if (!path || !existsSync(path)) {
  console.log("No database yet; nothing spent.");
  process.exit(0);
}
const db = new Database(path, { readonly: true });
if (!db.query("SELECT name FROM sqlite_master WHERE name = 'spend'").get()) {
  console.log("No spend table yet (the app creates it on start); nothing recorded.");
  process.exit(0);
}
const fly = Number(process.env.FLY_USD_PER_MONTH ?? 0) || 0;
const usd = (n: number) => `$${n.toFixed(4)}`;
for (const [label, since] of [
  ["Today", startOfDayIso()],
  ["7 days", daysAgoIso(7)],
  ["30 days", daysAgoIso(30)],
] as const) {
  const s = spendSummary(db, { since, flyUsdPerMonth: fly });
  const parts = Object.entries(s.byProvider).map(([p, v]) => `${p} ${usd(v.usd)} (${v.count})`);
  console.log(`${label.padEnd(8)} ${usd(s.totalUsd).padStart(10)}  ${parts.join(" · ") || "nothing recorded"}`);
}
const week = spendSummary(db, { since: daysAgoIso(7), flyUsdPerMonth: fly });
if (week.byRun.length) {
  console.log("\nDearest runs this week:");
  for (const r of week.byRun.slice(0, 10))
    console.log(
      `  ${usd(r.usd).padStart(9)}  ${r.runId}  ${Object.entries(r.byProvider)
        .map(([p, v]) => `${p} ${usd(v)}`)
        .join(", ")}`,
    );
}
