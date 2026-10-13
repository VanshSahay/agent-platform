// Internal skills: markdown procedures in skills/ (Agent Skills format: frontmatter name + description, then the body).
// Users never see or choose them; the agent reads one when a task matches its description.
import { readdirSync } from "node:fs";

const dir = new URL("../skills/", import.meta.url).pathname;
export interface Skill { name: string; description: string; body: string }

export async function listSkills(): Promise<Skill[]> {
  const out: Skill[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const text = await Bun.file(dir + f).text();
    const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const fm = Object.fromEntries((m?.[1] ?? "").split("\n").map((l) => l.split(/:\s*/)).filter((p) => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join(": ").trim()]));
    out.push({ name: fm.name ?? f.replace(/\.md$/, ""), description: fm.description ?? "", body: (m?.[2] ?? text).trim() });
  }
  return out;
}
export const readSkill = async (name: string) => (await listSkills()).find((s) => s.name === name)?.body ?? null;
