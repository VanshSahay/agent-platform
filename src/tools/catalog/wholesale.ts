import type { WholesaleBrand, WholesaleProduct } from "../hands.ts";
import { askFirst, n, num, obj, s, str, type ToolContext, type ToolDef } from "../kit.ts";
import { saveArtifact } from "./shared.ts";

/**
 * Group orders on a wholesale marketplace (Faire): one shop account held by the deployment, many
 * people in a chat each adding what they want, one order placed once the brand's minimum is met.
 * The running order lives in kv per room and brand and is mirrored into a shared page the chat can open.
 */
interface GroupOrder {
  brandId: string;
  brandName: string;
  minimumUsd: number;
  lines: { personId: string; productId: string; name: string; quantity: number; unitUsd: number }[];
  documentId?: string;
  placed?: { orderId: string; totalUsd: number; at: number };
}
const key = (ctx: ToolContext, brandId: string) => `group-order:${ctx.room.id}:${brandId}`;
const read = (ctx: ToolContext, brandId: string): GroupOrder | undefined => {
  const raw = ctx.store.getKv(key(ctx, brandId));
  return raw ? (JSON.parse(raw) as GroupOrder) : undefined;
};
const write = (ctx: ToolContext, o: GroupOrder) => ctx.store.setKv(key(ctx, o.brandId), JSON.stringify(o));
const total = (o: GroupOrder) => o.lines.reduce((t, l) => t + l.unitUsd * l.quantity, 0);
const usd = (v: number) => `$${v.toFixed(2)}`;
const nameOf = (ctx: ToolContext, id: string) => ctx.store.getPerson(id)?.displayName ?? id;

/** Who each line belongs to, and what they owe: items plus shipping split by share of the goods. */
function shares(ctx: ToolContext, o: GroupOrder, shippingUsd = 0) {
  const byPerson = new Map<string, { items: string[]; goods: number }>();
  for (const l of o.lines) {
    const p = byPerson.get(l.personId) ?? { items: [], goods: 0 };
    p.items.push(`${l.quantity} × ${l.name}`);
    p.goods += l.unitUsd * l.quantity;
    byPerson.set(l.personId, p);
  }
  const goods = total(o);
  return [...byPerson].map(([personId, p]) => ({
    personId,
    name: nameOf(ctx, personId),
    items: p.items,
    goods: p.goods,
    owes: p.goods + (goods ? (shippingUsd * p.goods) / goods : 0),
  }));
}

function page(ctx: ToolContext, o: GroupOrder): string {
  const t = total(o);
  const short = Math.max(0, o.minimumUsd - t);
  const head = `# Group order: ${o.brandName}\n\n${o.placed ? `Placed: order ${o.placed.orderId}, ${usd(o.placed.totalUsd)}.` : short ? `${usd(t)} of the ${usd(o.minimumUsd)} minimum so far; ${usd(short)} to go.` : `${usd(t)} in, minimum ${usd(o.minimumUsd)} met. Ready to place.`}\n`;
  const body = shares(ctx, o)
    .map((sh) => `\n## ${sh.name} · ${usd(sh.goods)}\n${sh.items.map((i) => `- ${i}`).join("\n")}`)
    .join("\n");
  const markdown = `${head}${body}\n`;
  if (o.documentId) {
    const art = ctx.store.getArtifact(o.documentId);
    if (art) {
      ctx.store.putArtifact({ ...art, data: { ...(art.data as object), markdown } });
      return `${ctx.publicUrl}/d/${art.id}`;
    }
  }
  const { id, url } = saveArtifact(ctx, { kind: "document", title: `Group order: ${o.brandName}`, data: { markdown } });
  o.documentId = id;
  return url;
}

const brandLine = (b: WholesaleBrand) =>
  `${b.name} (${b.id}) · ${b.category} · min ${usd(b.minimumUsd)}, reorder ${usd(b.reorderMinimumUsd)}${b.rating ? ` · ${b.rating}★` : ""}${b.topShop ? " · Top Shop" : ""}`;
const productLine = (p: WholesaleProduct) =>
  `${p.name} (${p.id}) · wholesale ${usd(p.wholesaleUsd)}${p.retailUsd ? `, retail ${usd(p.retailUsd)}` : ""}${p.caseSize ? ` · case of ${p.caseSize}` : ""}${p.inStock ? "" : " · out of stock"}`;

export const WHOLESALE_TOOLS: ToolDef[] = [
  {
    spec: {
      name: "wholesale_find_brands",
      description:
        "Find brands on the wholesale marketplace (Faire) for a group order: name, category, first-order and reorder minimums, rating, Top Shop. Use when a chat wants to order something together or asks what is worth ordering.",
      input_schema: obj({ query: str("Brand name or what they make, e.g. 'candy' or 'KIM+ONO'."), category: str("Optional: food, apparel, home, beauty, kids, pets, paper.") }, [
        "query",
      ]),
    },
    family: "wholesale",
    labels: { running: "Looking up brands…", done: "Looked up brands" },
    sideEffect: false,
    async run(input, ctx) {
      try {
        const brands = await ctx.hands.wholesale.findBrands(s(input.query), { category: s(input.category) || undefined, limit: 10 });
        if (!brands.length) return { ok: true, content: "No brands matched.", stall: `no brands for ${s(input.query)}` };
        return { ok: true, content: brands.map(brandLine).join("\n"), evidence: `wholesale:brands:${s(input.query)}` };
      } catch (e) {
        return { ok: false, content: `Could not reach the marketplace: ${String((e as Error).message).slice(0, 200)}` };
      }
    },
  },
  {
    spec: {
      name: "wholesale_brand",
      description: "A brand's products with wholesale and retail prices, and its minimums. Use before adding items to a group order.",
      input_schema: obj({ brandId: str("Brand id from wholesale_find_brands.") }, ["brandId"]),
    },
    family: "wholesale",
    labels: { running: "Reading the brand…", done: "Read the brand" },
    sideEffect: false,
    async run(input, ctx) {
      try {
        const r = await ctx.hands.wholesale.brand(s(input.brandId));
        if (!r) return { ok: false, content: "No such brand." };
        return { ok: true, content: `${brandLine(r.brand)}\n${r.products.map(productLine).join("\n")}`, evidence: `wholesale:brand:${r.brand.id}` };
      } catch (e) {
        return { ok: false, content: `Could not read the brand: ${String((e as Error).message).slice(0, 200)}` };
      }
    },
  },
  {
    spec: {
      name: "group_order_update",
      description:
        "Add or change what one person wants in this chat's group order from a brand. Keeps the running total against the brand's minimum and updates the shared page. Call once per person who speaks; quantity 0 removes their line for that product.",
      input_schema: obj(
        {
          brandId: str("Brand id."),
          person: str("Who this is for: their name as it appears in the chat, or 'me' for the requester."),
          productId: str("Product id from wholesale_brand."),
          quantity: num("How many; 0 to remove."),
        },
        ["brandId", "person", "productId", "quantity"],
      ),
    },
    family: "wholesale",
    labels: { running: "Updating the group order…", done: "Updated the group order" },
    sideEffect: false,
    async run(input, ctx) {
      const r = await ctx.hands.wholesale.brand(s(input.brandId)).catch(() => undefined);
      if (!r) return { ok: false, content: "No such brand." };
      const product = r.products.find((p) => p.id === s(input.productId));
      if (!product) return { ok: false, content: `No product ${s(input.productId)} at ${r.brand.name}; call wholesale_brand for the list.` };
      const who = s(input.person).trim().toLowerCase();
      const personId = who === "me" || !who ? ctx.requesterId : ctx.rooms.memberIds(ctx.room.id).find((id) => nameOf(ctx, id).toLowerCase().split(" ")[0] === who.split(" ")[0]);
      if (!personId) return { ok: false, content: `No one called ${s(input.person)} in this chat.` };
      const o = read(ctx, r.brand.id) ?? { brandId: r.brand.id, brandName: r.brand.name, minimumUsd: r.brand.minimumUsd, lines: [] };
      if (o.placed) return { ok: false, content: `This order was already placed (${o.placed.orderId}); start a new one.` };
      const qty = Math.max(0, Math.floor(n(input.quantity) ?? 0));
      o.lines = o.lines.filter((l) => !(l.personId === personId && l.productId === product.id));
      if (qty > 0) o.lines.push({ personId, productId: product.id, name: product.name, quantity: qty, unitUsd: product.wholesaleUsd });
      const url = page(ctx, o);
      write(ctx, o);
      const t = total(o);
      const short = Math.max(0, o.minimumUsd - t);
      return {
        ok: true,
        content: { total: t, minimum: o.minimumUsd, shortfall: short, ready: short === 0 && t > 0, people: shares(ctx, o).map((x) => `${x.name}: ${usd(x.goods)}`), page: url },
        evidence: `group-order:${ctx.room.id}:${o.brandId}:${o.lines.length}`,
        label: `${nameOf(ctx, personId)} ${qty ? `added ${qty} × ${product.name}` : `dropped ${product.name}`}`,
      };
    },
  },
  {
    spec: {
      name: "group_order_place",
      description:
        "Place this chat's group order with the brand once the minimum is met. Asks the owner first (their shop and money), then records what each person owes them as a responsibility. Never call before the minimum is met.",
      input_schema: obj({ brandId: str("Brand id."), note: str("Anything for the brand, optional.") }, ["brandId"]),
    },
    family: "wholesale",
    labels: { running: "Placing the group order…", done: "Placed the group order", failed: "The order did not go through" },
    sideEffect: true,
    async run(input, ctx) {
      const o = read(ctx, s(input.brandId));
      if (!o?.lines.length) return { ok: false, content: "There is no group order for that brand in this chat yet." };
      if (o.placed) return { ok: false, content: `Already placed as ${o.placed.orderId}.` };
      const t = total(o);
      if (t < o.minimumUsd) return { ok: false, content: `${usd(t)} is under the ${usd(o.minimumUsd)} minimum; ${usd(o.minimumUsd - t)} to go.` };
      const gate = ctx.gate({
        kind: "purchase_approval",
        title: `OK to place the ${o.brandName} group order for ${usd(t)}?`,
        detail: shares(ctx, o)
          .map((x) => `${x.name}: ${x.items.join(", ")} (${usd(x.goods)})`)
          .join("\n"),
        money: t,
        key: ["group_order_place", o.brandId, Math.round(t * 100), o.lines.map((l) => `${l.personId}:${l.productId}:${l.quantity}`)],
      });
      const held = askFirst(gate, "Waiting for the owner's go-ahead. Nothing was ordered.");
      if (held) return held;
      try {
        const lines = new Map<string, number>();
        for (const l of o.lines) lines.set(l.productId, (lines.get(l.productId) ?? 0) + l.quantity);
        const r = await ctx.hands.wholesale.placeOrder({
          brandId: o.brandId,
          lines: [...lines].map(([productId, quantity]) => ({ productId, quantity })),
          note: s(input.note) || undefined,
        });
        o.placed = { orderId: r.orderId, totalUsd: r.totalUsd, at: ctx.clock.now() };
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
            title: `Pay ${owner?.displayName ?? "the owner"} ${usd(sh.owes)} for the ${o.brandName} order`,
            detail: sh.items.join(", "),
            sourceRunId: ctx.run.id,
          });
        }
        return {
          ok: true,
          content: { orderId: r.orderId, totalUsd: r.totalUsd, shares: shares(ctx, o).map((x) => ({ name: x.name, owes: Number(x.owes.toFixed(2)) })) },
          evidence: r.evidence,
          label: `Placed ${o.brandName} order ${r.orderId}: ${usd(r.totalUsd)}`,
        };
      } catch (e) {
        return { ok: false, content: `The order did not go through: ${String((e as Error).message).slice(0, 200)}` };
      }
    },
  },
];
