import { newId } from "../core/ids.ts";
import type { Clock } from "../core/clock.ts";
import type { AgentSpec, ChannelKind, Id, Membership, MemberRole, Person, Room, RoomKind } from "../core/types.ts";
import type { Store } from "../store/repos.ts";
import { findPersonByEmail } from "../store/queries.ts";
import { privateProfileId } from "../memory/consolidate.ts";

/**
 * Rooms are the chats the agent is deployed into. The agent is one identity
 * across rooms (its training follows it), but what a room says stays there.
 */
export class RoomService {
  constructor(
    private store: Store,
    private clock: Clock,
  ) {}

  createPerson(input: Omit<Person, "id" | "createdAt"> & { id?: Id }): Person {
    const p: Person = { ...input, id: input.id ?? newId("per"), createdAt: this.clock.now() };
    this.store.putPerson(p);
    return p;
  }

  createRoom(input: {
    agentId: Id;
    kind: RoomKind;
    channel: ChannelKind;
    name: string;
    externalId?: string;
    focus?: string;
    outreachHours?: { start: number; end: number };
  }): Room {
    const r: Room = {
      id: newId("room"),
      agentId: input.agentId,
      kind: input.kind,
      channel: input.channel,
      externalId: input.externalId,
      name: input.name,
      focus: input.focus?.trim() || undefined,
      outreachHours: input.outreachHours ?? { start: 8, end: 20 },
      createdAt: this.clock.now(),
    };
    this.store.putRoom(r);
    return r;
  }

  addMember(roomId: Id, personId: Id, role: MemberRole, opts: { consented?: boolean } = {}): Membership {
    const m: Membership = {
      roomId,
      personId,
      role,
      consentedAt: opts.consented ? this.clock.now() : undefined,
      joinedAt: this.clock.now(),
    };
    this.store.putMembership(m);
    return m;
  }

  /** The owner stays; anyone else can be taken out of a room. Their notes and messages remain where they were. */
  removeMember(roomId: Id, personId: Id): boolean {
    const m = this.store.getMembership(roomId, personId);
    if (!m || m.role === "owner") return false;
    this.store.deleteMembership(roomId, personId);
    return true;
  }

  setRole(roomId: Id, personId: Id, role: MemberRole): Membership | undefined {
    const m = this.store.getMembership(roomId, personId);
    if (!m || m.role === "owner" || role === "owner") return undefined;
    m.role = role;
    this.store.putMembership(m);
    return m;
  }

  /** Co-owners (multiplayer-spec §6.4/§7.3): a room owner promotes a member; a guest becomes a member first. */
  promoteOwner(roomId: Id, personId: Id): Membership | undefined {
    const m = this.store.getMembership(roomId, personId);
    if (m?.role !== "member") return undefined;
    m.role = "owner";
    this.store.putMembership(m);
    return m;
  }

  /**
   * Someone named by a person in the circle: an existing record by phone or email, or a new one.
   * A phone or email is what lets a text or a sign-in later land on the same person.
   */
  findOrCreatePerson(input: { displayName?: string; email?: string; phoneE164?: string; timezone?: string }): Person | undefined {
    const email = input.email?.trim().toLowerCase() || undefined;
    const phone = input.phoneE164?.replace(/[\s()-]/g, "") || undefined;
    const existing = (phone && this.store.findPersonByPhone(phone)) || (email && findPersonByEmail(this.store, email)) || undefined;
    if (existing) return existing;
    const displayName = input.displayName?.trim() || email?.split("@")[0] || phone;
    if (!displayName) return undefined;
    return this.createPerson({ displayName: displayName.slice(0, 80), email, phoneE164: phone, timezone: input.timezone ?? "UTC" });
  }

  /**
   * Two records are one human (multiplayer-spec §11): memberships, person memories and
   * profiles move onto the kept record; a guest membership becomes member, because the
   * dropped side is the one that signed up. The dropped record stays queryable — old
   * messages point at it — but marked merged, and phone lookups follow the pointer.
   * Nothing merges on a display name alone: callers match on handle, phone or email.
   */
  mergePeople(keepId: Id, dropId: Id): Person | undefined {
    if (keepId === dropId) return this.store.getPerson(keepId);
    const keep = this.store.getPerson(keepId);
    const drop = this.store.getPerson(dropId);
    if (!keep || !drop || drop.mergedInto) return undefined;
    // The kept record should reach the human by every handle they used.
    if (!keep.phoneE164 && drop.phoneE164) keep.phoneE164 = drop.phoneE164;
    if (!keep.email && drop.email) keep.email = drop.email;
    keep.mergedFrom = [...(keep.mergedFrom ?? []), dropId];
    this.store.putPerson(keep);
    for (const roomId of this.store.roomsForPerson(dropId)) {
      const m = this.store.getMembership(roomId, dropId);
      if (!m) continue;
      this.store.deleteMembership(roomId, dropId);
      const existing = this.store.getMembership(roomId, keepId);
      if (existing) {
        if (existing.role === "guest" && m.role !== "guest") {
          existing.role = m.role;
          existing.consentedAt = existing.consentedAt ?? m.consentedAt;
          this.store.putMembership(existing);
        }
      } else {
        this.store.putMembership({ ...m, personId: keepId, role: m.role === "guest" ? "member" : m.role, joinedAt: this.clock.now() });
      }
    }
    for (const a of this.store.listAgents()) {
      // Inactive versions too: a superseded or retracted note is still about this person.
      for (const m of this.store.listMemories(a.id, { includeInactive: true })) {
        const scoped = m.scope === "person" && m.scopeId === dropId;
        const about = m.subjectPersonId === dropId;
        if (scoped || about) this.store.putMemory({ ...m, scopeId: scoped ? keepId : m.scopeId, subjectPersonId: about ? keepId : m.subjectPersonId });
      }
      for (const [from, to] of [
        [dropId, keepId],
        [privateProfileId(dropId), privateProfileId(keepId)],
      ] as const) {
        const dropped = this.store.getProfile(a.id, "person", from);
        if (!dropped) continue;
        const kept = this.store.getProfile(a.id, "person", to);
        // Both sides keep what they knew until the next consolidation re-derives one profile.
        this.store.putProfile(kept ? { ...kept, text: `${kept.text}\n${dropped.text}`, derivedAt: Math.max(kept.derivedAt, dropped.derivedAt) } : { ...dropped, scopeId: to });
        this.store.deleteProfile(a.id, "person", from);
      }
    }
    // Everything else that names the dropped record: open cards, the ledger, credentials, runs,
    // tasks, approvals, agents it owns. A card waiting on a stranger must find them after they sign up.
    this.store.reassignPerson(dropId, keepId);
    this.store.putPerson({ ...drop, mergedInto: keepId });
    return this.store.getPerson(keepId);
  }

  consent(roomId: Id, personId: Id) {
    const m = this.store.getMembership(roomId, personId);
    if (!m) throw new Error("not a member");
    m.consentedAt = this.clock.now();
    this.store.putMembership(m);
  }

  members(roomId: Id): Membership[] {
    return this.store.listMembers(roomId);
  }

  memberIds(roomId: Id): Id[] {
    return this.members(roomId).map((m) => m.personId);
  }

  role(roomId: Id, personId: Id): MemberRole | undefined {
    return this.store.getMembership(roomId, personId)?.role;
  }

  owner(room: Room): Person | undefined {
    return this.approversFor(room)[0];
  }

  /** Who may say yes for a request in this room: the owner, whose accounts and money are at stake. */
  /**
   * The room's owners, the agent's owner first, then co-owners by when they joined. Never row
   * order: the store returns memberships by person id, so "the first owner" would otherwise
   * depend on how ids happen to sort.
   */
  approversFor(room: Room): Person[] {
    const agentOwner = this.store.getAgent(room.agentId)?.ownerId;
    return this.members(room.id)
      .filter((m) => m.role === "owner")
      .sort((a, b) => Number(b.personId === agentOwner) - Number(a.personId === agentOwner) || a.joinedAt - b.joinedAt)
      .map((m) => this.store.getPerson(m.personId))
      .filter((p): p is Person => !!p);
  }

  /**
   * Whose accounts may be used for a request from `requesterId`:
   *  - a member with consent: their own accounts, for their own request;
   *  - anyone else (a guest, a member without consent): the owner's,
   *    which means the owner must OK anything that uses them.
   */
  accountsFor(room: Room, requesterId: Id): { accountOwnerId: Id; needsApproval: boolean } {
    const owner = this.owner(room);
    const mem = this.store.getMembership(room.id, requesterId);
    if (owner && requesterId === owner.id) return { accountOwnerId: owner.id, needsApproval: false };
    // A co-owner's own requests run on their own accounts and money (multiplayer-spec §7.3).
    if (mem && mem.role === "owner") return { accountOwnerId: requesterId, needsApproval: false };
    if (mem && mem.role === "member" && mem.consentedAt) return { accountOwnerId: requesterId, needsApproval: false };
    return { accountOwnerId: owner?.id ?? requesterId, needsApproval: true };
  }

  /** The DM room between the agent and a person, created on demand so cards can go there. */
  dmFor(agent: AgentSpec, personId: Id): Room {
    // Someone who texts the line lives in Messages: their cards go to that chat, not to a web-only one.
    const dms = this.store.listRooms(agent.id).filter((r) => r.kind === "dm" && this.memberIds(r.id).includes(personId) && this.memberIds(r.id).length === 1);
    const existing = dms.find((r) => r.channel !== "web") ?? dms[0];
    if (existing) return existing;
    const person = this.store.getPerson(personId);
    const room = this.createRoom({ agentId: agent.id, kind: "dm", channel: "web", name: `${agent.name} & ${person?.displayName ?? personId}` });
    this.addMember(room.id, personId, personId === agent.ownerId ? "owner" : "member", { consented: personId === agent.ownerId });
    return room;
  }

  describe(room: Room): string {
    const lines = this.members(room.id).map((m) => {
      const p = this.store.getPerson(m.personId);
      const bits = [p?.displayName ?? m.personId, m.role];
      if (p?.pronouns) bits.push(p.pronouns);
      if (p?.techComfort === "low") bits.push("low tech comfort");
      return `- ${bits.join(", ")}`;
    });
    const focus = room.focus ? `\nPriorities in this chat (what they added you for): ${room.focus}` : "";
    return `${room.kind === "dm" ? "Direct chat" : "Group chat"} "${room.name}" on ${room.channel}.${focus}\nMembers:\n${lines.join("\n")}`;
  }
}
