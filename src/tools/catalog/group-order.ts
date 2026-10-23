import { askFirst, n, num, obj, s, str, type ToolContext, type ToolDef } from "../kit.ts";
import { saveArtifact } from "./shared.ts";

/**
 * Group orders from a wholesale brand (Faire): many people in a chat each add what they want, the
 * order is handed to the owner once the brand's minimum is met, and the owner places it on faire.com
 * with their own buyer account. Faire's API is brand-side only, so the agent never places anything;
 * it keeps the shared list and records who owes the owner once they say it is in.
 */
interface GroupOrder {
  brand: string;
  minimumUsd: number;
  lines: { personId: string; item: string; quantity: number; unitUsd: number }[];
  documentId?: string;
  placedAt?: number;
}
const slug = (brand: string) =>
  brand
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
const key = (ctx: ToolContext, brand: string) => `group-order:${ctx.room.id}:${slug(brand)}`;
const read = (ctx: ToolContext, brand: string): GroupOrder | undefined => {
  const raw = ctx.store.getKv(key(ctx, brand));
  return raw ? (JSON.parse(raw) as GroupOrder) : undefined;
};
const write = (ctx: ToolContext, o: GroupOrder) => ctx.store.setKv(key(ctx, o.brand), JSON.stringify(o));
const total = (o: GroupOrder) => o.lines.reduce((t, l) => t + l.unitUsd * l.quantity, 0);
const usd = (v: number) => `$${v.toFixed(2)}`;
const nameOf = (ctx: ToolContext, id: string) => ctx.store.getPerson(id)?.displayName ?? id;

/** Who each line belongs to and what they owe (goods only; shipping is the owner's to split if they want). */
function shares(ctx: ToolContext, o: GroupOrder) {
  const byPerson = new Map<string, { items: string[]; goods: number }>();
  for (const l of o.lines) {
    const p = byPerson.get(l.personId) ?? { items: [], goods: 0 };
    p.items.push(`${l.quantity} × ${l.item}`);
    p.goods += l.unitUsd * l.quantity;
    byPerson.set(l.personId, p);
  }
  return [...byPerson].map(([personId, p]) => ({ personId, name: nameOf(ctx, personId), items: p.items, goods: p.goods }));
}

function page(ctx: ToolContext, o: GroupOrder): string {
  const t = total(o);
  const short = Math.max(0, o.minimumUsd - t);
  const status = o.placedAt
    ? `Placed by the owner on faire.com: ${usd(t)}.`
    : short
      ? `${usd(t)} of the ${usd(o.minimumUsd)} minimum so far; ${usd(short)} to go.`
      : `${usd(t)} in, minimum ${usd(o.minimumUsd)} met. Ready for the owner to place.`;
  const body = shares(ctx, o)
    // Plain lines, not bullets: a bulleted page becomes a tickable list, and an order is not a checklist.
    .map((sh) => `\n## ${sh.name} · ${usd(sh.goods)}\n${sh.items.join("\n\n")}`)
    .join("\n");
  const markdown = `# Group order: ${o.brand}\n\n${status}\n${body}\n`;
  if (o.documentId) {
    const art = ctx.store.getArtifact(o.documentId);
    if (art) {
      ctx.store.putArtifact({ ...art, data: { ...(art.data as object), markdown } });
      return `${ctx.publicUrl}/d/${art.id}`;
    }
  }
  const { id, url } = saveArtifact(ctx, { kind: "document", title: `Group order: ${o.brand}`, data: { markdown } });
  o.documentId = id;
  return url;
}

export const GROUP_ORDER_TOOLS: ToolDef[] = [
  {
    spec: {
      name: "group_order_update",
      description:
        "Add, change or remove one person's line in this chat's group order from a wholesale brand. Give the brand's first-order minimum when opening the order (read it from the brand's faire.com page or ask), and each item's wholesale unit price. Quantity 0 removes the line. Returns the running total, what is still missing, and the shared page.",
      input_schema: obj(
        {
          brand: str("Brand name as on faire.com, e.g. 'Candy Club'."),
          minimumUsd: num("The brand's first-order minimum in USD, from its faire.com page. Pass it on every call; the first call sets it."),
          person: str("Who the line is for: 'me' or a first name from this chat."),
          item: str("Product name as on the brand's page."),
          unitUsd: num("Wholesale price per unit in USD."),
          quantity: num("How many; 0 removes the line."),
        },
        ["brand", "minimumUsd", "person", "item", "unitUsd", "quantity"],
      ),
    },
    family: "wholesale",
    labels: { running: "Updating the group order…", done: "Updated the group order" },
    sideEffect: false,
    async run(input, ctx) {
      const brand = s(input.brand).trim();
      const who = s(input.person).trim().toLowerCase();
      const personId = who === "me" || !who ? ctx.requesterId : ctx.rooms.memberIds(ctx.room.id).find((id) => nameOf(ctx, id).toLowerCase().split(" ")[0] === who.split(" ")[0]);
      if (!personId) return { ok: false, content: `No one called ${s(input.person)} in this chat.` };
      const existing = read(ctx, brand);
      if (!existing && !(n(input.minimumUsd) ?? 0))
        return { ok: false, content: `Opening a ${brand} order needs the brand's first-order minimum (minimumUsd); read it on faire.com or ask.` };
      const o = existing ?? { brand, minimumUsd: n(input.minimumUsd) ?? 0, lines: [] };
      if (o.placedAt) return { ok: false, content: "This order was already placed; start a new one." };
      const item = s(input.item).trim();
      const qty = Math.max(0, Math.floor(n(input.quantity) ?? 0));
      const unit = n(input.unitUsd) ?? 0;
      if (qty > 0 && unit <= 0) return { ok: false, content: `Need the wholesale unit price for ${item}.` };
      o.lines = o.lines.filter((l) => !(l.personId === personId && l.item.toLowerCase() === item.toLowerCase()));
      if (qty > 0) o.lines.push({ personId, item, quantity: qty, unitUsd: unit });
      const url = page(ctx, o);
      write(ctx, o);
      const t = total(o);
      const short = Math.max(0, o.minimumUsd - t);
      return {
        ok: true,
        content: {
          total: t,
          minimum: o.minimumUsd,
          shortfall: short,
          ready: short === 0 && t > 0,
          people: shares(ctx, o).map((x) => `${x.name}: ${usd(x.goods)}`),
          page: url,
          // The result says what comes next, so "minimum met" in a reply is never the end of the turn.
          next:
            short === 0 && t > 0
              ? "Minimum met: call group_order_close now, in this turn. Its card to the owner is the last call."
              : `Tell the chat the total and that ${usd(short)} is still missing.`,
        },
        evidence: `group-order:${ctx.room.id}:${slug(brand)}:${o.lines.length}`,
        label: `${nameOf(ctx, personId)} ${qty ? `added ${qty} × ${item}` : `dropped ${item}`}`,
      };
    },
  },
  {
    spec: {
      name: "group_order_close",
      description:
        "Close this chat's group order once the minimum is met: hands the owner the full list to place on faire.com with their own account, and once the owner says it is placed, records what each person owes them. The agent never places the order itself. Never call before the minimum is met.",
      input_schema: obj({ brand: str("Brand name.") }, ["brand"]),
    },
    family: "wholesale",
    labels: { running: "Handing the order to the owner…", done: "Recorded the group order", failed: "The order is not closed" },
    sideEffect: true,
    async run(input, ctx) {
      const o = read(ctx, s(input.brand));
      if (!o?.lines.length) return { ok: false, content: "There is no group order for that brand in this chat yet." };
      if (o.placedAt) return { ok: false, content: "Already placed." };
      const t = total(o);
      if (t < o.minimumUsd) return { ok: false, content: `${usd(t)} is under the ${usd(o.minimumUsd)} minimum; ${usd(o.minimumUsd - t)} to go.` };
      const lines = new Map<string, number>();
      for (const l of o.lines) lines.set(l.item, (lines.get(l.item) ?? 0) + l.quantity);
      const gate = ctx.gate({
        kind: "action",
        title: `${o.brand} group order is at ${usd(t)}, minimum met. Place it on faire.com and reply yes once it is in.`,
        detail: [...lines].map(([item, q]) => `${q} × ${item}`).join("\n"),
        money: t,
        key: ["group_order_close", slug(o.brand), Math.round(t * 100), o.lines.map((l) => `${l.personId}:${l.item}:${l.quantity}`)],
      });
      const held = askFirst(gate, "Waiting for the owner to place it on faire.com. Nothing is recorded yet.");
      if (held) return held;
      o.placedAt = ctx.clock.now();
      page(ctx, o);
      write(ctx, o);
      // Each person owes the shop owner their share; the ledger nudges them.
      const owner = ctx.store.getPerson(ctx.agent.ownerId);
      for (const sh of shares(ctx, o)) {
        if (sh.personId === ctx.agent.ownerId) continue;
        ctx.commitments.track({
          roomId: ctx.room.id,
          agentId: ctx.agent.id,
          ownerId: sh.personId,
          beneficiaryId: ctx.agent.ownerId,
          title: `Pay ${owner?.displayName ?? "the owner"} ${usd(sh.goods)} for the ${o.brand} order`,
          detail: sh.items.join(", "),
          sourceRunId: ctx.run.id,
        });
      }
      return {
        ok: true,
        content: { totalUsd: t, shares: shares(ctx, o).map((x) => ({ name: x.name, owes: Number(x.goods.toFixed(2)) })) },
        evidence: `group-order:${ctx.room.id}:${slug(o.brand)}:placed`,
        label: `${o.brand} order placed by the owner: ${usd(t)}`,
      };
    },
  },
];
