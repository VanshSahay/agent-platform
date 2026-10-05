// JEV (TypeSafe System One): fast typed yes/no judgments with a probability, ~150ms. Used for per-message gates where a
// full LLM call is overkill. Returns null when unconfigured or failing, so every caller keeps its own fallback.
// ponytail: not metered into credits (fractions of a cent per call); add a UNIT_PRICE row if volume makes it matter.
export async function noul(state: unknown, instructions: string, yes: string, no: string): Promise<number | null> {
  const key = process.env.JEV_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(`${process.env.JEV_BASE_URL ?? "https://api.typesafe.ai"}/v1/systemone`, {
      method: "POST", signal: AbortSignal.timeout(3000),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.JEV_MODEL ?? "jev-1.13.0", state, questions: { q: { type: "noul", instructions, criteria: { true: yes, false: no } } } }),
    });
    if (!r.ok) return null;
    const p = (await r.json())?.answers?.q?.noul;
    return typeof p === "number" ? p : null;
  } catch { return null; }
}
