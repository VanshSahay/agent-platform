import type { Person } from "../core/types.ts";
import type { Store } from "./repos.ts";

/**
 * Read-only lookups the channels need that the Store does not expose.
 * Free functions over the public `db` so the repositories stay untouched.
 */
export function listPeople(store: Store): Person[] {
  const rows = store.db.query("SELECT data FROM persons ORDER BY created_at").all() as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as Person);
}

export function findPersonByEmail(store: Store, email: string): Person | undefined {
  const want = email.trim().toLowerCase();
  if (!want) return undefined;
  return listPeople(store).find((p) => (p.email ?? "").trim().toLowerCase() === want);
}

/** What a co-member may see of a person: a name and how to address them, never contact details or addresses. */
export function publicPerson(p: Person): Person {
  return { id: p.id, displayName: p.displayName, pronouns: p.pronouns, timezone: p.timezone, techComfort: p.techComfort, createdAt: p.createdAt } as Person;
}

/** Everyone who shares a room with this person, plus the person. Nobody else is visible to them. */
export function peopleVisibleTo(store: Store, personId: string): Person[] {
  const ids = new Set<string>([personId]);
  for (const roomId of store.roomsForPerson(personId)) for (const m of store.listMembers(roomId)) ids.add(m.personId);
  return listPeople(store).filter((p) => ids.has(p.id));
}
