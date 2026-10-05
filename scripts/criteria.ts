// bun run criteria — maps every acceptance criterion in ACCEPTANCE.md to evidence and fails if any is unmet.
import { readFileSync, mkdirSync } from "node:fs";

const ids = [...readFileSync("ACCEPTANCE.md", "utf8").matchAll(/^\| (AC-[A-Z0-9]+) \| (.+?) \|/gm)].map((m) => ({ id: m[1], text: m[2] }));
mkdirSync("reports", { recursive: true });
const sh = (cmd: string[], env: Record<string, string> = {}) => { const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } }); return { ok: p.exitCode === 0, out: p.stdout.toString() + p.stderr.toString() }; };
// Infra gates run only when the infra is configured; otherwise they're reported as SKIP (never silently passed).
const pgUrl = process.env.TEST_DATABASE_URL;
const skip = (why: string) => ({ ok: false, skip: why, out: "" });

const testRun = sh(["bun", "test", "--reporter=junit", "--reporter-outfile=reports/junit.xml"]);
const xml = readFileSync("reports/junit.xml", "utf8");
const cases = [...xml.matchAll(/<testcase name="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)].map((m) => ({ name: m[1], failed: /<failure|<error/.test(m[3] ?? "") }));
const gates: Record<string, { ok: boolean; out: string; skip?: string }> = {
  "AC-Q1": sh(["bunx", "tsc", "--noEmit", "-p", "."]),
  "AC-UI1": sh(["bun", "build", "public/index.html", "--outdir", "reports/ui-build"]),
  "AC-PG1": pgUrl ? sh(["bun", "test"], { DATABASE_URL: pgUrl }) : skip("set TEST_DATABASE_URL to a Postgres test database"),
  "AC-TP1": pgUrl ? sh(["bun", "run", "test:temporal"], { DATABASE_URL: pgUrl }) : skip("set TEST_DATABASE_URL and run `temporal server start-dev`"),
};

let bad = 0, skipped = 0;
for (const c of ids) {
  let status: string, evidence: string;
  if (gates[c.id]) { const g = gates[c.id]; status = g.skip ? "SKIP" : g.ok ? "pass" : "FAIL"; evidence = g.skip ?? c.id; }
  else {
    const t = cases.filter((x) => x.name.startsWith(`${c.id} `));
    status = !t.length ? "NO TEST" : t.every((x) => !x.failed) ? "pass" : "FAIL";
    evidence = t.map((x) => x.name.slice(c.id.length + 1, 70)).join("; ") || "—";
  }
  if (status === "SKIP") skipped++; else if (status !== "pass") bad++;
  console.log(`${status === "pass" ? "✓" : status === "SKIP" ? "–" : "✗"} ${c.id.padEnd(8)} ${status.padEnd(7)} ${c.text.slice(0, 90)}${status === "SKIP" ? ` (${evidence})` : ""}`);
}
const orphan = cases.filter((x) => !ids.some((c) => x.name.startsWith(`${c.id} `)));
if (orphan.length) console.log(`\nTests without a criterion: ${orphan.map((o) => o.name).join(", ")}`);
console.log(`\n${ids.length - bad - skipped}/${ids.length - skipped} criteria met${skipped ? ` · ${skipped} skipped (infra not configured)` : ""} · ${cases.length} tests (${cases.filter((c) => c.failed).length} failed)`);
if (!testRun.ok && !bad) console.log(testRun.out.slice(-2000));
for (const [k, g] of Object.entries(gates)) if (!g.ok && !g.skip) console.log(`\n${k} output:\n${g.out.slice(-2000)}`);
process.exit(bad || !testRun.ok ? 1 : 0);
