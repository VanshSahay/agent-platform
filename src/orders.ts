// Group buying / group ordering in a group chat: an organizer opens an order, people reply naturally ("in for 2"),
// the agent keeps a running tally, nudges before the deadline, closes it, and hands everyone a pay link.
// The agent never moves money: payment links point at the organizer's Venmo / PayPal / Cash App.
import { all, one, exec, emit, id, now, S, J } from "./db";
import { extraPlanners, extraSummaries } from "./model";
import { parseDates } from "./reservations";
import * as rt from "./runtime";
import * as tools from "./tools";

const NUMW: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, dozen: 12 };
const n = (s: string) => Number(NUMW[s.toLowerCase()] ?? s);
const money = (x: number) => `$${x.toFixed(2).replace(/\.00$/, "")}`;

export const currentOrder = (roomId: string) => one<any>("select * from group_orders where room_id=? and status='open' order by created_at desc limit 1", roomId);
const items = (o: any): { id: string; name: string; price: number; unit?: string }[] => J(o.items, []);

function matchItem(o: any, text?: string) {
  const list = items(o);
  if (list.length === 1 || !text) return list[0];
  const t = text.toLowerCase();
  return list.find((i) => t.includes(i.name.toLowerCase())) ?? list.find((i) => i.name.toLowerCase().split(/\s+/).some((w) => w.length > 3 && t.includes(w.replace(/s$/, ""))));
}

export function tally(o: any) {
  const lines = all<any>("select * from order_lines where order_id=? and qty>0 order by updated_at", o.id);
  const list = items(o);
  const byItem = list.map((i) => ({ ...i, qty: lines.filter((l) => l.item_id === i.id).reduce((s, l) => s + l.qty, 0) }));
  const people = [...new Set(lines.map((l) => l.user_id))];
  const subtotal = (u: string) => lines.filter((l) => l.user_id === u).reduce((s, l) => s + l.qty * (list.find((i) => i.id === l.item_id)?.price ?? 0), 0);
  const ship = Number(o.shipping_fee ?? 0), share = people.length ? ship / people.length : 0;
  const perPerson = people.map((u) => ({ user_id: u, name: rt.nameOf(u), lines: lines.filter((l) => l.user_id === u).map((l) => ({ item: list.find((i) => i.id === l.item_id)?.name, qty: l.qty })),
    total: Math.round((subtotal(u) + share) * 100) / 100, paid: lines.filter((l) => l.user_id === u).every((l) => l.paid) }));
  const totalQty = byItem.reduce((s, i) => s + i.qty, 0);
  return { order_id: o.id, title: o.title, byItem, perPerson, totalQty, min: o.min_total_qty, reached: !o.min_total_qty || totalQty >= o.min_total_qty,
    deadline: o.deadline_at ? new Date(o.deadline_at).toISOString() : null, status: o.status, grand_total: perPerson.reduce((s, p) => s + p.total, 0) };
}

export function payLink(handle: string | null, amount: number, note: string) {
  if (!handle) return null;
  const m = handle.match(/^(venmo|paypal|cashapp)[:\s]*@?(.+)$/i);
  const [kind, h] = m ? [m[1].toLowerCase(), m[2].trim()] : ["venmo", handle.replace(/^@/, "")];
  if (kind === "paypal") return `https://paypal.me/${encodeURIComponent(h)}/${amount.toFixed(2)}USD`;
  if (kind === "cashapp") return `https://cash.app/$${encodeURIComponent(h)}/${amount.toFixed(2)}`;
  return `https://venmo.com/${encodeURIComponent(h)}?txn=pay&amount=${amount.toFixed(2)}&note=${encodeURIComponent(note)}`;
}

function closeOrder(o: any, by: string) {
  exec("update group_orders set status='closed', closed_at=? where id=?", now(), o.id);
  const t = tally({ ...o, status: "closed" });
  emit("ORDER_CLOSED", { workspace_id: o.workspace_id, room_id: o.room_id, actor: by, data: { order_id: o.id, totalQty: t.totalQty, grand_total: t.grand_total } });
  return { ...t, status: "closed", payments: t.perPerson.map((p) => ({ ...p, link: p.user_id === o.organizer_id ? null : payLink(o.payment_handle, p.total, o.title) })) };
}

/** Worker hook: deadline reminders and automatic close — deterministic, no model call. */
export async function checkOrders() {
  let k = 0;
  for (const o of all<any>("select * from group_orders where status='open' and deadline_at is not null")) {
    const send = (text: string) => rt.postMessage(o.room_id, { sender: o.agent_id, text, targets: rt.replyTargets(o.room_id, null) });
    if (now() >= o.deadline_at) { const r = closeOrder(o, o.agent_id); send(extraSummaries["order.close"](r)); k++; }
    // Remind 24h before close — or halfway there for short orders, so a same-day order isn't "24h left" instantly.
    else if (!o.reminded && now() >= o.deadline_at - Math.min(864e5, (o.deadline_at - o.created_at) / 2)) {
      exec("update group_orders set reminded=1 where id=?", o.id);
      send(`⏰ 24h left on "${o.title}". ${extraSummaries["order.status"](tally(o))}`); k++;
    }
  }
  return k;
}

const ORDER_INTENT = /\b(i'?m in|in for \d|put me down|count me in|i'?ll take|add me|make (it|mine) \d|drop me|i'?m out|cancel mine|remove me|take me off|i('ve)? paid|^\s*(just )?paid\b|paid you|sent (you )?(the )?(money|payment)|venmo'?d|who'?s in|tally|how many (are )?we|close the order|lock it in|final call)\b/i;
/** In a room with an open order, order-shaped messages reach the order's agent without an @mention. */
export function orderAgentFor(roomId: string, text: string) {
  if (!ORDER_INTENT.test(text)) return null;
  // An order being opened right now (its run hasn't finished) still catches quick replies.
  const opening = one<any>(`select r.agent_id from runs r where r.room_id=? and r.status not in ('completed','failed_terminal','cancelled') and r.created_at>?
    and (lower(r.objective) like '%group order%' or lower(r.objective) like '%group buy%' or lower(r.objective) like '%bulk order%')`, roomId, now() - 5 * 6e4);
  if (opening && !currentOrder(roomId)) return opening.agent_id as string;
  // After closing, people still report payments and ask the tally for a couple of weeks.
  const o = currentOrder(roomId) ?? one<any>("select * from group_orders where room_id=? and status='closed' and closed_at>? order by closed_at desc limit 1", roomId, now() - 14 * 864e5);
  return o ? (o.agent_id as string) : null;
}

const obj = (props: Record<string, any>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (d?: string) => ({ type: "string", description: d }), num = (d?: string) => ({ type: "number", description: d });
const isOrganizer = (o: any, run: any) => o.organizer_id === run.requested_by || !!one("select 1 from memberships where workspace_id=? and user_id=? and role in ('owner','admin')", o.workspace_id, run.requested_by);
const needOrder = (roomId: string) => currentOrder(roomId) ?? (() => { throw new tools.ToolError("BUSINESS_RULE", "there's no open group order in this chat — start one first"); })();

export function registerOrderTools(def: (d: tools.ToolDef) => void) {
  def({
    id: "order.create", description: "Open a group order in this chat: items with prices, optional minimum total quantity, deadline, organizer's payment handle (venmo:@x / paypal:x / cashapp:x) and shipping fee to split.",
    risk: "write_internal", idempotency: "safe", defaultApproval: "none",
    inputSchema: obj({ title: str(), vendor: str(), items: { type: "array", items: { type: "object", properties: { name: str(), price: num(), unit: str() }, required: ["name", "price"] } },
      min_total_qty: num(), deadline: str("ISO datetime or natural, e.g. 'friday 6pm'"), payment_handle: str(), shipping_fee: num() }, ["title", "items"]),
    async execute(i, ctx) {
      const open = currentOrder(ctx.room.id);
      if (open) throw new tools.ToolError("BUSINESS_RULE", `"${open.title}" is still open — ${rt.nameOf(open.organizer_id)} can close it first`);
      if (!one("select 1 from memberships where workspace_id=? and user_id=?", ctx.run.workspace_id, ctx.run.requested_by))
        throw new tools.ToolError("PERMISSION", "I don't know who you are yet — the organizer should text me directly once (from the agent's Deploy page) so I can recognize them, then open the order");
      const list = (i.items ?? []).filter((x: any) => x.name && Number(x.price) >= 0).map((x: any, k: number) => ({ id: `i${k + 1}`, name: String(x.name).trim(), price: Number(x.price), unit: x.unit }));
      if (!list.length) throw new tools.ToolError("BUSINESS_RULE", "a group order needs at least one item with a price");
      const deadline = i.deadline ? parseDeadline(String(i.deadline)) : null;
      const oid = id("ord");
      exec(`insert into group_orders (id, workspace_id, room_id, agent_id, organizer_id, title, vendor, items, min_total_qty, deadline_at, payment_handle, shipping_fee, status, reminded, created_at)
        values (?,?,?,?,?,?,?,?,?,?,?,?, 'open', 0, ?)`, oid, ctx.run.workspace_id, ctx.room.id, ctx.agent.id, ctx.run.requested_by, i.title, i.vendor ?? null, S(list), i.min_total_qty ?? null,
        deadline, i.payment_handle ?? null, i.shipping_fee ?? 0, now());
      emit("ORDER_OPENED", { workspace_id: ctx.run.workspace_id, room_id: ctx.room.id, run_id: ctx.run.id, actor: ctx.agent.id, data: { order_id: oid, title: i.title } });
      return { status: "SUCCEEDED", output: { order_id: oid, title: i.title, items: list, min_total_qty: i.min_total_qty ?? null, deadline: deadline ? new Date(deadline).toISOString() : null, organizer: rt.nameOf(ctx.run.requested_by) } };
    },
  });
  def({
    id: "order.join", description: "Add, change or remove (qty 0) the requester's own line in the open group order. Only for the person who is speaking.",
    risk: "write_internal", idempotency: "safe", defaultApproval: "none", inputSchema: obj({ item: str("item name, optional if the order has one item"), qty: num(), note: str() }, ["qty"]),
    async execute(i, ctx) {
      const o = needOrder(ctx.room.id), it = matchItem(o, i.item);
      if (!it) throw new tools.ToolError("BUSINESS_RULE", `which item? Options: ${items(o).map((x) => x.name).join(", ")}`);
      const qty = Math.max(0, Math.min(1000, Math.round(Number(i.qty))));
      const u = ctx.run.requested_by;
      const existing = one<any>("select * from order_lines where order_id=? and user_id=? and item_id=?", o.id, u, it.id);
      if (existing) exec("update order_lines set qty=?, note=coalesce(?, note), updated_at=? where id=?", qty, i.note ?? null, now(), existing.id);
      else if (qty > 0) exec("insert into order_lines (id, order_id, user_id, item_id, qty, note, paid, updated_at) values (?,?,?,?,?,?,0,?)", id("oln"), o.id, u, it.id, qty, i.note ?? null, now());
      return { status: "SUCCEEDED", output: { who: rt.nameOf(u), item: it.name, qty, tally: tally(o) } };
    },
  });
  def({
    id: "order.status", description: "Current tally of the open (or most recent) group order: per item, per person, totals, paid status, time left.", risk: "read", idempotency: "safe", defaultApproval: "none", inputSchema: obj({}),
    async execute(_i, ctx) {
      const o = currentOrder(ctx.room.id) ?? one<any>("select * from group_orders where room_id=? order by created_at desc limit 1", ctx.room.id);
      if (!o) throw new tools.ToolError("BUSINESS_RULE", "no group order in this chat yet");
      return { status: "SUCCEEDED", output: tally(o) };
    },
  });
  def({
    id: "order.close", description: "Close the open group order (organizer or admin only) and post per-person totals with pay links.", risk: "write_internal", idempotency: "safe", defaultApproval: "none", inputSchema: obj({}),
    async execute(_i, ctx) {
      const o = needOrder(ctx.room.id);
      if (!isOrganizer(o, ctx.run)) throw new tools.ToolError("PERMISSION", `only ${rt.nameOf(o.organizer_id)} (the organizer) can close this order`);
      return { status: "SUCCEEDED", output: closeOrder(o, ctx.run.requested_by) };
    },
  });
  def({
    id: "order.mark_paid", description: "Mark someone as paid. Members can mark themselves; the organizer can mark anyone by name.", risk: "write_internal", idempotency: "safe", defaultApproval: "none",
    inputSchema: obj({ person: str("name; omit for yourself") }),
    async execute(i, ctx) {
      const o = currentOrder(ctx.room.id) ?? one<any>("select * from group_orders where room_id=? order by created_at desc limit 1", ctx.room.id);
      if (!o) throw new tools.ToolError("BUSINESS_RULE", "no group order in this chat");
      let u = ctx.run.requested_by;
      if (i.person && rt.nameOf(u)?.toLowerCase() !== String(i.person).toLowerCase()) {
        if (!isOrganizer(o, ctx.run)) throw new tools.ToolError("PERMISSION", "only the organizer can mark other people as paid");
        u = all<any>("select distinct user_id from order_lines where order_id=?", o.id).map((r) => r.user_id).find((x) => rt.nameOf(x)?.toLowerCase() === String(i.person).toLowerCase());
        if (!u) throw new tools.ToolError("BUSINESS_RULE", `${i.person} isn't in this order`);
      }
      exec("update order_lines set paid=1 where order_id=? and user_id=?", o.id, u);
      return { status: "SUCCEEDED", output: { who: rt.nameOf(u), paid: true, self_reported: u === ctx.run.requested_by && !isOrganizer(o, ctx.run), tally: tally(o) } };
    },
  });
}

export function parseDeadline(s: string): number | null {
  const iso = Date.parse(s); if (!isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(s)) return iso;
  const d = parseDates(s)[0]; if (!d) return null;
  const t = s.toLowerCase().match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  let h = 18, m = 0; if (t) { h = Number(t[1]) % 12 + (t[3] === "pm" ? 12 : 0); m = Number(t[2] ?? 0); }
  return +new Date(`${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
}

// ---------------- offline planner ----------------
extraPlanners.push((text, c) => {
  if (!c.tools.includes("order.join")) return { steps: [] };
  const t = text.replace(/^@\w+[,:]?\s+|^\w+[,:]\s+/, ""); // drop "@Pool " / "Pool, " — not the first word of "in for 2"
  const lt = t.toLowerCase();
  if (/\b(group (order|buy)|bulk (order|buy)|let'?s (do|start|organi[sz]e) an? (group|bulk|team|big) (order|buy)|start an? (group )?order)\b/.test(lt)) {
    const its = [...t.matchAll(/(?:^|[,;:]|\band\b)\s*([^,;:$]+?)\s*(?:for|at|@|-|—)?\s*\$(\d+(?:\.\d{1,2})?)(?:\s*(?:\/|per|each|a)\s*(\w+))?/g)]
      .map((m) => ({ name: m[1].replace(/.*\b(group|bulk) (order|buy)( of| for)?\s*/i, "").replace(/^(of|for)\s+/i, "").replace(/^\d+\s*(x\s*)?/, "").trim(), price: Number(m[2]), unit: m[3] }))
      .filter((x) => x.name.length > 1);
    return { exclusive: true, steps: [{ name: "order.create", input: {
      title: t.match(/(?:group|bulk) (?:order|buy)(?: of| for)?\s+([^,.$]+?)(?=\s*(?:\$|,|\.|$|—|-|:))/i)?.[1]?.trim() ?? "Group order",
      items: its.length ? its : [{ name: "share", price: 0 }],
      ...(lt.match(/\b(?:min(?:imum)?|need(?: at least)?|at least)\s*(?:of\s*)?(\d+)/) ? { min_total_qty: Number(lt.match(/\b(?:min(?:imum)?|need(?: at least)?|at least)\s*(?:of\s*)?(\d+)/)![1]) } : {}),
      ...(lt.match(/\b(?:by|deadline|closes?|until|before)\s+([^,.;]+)/) ? { deadline: lt.match(/\b(?:by|deadline|closes?|until|before)\s+([^,.;]+)/)![1] } : {}),
      ...(t.match(/\b(venmo|paypal|cash ?app)\s*[:@-]?\s*@?([\w.-]+)/i) ? { payment_handle: `${t.match(/\b(venmo|paypal|cash ?app)\s*[:@-]?\s*@?([\w.-]+)/i)![1].replace(/\s/, "").toLowerCase()}:${t.match(/\b(venmo|paypal|cash ?app)\s*[:@-]?\s*@?([\w.-]+)/i)![2]}` } : {}),
      ...(lt.match(/shipping\s*(?:is|of|=|:)?\s*\$(\d+(?:\.\d+)?)/) ? { shipping_fee: Number(lt.match(/shipping\s*(?:is|of|=|:)?\s*\$(\d+(?:\.\d+)?)/)![1]) } : {}),
    } }] };
  }
  const join = t.match(/\b(?:i'?m in for|in for|put me down for|count me in for|i'?ll take|add me for|i want|me:?)\s+(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|dozen)\b\s*(?:x\s*)?([^.!?]*)/i);
  if (join) return { exclusive: true, steps: [{ name: "order.join", input: { qty: n(join[1]), ...(join[2].trim() ? { item: join[2].trim() } : {}) } }] };
  const make = lt.match(/\bmake (?:it|mine)\s+(\d+|one|two|three|four|five|six)\b\s*([^.!?]*)/);
  if (make) return { exclusive: true, steps: [{ name: "order.join", input: { qty: n(make[1]), ...(make[2].trim() ? { item: make[2].trim() } : {}) } }] };
  if (/\b(drop me|i'?m out|cancel mine|remove me|take me off)\b/.test(lt)) return { exclusive: true, steps: [{ name: "order.join", input: { qty: 0 } }] };
  const paidOther = t.match(/^([A-Z][a-z]+) (?:has )?paid\b/);
  if (paidOther) return { exclusive: true, steps: [{ name: "order.mark_paid", input: { person: paidOther[1] } }] };
  if (/\b(i('ve)? paid|paid you|sent (you )?(the )?(money|payment)|venmo'?d)\b|^\s*(just )?paid\b/.test(lt)) return { exclusive: true, steps: [{ name: "order.mark_paid", input: {} }] };
  if (/\b(close the order|lock it in|final call|that'?s a wrap)\b/.test(lt)) return { exclusive: true, steps: [{ name: "order.close", input: {} }] };
  if (/\b(tally|who'?s in|how many (are )?we|order status|where are we at)\b/.test(lt)) return { exclusive: true, steps: [{ name: "order.status", input: {} }] };
  return { steps: [] };
});

const itemLine = (i: any) => `${i.name} ${money(i.price)}${i.unit ? `/${i.unit}` : ""}`;
extraSummaries["order.create"] = (j) => `🛒 Group order open: ${j.title}\n${j.items.map((i: any) => `• ${itemLine(i)}`).join("\n")}${j.min_total_qty ? `\nMinimum: ${j.min_total_qty} total` : ""}${j.deadline ? `\nCloses ${new Date(j.deadline).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}\nReply like "in for 2${j.items.length > 1 ? ` ${j.items[0].name}` : ""}" — no need to tag me.`;
extraSummaries["order.status"] = (t) => [`${t.title}: ${t.totalQty}${t.min ? `/${t.min}` : ""} ${t.reached ? (t.min ? "✅ minimum reached" : "") : `— ${t.min - t.totalQty} more to go`}`.trim(),
  t.byItem.length > 1 ? t.byItem.filter((i: any) => i.qty).map((i: any) => `• ${i.name}: ${i.qty}`).join("\n") : "",
  t.perPerson.length ? `Who's in: ${t.perPerson.map((p: any) => `${p.name} (${p.lines.map((l: any) => `${l.qty}${t.byItem.length > 1 ? ` ${l.item}` : ""}`).join(", ")})${p.paid ? " ✓" : ""}`).join(", ")}` : "Nobody's in yet."].filter(Boolean).join("\n");
extraSummaries["order.join"] = (j) => `${j.qty ? `Got it, ${j.who}: ${j.qty} × ${j.item}.` : `Removed ${j.who} from ${j.item}.`} ${j.tally.min ? `Now ${j.tally.totalQty}/${j.tally.min}${j.tally.reached ? " ✅" : ""}.` : `Total so far: ${j.tally.totalQty}.`}`;
extraSummaries["order.close"] = (t) => `🔒 "${t.title}" is closed — ${t.totalQty} total${t.min && !t.reached ? ` (short of the ${t.min} minimum — organizer decides)` : ""}.\n${t.payments.map((p: any) => `• ${p.name}: ${money(p.total)}${p.link ? ` → ${p.link}` : " (organizer)"}${p.paid ? " ✓ paid" : ""}`).join("\n")}`;
extraSummaries["order.mark_paid"] = (j) => `✓ ${j.who} marked as paid${j.self_reported ? " (self-reported)" : ""}. ${j.tally.perPerson.filter((p: any) => !p.paid).length} still to pay.`;
