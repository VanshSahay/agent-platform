import { newId } from "../../core/ids.ts";
import type { Artifact, Id } from "../../core/types.ts";
import type { ToolContext } from "../kit.ts";

/** Store something the agent made and hand back where to open it. */
export function saveArtifact(ctx: ToolContext, a: { kind: Artifact["kind"]; title: string; data: unknown; share?: Artifact["share"] }): { id: Id; url: string } {
  const art: Artifact = {
    id: newId("art"),
    agentId: ctx.agent.id,
    roomId: ctx.room.id,
    runId: ctx.run.id,
    kind: a.kind,
    title: a.title,
    data: a.data,
    share: a.share ?? "room",
    createdAt: ctx.clock.now(),
  };
  ctx.store.putArtifact(art);
  return { id: art.id, url: `${ctx.publicUrl}/d/${art.id}` };
}

/** Rooms the requester may read: the ones they are in (the owner sees every room of the agent). */
export function readableRooms(ctx: ToolContext) {
  const all = ctx.store.listRooms(ctx.agent.id);
  if (ctx.requesterId === ctx.agent.ownerId) return all;
  const mine = new Set(ctx.requesterId ? ctx.store.roomsForPerson(ctx.requesterId) : []);
  return all.filter((r) => mine.has(r.id));
}

export const clip = (text: string, max = 4000) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A tool that needs a service the person has not connected: say so, point at Settings. */
export function notConnected(ctx: ToolContext, service: string) {
  const who = ctx.store.getPerson(ctx.accountOwnerId)?.displayName ?? "the account owner";
  return {
    ok: false as const,
    content: `${service} is not connected for ${who}. Ask them to connect it under Settings → Connections (${ctx.publicUrl}/#settings), then try again.`,
  };
}
