import { randomInt } from "node:crypto";
import { sha256 } from "../core/ids.ts";
import type { MemberRole, Person, RoomKind } from "../core/types.ts";
import type { Store } from "../store/repos.ts";

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
    .replace(/```cards\s*\n([\s\S]*?)\n\s*```/g, (_m, json: string) => cardsAsLines(json))
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 $2")
    .replace(/^\s*[*•]\s+/gm, "- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Linking a phone the way Fo does it: the signed-in person gets a eight-digit code in
 * Settings and texts it to the agent's number; the sender handle becomes theirs.
 * Codes live fifteen minutes in the kv store and are consumed on first use.
 */
export const LINK_CODE_TTL_MS = 15 * 60 * 1000;

/** Wrong code-shaped guesses allowed across every handle in one window, before claims pause. */
export const LINK_GUESSES_PER_WINDOW = 20;

export function mintLinkCode(store: Store, personId: string, now: number): string {
  // Eight digits: with the global guess cap below, a stranger's odds of hitting a live code are negligible.
  const code = String(randomInt(10_000_000, 100_000_000));
  store.setKv(`link:${code}`, JSON.stringify({ personId, at: now }));
  return code;
}

/** The person a code belongs to, with the handle written onto them; undefined for an unknown or stale code. */
export function claimLinkCode(store: Store, text: string, handle: string, now: number): Person | undefined {
  const code = text.trim().match(/^(\d{8})$/)?.[1];
  if (!code) return undefined;
  // A link turns a handle into someone, so guessing is capped for everyone at once, not per handle:
  // a stranger rotating numbers gets the same budget as one sending from a single phone.
  const window = Math.floor(now / LINK_CODE_TTL_MS);
  const guesses = Number(store.getKv(`link-guesses:${window}`) ?? 0);
  if (guesses >= LINK_GUESSES_PER_WINDOW) return undefined;
  const raw = store.getKv(`link:${code}`);
  if (!raw) {
    store.setKv(`link-guesses:${window}`, String(guesses + 1));
    return undefined;
  }
  store.deleteKv(`link:${code}`);
  const { personId, at } = JSON.parse(raw) as { personId: string; at: number };
  if (now - at > LINK_CODE_TTL_MS) return undefined;
  const person = store.getPerson(personId);
  if (!person) return undefined;
  const h = normaliseHandle(handle);
  if (h.includes("@")) person.email = h;
  else person.phoneE164 = h;
  store.putPerson(person);
  return person;
}

/** "iMessage · Sam, Riley & Jo": a group room named by who is in it, until the owner names it. */
export function groupRoomName(channel: string, names: string[]): string {
  const label = channel === "imessage" ? "iMessage" : channel;
  const shown = names.slice(0, 3).join(", ");
  const more = names.length - 3;
  return `${label} · ${shown}${more > 0 ? ` & ${more} more` : ""}`;
}
export const isDefaultRoomName = (name: string) => /^(imessage|whatsapp|telegram|slack) (group|·)/i.test(name);

/** A cards block in Messages: one numbered line per option, the pick marked. */
export function cardsAsLines(json: string): string {
  try {
    const items = JSON.parse(json) as { title?: string; price?: string; note?: string; url?: string; tag?: string }[];
    if (!Array.isArray(items)) return json;
    return items
      .slice(0, 6)
      .map(
        (c, i) =>
          `${i + 1}. ${c.title ?? ""}${c.price ? ` — ${c.price}` : ""}${c.note ? ` · ${c.note}` : ""}${c.tag === "pick" ? " · my pick" : ""}${c.url ? `\n   ${c.url}` : ""}`,
      )
      .join("\n");
  } catch {
    return json;
  }
}
