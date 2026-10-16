import { sha256 } from "../core/ids.ts";
import type { MemberRole, Person, RoomKind } from "../core/types.ts";

/**
 * Pure helpers for mapping a messaging handle (a phone number or an email)
 * to a person, kept apart from the Spectrum SDK so they can be tested offline.
 */

/** Phones lose spaces, dashes and brackets; emails lose case. "+1 (408) 555-0100" and "+14085550100" are one handle. */
export function normaliseHandle(handle: string): string {
  const h = handle.trim();
  if (h.includes("@")) return h.toLowerCase();
  return h.replace(/[\s\-().]/g, "");
}

/** A stable id from the handle itself, so two handles can never share a record. */
export function personIdForHandle(handle: string): string {
  return `per_im_${sha256([normaliseHandle(handle)]).slice(0, 20)}`;
}

/** The owner is recognised by the phone or email on their person record. */
export function handleMatches(person: Pick<Person, "phoneE164" | "email">, handle: string): boolean {
  const h = normaliseHandle(handle);
  if (!h) return false;
  if (person.phoneE164 && normaliseHandle(person.phoneE164) === h) return true;
  if (person.email && normaliseHandle(person.email) === h) return true;
  return false;
}

/** Someone the agent has never met is a guest, in a DM as much as in a group: served through the owner until promoted. */
export function roleForNewcomer(opts: { isOwner: boolean; kind: RoomKind }): MemberRole {
  return opts.isOwner ? "owner" : "guest";
}

/** A sliding window per handle: at most `max` messages per `windowMs`. In memory; a restart forgets it. */
export class HandleRateLimit {
  private seen = new Map<string, number[]>();
  constructor(
    private max = 20,
    private windowMs = 10 * 60 * 1000,
  ) {}

  allow(handle: string, now = Date.now()): boolean {
    const key = normaliseHandle(handle);
    const recent = (this.seen.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.seen.set(key, recent);
      return false;
    }
    recent.push(now);
    this.seen.set(key, recent);
    return true;
  }
}

/** Markdown the model wrote, flattened for a text channel: bold and italics dropped, headings plain, links as their URL, bullets kept. */
export function plainText(md: string): string {
  return md
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 $2")
    .replace(/^\s*[*•]\s+/gm, "- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
