// bun run criteria — maps every acceptance criterion in ACCEPTANCE.md to evidence and fails if any is unmet.
import { readFileSync, mkdirSync } from "node:fs";

const ids = [...readFileSync("ACCEPTANCE.md", "utf8").matchAll(/^\| (AC-[A-Z0-9]+) \| (.+?) \|/gm)].map((m) => ({ id: m[1], text: m[2] }));
mkdirSync("reports", { recursive: true });
const sh = (cmd: string[]) => { const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }); return { ok: p.exitCode === 0, out: p.stdout.toString() + p.stderr.toString() }; };

const testRun = sh(["bun", "test", "--reporter=junit", "--reporter-outfile=reports/junit.xml"]);
const xml = readFileSync("reports/junit.xml", "utf8");
const cases = [...xml.matchAll(/<testcase name="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)].map((m) => ({ name: m[1], failed: /<failure|<error/.test(m[3] ?? "") }));
const gates: Record<string, { ok: boolean; out: string }> = {
  "AC-Q1": sh(["bunx", "tsc", "--noEmit", "-p", "."]),
  "AC-UI1": sh(["bun", "build", "public/index.html", "--outdir", "reports/ui-build"]),
};

let bad = 0;
for (const c of ids) {
  let status: string, evidence: string;
  if (gates[c.id]) { status = gates[c.id].ok ? "pass" : "FAIL"; evidence = c.id === "AC-Q1" ? "tsc --noEmit" : "bun build public/index.html"; }
  else {
    const t = cases.filter((x) => x.name.startsWith(`${c.id} `));
    status = !t.length ? "NO TEST" : t.every((x) => !x.failed) ? "pass" : "FAIL";
    evidence = t.map((x) => x.name.slice(c.id.length + 1, 70)).join("; ") || "—";
  }
  if (status !== "pass") bad++;
  console.log(`${status === "pass" ? "✓" : "✗"} ${c.id.padEnd(8)} ${status.padEnd(7)} ${c.text.slice(0, 90)}`);
}
const orphan = cases.filter((x) => !ids.some((c) => x.name.startsWith(`${c.id} `)));
if (orphan.length) console.log(`\nTests without a criterion: ${orphan.map((o) => o.name).join(", ")}`);
console.log(`\n${ids.length - bad}/${ids.length} criteria met · ${cases.length} tests (${cases.filter((c) => c.failed).length} failed)`);
if (!testRun.ok && !bad) console.log(testRun.out.slice(-2000));
for (const [k, g] of Object.entries(gates)) if (!g.ok) console.log(`\n${k} output:\n${g.out.slice(-2000)}`);
process.exit(bad || !testRun.ok ? 1 : 0);
