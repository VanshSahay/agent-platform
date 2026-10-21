import { newId } from "../core/ids.ts";
import type { Clock } from "../core/clock.ts";
import type { AgentSpec, ChannelKind, Id, Membership, MemberRole, Person, Room, RoomKind } from "../core/types.ts";
import type { Store } from "../store/repos.ts";
import { findPersonByEmail } from "../store/queries.ts";

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
    const m = this.members(room.id).find((x) => x.role === "owner");
    return m ? this.store.getPerson(m.personId) : undefined;
  }

  /** Who may say yes for a request in this room: the owner, whose accounts and money are at stake. */
  approversFor(room: Room): Person[] {
    return this.members(room.id)
      .filter((m) => m.role === "owner")
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
