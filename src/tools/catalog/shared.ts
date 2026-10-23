import { newId } from "../../core/ids.ts";
import type { Artifact, Id } from "../../core/types.ts";
import type { ToolContext } from "../kit.ts";
import { spendSummary, startOfDayIso } from "../../runtime/spend.ts";

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
    // A page posted into Messages is opened by tapping its link, with no sign-in: anyone with the link may read it there.
    share: a.share ?? (ctx.room.channel !== "web" ? "link" : "room"),
    createdAt: ctx.clock.now(),
  };
  ctx.store.putArtifact(art);
  return { id: art.id, url: `${ctx.publicUrl}/d/${art.id}` };
}

/** Rooms the requester may read: the ones they are in. The owner also sees every group, never another person's private chat. */
export function readableRooms(ctx: ToolContext) {
  const all = ctx.store.listRooms(ctx.agent.id);
  const mine = new Set(ctx.requesterId ? ctx.store.roomsForPerson(ctx.requesterId) : []);
  return all.filter((r) => mine.has(r.id) || (ctx.requesterId === ctx.agent.ownerId && r.kind !== "dm"));
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

/**
 * Public price lookups cost money per run (Apify). PUBLIC_RATES_DAILY_CAP_USD (default 2) is the most a day may spend on
 * them; past it the comparison still runs on our side and says the public column is paused for the day.
 */
export function publicLookupsPaused(ctx: ToolContext): string | undefined {
  const cap = Number(process.env.PUBLIC_RATES_DAILY_CAP_USD ?? 2);
  if (!(cap > 0)) return undefined;
  const spent = spendSummary(ctx.store.db, { since: startOfDayIso(ctx.clock.now()), until: new Date(ctx.clock.now()).toISOString() }).byProvider.apify?.usd ?? 0;
  return spent >= cap ? `public price lookups are paused for today: $${spent.toFixed(2)} spent of the $${cap} daily cap (PUBLIC_RATES_DAILY_CAP_USD)` : undefined;
}
