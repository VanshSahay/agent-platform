/**
 * Reading a person's answer to a yes/no question or an option pick.
 * Negation wins: "no, I don't approve" is a no even though it contains
 * "approve". A bare option name is a pick. Anything else is not an answer.
 */
export type Decision = { kind: "yes" } | { kind: "no" } | { kind: "option"; option: string };

const NO = /^\s*(n|no|nope|nah|don't|do not|dont|decline|declined|stop|cancel|never|not)\b/i;
const NEGATED = /\b(don't|do not|dont|never|not|no way|decline|declined|cancel|stop)\b/i;
const YES = /^\s*(y|yes|yeah|yep|yup|ok|okay|sure|go ahead|go for it|approved|approve|do it|fine|please do|please|confirmed|sounds good)\b/i;

export function parseDecision(text: string, options: string[] = []): Decision | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  for (const o of options) {
    const lo = o.toLowerCase();
    if (lo === "yes" || lo === "no") continue;
    if (t === lo || t.startsWith(`${lo} `) || t.startsWith(`${lo},`) || t.startsWith(`${lo}.`)) return { kind: "option", option: o };
  }
  if (NO.test(t)) return { kind: "no" };
  if (!YES.test(t)) return undefined;
  if (NEGATED.test(t.slice(0, 40))) return { kind: "no" };
  // "ok, but first check the price" opens with a yes and is not one; a soft opener counts only on a short message.
  if (/^\s*(ok|okay|sure|fine|please)\b/.test(t) && t.split(/\s+/).length > 6) return undefined;
  return { kind: "yes" };
}

export function isYes(text: string, options: string[] = []): boolean {
  return parseDecision(text, options)?.kind === "yes";
}

/** Does this message answer the item at all (yes, no, or one of its options)? */
export function answers(text: string, options: string[] = []): boolean {
  return parseDecision(text, options) !== undefined;
}
