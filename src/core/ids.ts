import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Short, sortable-enough ids: 9 base-36 ms timestamp chars + 10 random. */
export function newId(prefix: string): string {
  const t = Date.now().toString(36).padStart(9, "0");
  const r = randomBytes(10);
  let s = "";
  for (let i = 0; i < 10; i++) s += ALPHABET[r[i]! % ALPHABET.length];
  return `${prefix}_${t}${s}`;
}

export function sha256(parts: unknown[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(typeof p === "string" ? p : JSON.stringify(p ?? null));
  return h.digest("hex");
}
