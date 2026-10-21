import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Skill {
  name: string;
  when: string;
  body: string;
}

/**
 * Skills are markdown procedures. The agent gets an index (name + when) in
 * every prompt and reads the body of the ones that match the request. Users
 * never see or choose them.
 */
export function loadSkills(dir: string): Skill[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return files
    .map((f) => parseSkill(readFileSync(join(dir, f), "utf8")))
    .filter((s): s is Skill => !!s)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function parseSkill(src: string): Skill | undefined {
  const m = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return undefined;
  const front = Object.fromEntries(
    m[1]!
      .split("\n")
      .map((l) => l.split(/:\s(.*)/s))
      .filter((p) => p.length >= 2)
      .map((p) => [p[0]!.trim(), (p[1] ?? "").trim()]),
  );
  if (!front.name) return undefined;
  return { name: front.name, when: front.when ?? "", body: m[2]!.trim() };
}

/** Crude relevance: a skill matches when a few of its "when" words appear in the request or the room is a group. */
export function matchSkills(skills: Skill[], text: string, opts: { group: boolean }): Skill[] {
  const t = text.toLowerCase();
  const out: Skill[] = [];
  for (const s of skills) {
    if (s.name.startsWith("_")) continue; // core rules and other prompt parts, never matched as procedures
    if (s.when.startsWith("always")) {
      if (opts.group) out.push(s);
      continue;
    }
    const words = s.when
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const hits = words.filter((w) => t.includes(w)).length;
    if (hits >= 2) out.push(s);
  }
  return out;
}

export function skillIndex(skills: Skill[]): string {
  return skills
    .filter((s) => !s.name.startsWith("_"))
    .map((s) => `- ${s.name}: ${s.when}`)
    .join("\n");
}
