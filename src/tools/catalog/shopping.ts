import { newId } from "../../core/ids.ts";
import type { Address } from "../../core/types.ts";
import { askFirst, n, num, obj, s, str, type ToolContext, type ToolDef, type ToolResult } from "../kit.ts";
import { clip } from "./shared.ts";

/**
 * Fo's "shopping" family. A cart per person lives in the store; products come from web search
 * biased to shops; checkout goes through the purchase gate, mints a single-use card from the
 * payment provider into the vault, and places the order in the browser with that card. The
 * model never sees card details.
 */
export interface CartItem {
  id: string;
  title: string;
  url: string;
  priceUsd?: number;
  quantity: number;
  merchant: string;
}
const cartKey = (ctx: ToolContext) => `cart:${ctx.accountOwnerId}`;
/** Changing someone else's cart or saved addresses asks them first; your own is yours. */
function foreignWrite(ctx: ToolContext, title: string, detail: string, key: unknown[]): ToolResult | undefined {
  if (ctx.requesterId === ctx.accountOwnerId) return undefined;
  const owner = ctx.store.getPerson(ctx.accountOwnerId)?.displayName ?? "the account owner";
  return askFirst(ctx.gate({ kind: "action", title, detail, key }), `Asked ${owner} before changing their ${title.includes("address") ? "addresses" : "cart"}.`);
}
const readCart = (ctx: ToolContext): CartItem[] => JSON.parse(ctx.store.getKv(cartKey(ctx)) ?? "[]") as CartItem[];
const writeCart = (ctx: ToolContext, items: CartItem[]) => ctx.store.setKv(cartKey(ctx), JSON.stringify(items));
const merchantOf = (url: string) =>
  url
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0] ?? "";
const total = (items: CartItem[]) => items.reduce((sum, i) => sum + (i.priceUsd ?? 0) * i.quantity, 0);
const price = (text: string) => {
  const m = text.match(/\$\s?(\d{1,5}(?:[.,]\d{2})?)/);
  return m ? Number(m[1]!.replace(",", "")) : undefined;
};

export const SHOPPING_TOOLS: ToolDef[] = [
  {
    spec: {
      name: "search_products",
      description: "Find things to buy online: returns product pages with prices where visible. Add one with add_to_cart.",
      input_schema: obj({ query: str("What to buy."), merchant: str("Prefer a shop, e.g. walgreens.com, optional."), maxPriceUsd: num("Optional ceiling.") }, ["query"]),
    },
    family: "shopping",
    labels: { running: "Searching products…", done: "Found products" },
    sideEffect: false,
    async run(input, ctx) {
      const q = `${s(input.query)} buy price${s(input.merchant) ? ` site:${s(input.merchant)}` : ""}`;
      const r = await ctx.hands.search.search(q, { limit: 8 });
      const max = n(input.maxPriceUsd);
      const items = r.results
        .map((x) => ({ title: x.title, url: x.url, merchant: merchantOf(x.url), priceUsd: price(`${x.title} ${x.snippet}`), snippet: clip(x.snippet, 200) }))
        .filter((x) => max === undefined || x.priceUsd === undefined || x.priceUsd <= max);
      if (!items.length) return { ok: true, content: "Nothing found.", evidence: r.evidence, stall: `no products for "${s(input.query)}"`, approach: "search" };
      return { ok: true, content: items, evidence: r.evidence, approach: "search", label: `Searched products: ${s(input.query).slice(0, 40)}` };
    },
  },
  {
    spec: {
      name: "add_to_cart",
      description: "Put a product in the person's cart (not bought yet).",
      input_schema: obj({ title: str("Product name."), url: str("Product page URL."), priceUsd: num("Unit price if known."), quantity: num("Default 1.") }, ["title", "url"]),
    },
    family: "shopping",
    labels: { running: "Adding to cart…", done: "Added to cart" },
    sideEffect: false,
    async run(input, ctx) {
      const asked = foreignWrite(ctx, "OK to add to your cart?", JSON.stringify(input).slice(0, 300), ["add_to_cart", input]);
      if (asked) return asked;
      if (!/^https:\/\//i.test(s(input.url))) return { ok: false, content: "url must be the product page (https://…)." };
      if (n(input.priceUsd) !== undefined && n(input.priceUsd)! < 0) return { ok: false, content: "priceUsd cannot be negative." };
      const items = readCart(ctx);
      const item: CartItem = {
        id: newId("ci"),
        title: s(input.title).slice(0, 140),
        url: s(input.url),
        priceUsd: n(input.priceUsd) !== undefined && n(input.priceUsd)! >= 0 ? n(input.priceUsd) : undefined,
        quantity: Math.max(1, Math.trunc(n(input.quantity) ?? 1)),
        merchant: merchantOf(s(input.url)),
      };
      items.push(item);
      writeCart(ctx, items);
      return { ok: true, content: { itemId: item.id, items: items.length, totalUsd: total(items) }, evidence: `cart:${item.id}` };
    },
  },
  {
    spec: { name: "view_cart", description: "What is in the person's cart and the total.", input_schema: obj({}) },
    family: "shopping",
    labels: { running: "Checking the cart…", done: "Checked the cart" },
    sideEffect: false,
    async run(_input, ctx) {
      const items = readCart(ctx);
      return { ok: true, content: { items, totalUsd: total(items) } };
    },
  },
  {
    spec: { name: "remove_from_cart", description: "Take an item out of the cart.", input_schema: obj({ itemId: str("Cart item id.") }, ["itemId"]) },
    family: "shopping",
    labels: { running: "Removing from cart…", done: "Removed from cart" },
    sideEffect: false,
    async run(input, ctx) {
      const asked = foreignWrite(ctx, "OK to change your cart?", JSON.stringify(input).slice(0, 300), ["remove_from_cart", input]);
      if (asked) return asked;
      const items = readCart(ctx).filter((i) => i.id !== s(input.itemId));
      writeCart(ctx, items);
      return { ok: true, content: { items: items.length, totalUsd: total(items) } };
    },
  },
  {
    spec: {
      name: "checkout_cart",
      description:
        "Clear the budget for what is in the cart: asks the owner (or passes under their threshold) for exactly this amount at this merchant. It does not place the order: there is no checkout hand yet, so say what was approved, keep the cart, and hand the person the merchant link and the delivery address to finish.",
      input_schema: obj({ addressId: str("Saved address id; default the first one."), note: str("Anything the merchant should know.") }),
    },
    family: "shopping",
    labels: { running: "Clearing the budget…", done: "Budget cleared", failed: "Checkout did not go through" },
    sideEffect: false,
    async run(input, ctx) {
      const items = readCart(ctx);
      if (!items.length) return { ok: false, content: "The cart is empty." };
      const amount = total(items);
      const merchants = [...new Set(items.map((i) => i.merchant))];
      if (merchants.length > 1) return { ok: false, content: `The cart spans ${merchants.join(", ")}; check out one shop at a time (remove the others first).` };
      const merchant = merchants[0]!;
      if (!amount) return { ok: false, content: "No prices on the items; add them with prices first." };
      const gate = ctx.gate({
        kind: "purchase_approval",
        title: `OK to spend $${amount.toFixed(2)} at ${merchant}?`,
        detail: items.map((i) => `${i.quantity} × ${i.title}${i.priceUsd ? ` @ $${i.priceUsd}` : ""}`).join("\n"),
        money: amount,
        key: ["checkout_cart", merchant, amount, items.map((i) => i.id)],
      });
      const held = askFirst(gate, "Waiting for approval before paying.");
      if (held) return held;
      const person = ctx.store.getPerson(ctx.accountOwnerId);
      const address = (person?.addresses ?? []).find((a) => a.id === s(input.addressId)) ?? person?.addresses?.[0];
      if (!address) return { ok: false, content: `No delivery address saved for ${person?.displayName ?? "the buyer"}. Ask for one and save it with save_address.` };
      // No card is minted and nothing is ordered: an approval is not a purchase, and a footer
      // must never say "Checkout" for an order that was not placed. The cart stays for the person.
      return {
        ok: true,
        content: {
          approved: gate.granted ? gate.reason : "",
          amountUsd: amount,
          merchant,
          deliverTo: `${address.line1}, ${address.city}`,
          cart: items.map((i) => ({ title: i.title, url: i.url, quantity: i.quantity, priceUsd: i.priceUsd })),
          note: "Budget cleared, order NOT placed: Circle cannot pay at a merchant yet. Give the person the item links, the amount and the address so they can finish, and say plainly that nothing was ordered.",
        },
        label: `Budget cleared at ${merchant}: $${amount.toFixed(2)} (order not placed)`,
      };
    },
  },
  {
    spec: {
      name: "save_address",
      description: "Save a delivery address for the person.",
      input_schema: obj(
        {
          label: str("Home, Work, the cabin…"),
          line1: str("Street."),
          line2: str("Apartment, optional."),
          city: str("City."),
          region: str("State or region."),
          postalCode: str("Postal code."),
          country: str("Country, default US."),
        },
        ["label", "line1", "city"],
      ),
    },
    family: "shopping",
    labels: { running: "Saving an address…", done: "Saved an address" },
    sideEffect: false,
    async run(input, ctx) {
      const asked = foreignWrite(ctx, "OK to save an address on your account?", JSON.stringify(input).slice(0, 300), ["save_address", input]);
      if (asked) return asked;
      const person = ctx.store.getPerson(ctx.accountOwnerId);
      if (!person) return { ok: false, content: "No person." };
      const a: Address = {
        id: newId("addr"),
        label: s(input.label),
        line1: s(input.line1),
        line2: s(input.line2) || undefined,
        city: s(input.city),
        region: s(input.region) || undefined,
        postalCode: s(input.postalCode) || undefined,
        country: s(input.country) || "US",
      };
      person.addresses = [...(person.addresses ?? []), a];
      ctx.store.putPerson(person);
      return { ok: true, content: { addressId: a.id }, evidence: `address:${a.id}` };
    },
  },
  {
    spec: { name: "list_saved_addresses", description: "The person's saved delivery addresses.", input_schema: obj({}) },
    family: "shopping",
    labels: { running: "Checking your saved addresses…", done: "Read your saved addresses" },
    sideEffect: false,
    async run(_input, ctx) {
      return { ok: true, content: ctx.store.getPerson(ctx.accountOwnerId)?.addresses ?? [] };
    },
  },
  {
    spec: { name: "delete_saved_address", description: "Remove a saved address.", input_schema: obj({ addressId: str("Address id.") }, ["addressId"]) },
    family: "shopping",
    labels: { running: "Removing an address…", done: "Removed an address" },
    sideEffect: false,
    async run(input, ctx) {
      const asked = foreignWrite(ctx, "OK to remove a saved address?", JSON.stringify(input).slice(0, 300), ["delete_saved_address", input]);
      if (asked) return asked;
      const person = ctx.store.getPerson(ctx.accountOwnerId);
      if (!person) return { ok: false, content: "No person." };
      person.addresses = (person.addresses ?? []).filter((a) => a.id !== s(input.addressId));
      ctx.store.putPerson(person);
      return { ok: true, content: "Removed." };
    },
  },
];
