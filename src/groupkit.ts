// Small group-chat tool packs: polls & RSVPs, Splitwise-style expense splitting, shared lists.
// Deterministic state in SQLite; each person's vote/payment is recorded only from their own message. Never moves money.
import { all, one, exec, emit, id, now, S, J } from "./db";
import { extraPlanners, extraSummaries, type Step } from "./model";
import { parseDeadline } from "./orders";
import * as rt from "./runtime";
import * as tools from "./tools";
const obj: typeof tools.obj = (...a) => tools.obj(...a); // read at call time: tools.ts imports this module first

const money = (c: number) => `$${(c / 100).toFixed(2).replace(/\.00$/, "")}`; // cents in, "$12.50" out
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
const splitList = (s: string) => s.split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s*\+\s*/i).map((x) => x.trim()).filter(Boolean);
const str = (d?: string) => ({ type: "string", description: d }), num = (d?: string) => ({ type: "number", description: d });
const strs = (d?: string) => ({ type: "array", items: { type: "string" }, description: d });
const rule = (msg: string): never => { throw new tools.ToolError("BUSINESS_RULE", msg); };
const isAdmin = (ws: string, u: string) => !!one("select 1 from memberships where workspace_id=? and user_id=? and role in ('owner','admin')", ws, u);

/** A participant name ("Sam", "me") → a human in this room. */
function person(roomId: string, name: string, me: string) {
  const n = norm(name);
  if (/^(me|i|myself)$/.test(n)) return me;
  const hits = (f: (x: string) => boolean) => rt.roomHumanIds(roomId).filter((u) => f(norm(rt.nameOf(u) ?? "")));
  const exact = hits((x) => x === n), first = exact.length ? exact : hits((x) => x.split(" ")[0] === n);
  if (first.length > 1) rule(`there's more than one ${name} here — use their full name`);
  return first[0] ?? rule(`I don't see ${name} in this chat`);
}

// ---------------- polls & RSVPs ----------------
type Opt = { id: string; text: string };
export const openPoll = (roomId: string) => one<any>("select * from polls where room_id=? and status='open' order by created_at desc limit 1", roomId);
const opts = (p: any): Opt[] => J(p.options, []);
const RSVP: Record<string, RegExp> = { // apostrophes are gone after norm()
  yes: /^(yes|yep|yeah|im in|count me in|ill be there|im coming|coming|im going|going|in)$/,
  no: /^(no|nope|cant make it|cant come|im out|not coming|not going|out)$/,
  maybe: /^(maybe|not sure|possibly|tbd)$/,
};
const VOTE_PREFIX = /^(?:i(?:'ll| will)? vote(?: for)?|vote(?: for)?|my vote(?: is)?|i pick|i choose)\s*:?\s*/i;

/** Option ids a reply picks: a number, an option's exact text, an RSVP phrase, or (multi) several of those. Loose also accepts partial text. */
export function matchOptions(p: any, raw: string, loose = false): string[] {
  const list = opts(p), t = norm(raw.replace(VOTE_PREFIX, ""));
  const pick = (s: string): string | undefined => {
    if (/^\d+$/.test(s)) return list[Number(s) - 1]?.id;
    const hit = list.find((o) => norm(o.text) === s) ?? list.find((o) => RSVP[norm(o.text)]?.test(s));
    if (hit || !loose || s.length < 3) return hit?.id;
    const part = list.filter((o) => norm(o.text).includes(s) || s.includes(norm(o.text)));
    return part.length === 1 ? part[0].id : undefined;
  };
  if (!t) return [];
  const whole = pick(t);
  if (whole) return [whole];
  const parts = splitList(t.replace(/\s+or\s+/g, ", ")).map(pick);
  return parts.length > 1 && parts.every(Boolean) ? [...new Set(parts as string[])] : [];
}

/** In a room with an open poll, a bare vote ("2", "Saturday", "I vote tacos", "I'm in" for RSVPs) reaches the poll's agent untagged. */
export function pollAgentFor(roomId: string, text: string) {
  const p = text.length <= 60 ? openPoll(roomId) : null;
  return p && matchOptions(p, text).length ? (p.agent_id as string) : null;
}

export function pollResults(p: any) {
  const votes = all<any>("select * from poll_votes where poll_id=? order by updated_at", p.id).map((v) => ({ user: v.user_id, ids: J(v.option_ids, []) as string[] }));
  const options = opts(p).map((o, k) => { const who = votes.filter((v) => v.ids.includes(o.id)).map((v) => rt.nameOf(v.user)); return { n: k + 1, text: o.text, votes: who.length, voters: who }; });
  const top = Math.max(0, ...options.map((o) => o.votes));
  return { poll_id: p.id, question: p.question, status: p.status, multi: !!p.multi, closes_at: p.closes_at ? new Date(p.closes_at).toISOString() : null,
    options, voters: votes.length, leading: top ? options.filter((o) => o.votes === top).map((o) => o.text) : [] };
}

/** People who already answered in the chat (last 24h, before the poll existed) are counted, not asked again. Only their own words count. */
function prefillVotes(p: any, creator: string) {
  const names: string[] = [];
  for (const u of rt.roomHumanIds(p.room_id)) {
    if (u === creator) continue;
    const m = one<any>("select data from events where room_id=? and type='message' and actor=? and ts>=? and ts<? order by seq desc limit 1", p.room_id, u, p.created_at - 864e5, p.created_at);
    const text = String(J(m?.data, {}).text ?? ""); if (!text || text.length > 60) continue;
    const ids = matchOptions(p, text, true); if (!ids.length || (!p.multi && ids.length > 1)) continue;
    exec("insert into poll_votes (poll_id, user_id, option_ids, updated_at) values (?,?,?,?) on conflict (poll_id, user_id) do nothing", p.id, u, S(ids), now());
    names.push(rt.nameOf(u) ?? u);
  }
  return names;
}
function closePoll(p: any, by: string) {
  exec("update polls set status='closed' where id=?", p.id);
  emit("POLL_CLOSED", { workspace_id: p.workspace_id, room_id: p.room_id, actor: by, data: { poll_id: p.id } });
  return pollResults({ ...p, status: "closed" });
}

/** Worker hook: close polls at their deadline and post the result. */
export async function checkPolls() {
  const due = all<any>("select * from polls where status='open' and closes_at is not null and closes_at<=?", now());
  for (const p of due) rt.postMessage(p.room_id, { sender: p.agent_id, text: extraSummaries["poll.close"](closePoll(p, p.agent_id)), targets: rt.replyTargets(p.room_id, null) });
  return due.length;
}

// ---------------- expenses ----------------
const cents = (x: number) => Math.round(Number(x) * 100);
/** Net cents per person: + is owed money, − owes. Splits are cent-exact; the payer absorbs leftover cents. */
export function ledger(roomId: string) {
  const bal = new Map<string, number>(), add = (u: string, c: number) => bal.set(u, (bal.get(u) ?? 0) + c);
  for (const e of all<any>("select * from expenses where room_id=?", roomId)) {
    const among: string[] = J(e.split_among, []), total = cents(e.amount);
    add(e.paid_by, total);
    among.forEach((u, k) => add(u, -(Math.floor(total / among.length) + (k < total % among.length ? 1 : 0))));
  }
  for (const s of all<any>("select * from settlements where room_id=?", roomId)) { add(s.from_user, cents(s.amount)); add(s.to_user, -cents(s.amount)); }
  return bal;
}
/** Greedy largest-debtor → largest-creditor: at most n−1 transfers. */
export function transfers(bal: Map<string, number>) {
  const side = (sign: number) => [...bal].filter(([, c]) => c * sign > 0).map(([u, c]) => ({ u, c: Math.abs(c) })).sort((a, b) => b.c - a.c);
  const debt = side(-1), cred = side(1), out: { from: string; to: string; cents: number }[] = [];
  for (let i = 0, j = 0; i < debt.length && j < cred.length;) {
    const x = Math.min(debt[i].c, cred[j].c);
    out.push({ from: debt[i].u, to: cred[j].u, cents: x });
    if (!(debt[i].c -= x)) i++;
    if (!(cred[j].c -= x)) j++;
  }
  return out;
}
const balances = (roomId: string) => {
  const bal = ledger(roomId);
  return { balances: [...bal].filter(([, c]) => c).sort((a, b) => b[1] - a[1]).map(([u, c]) => ({ name: rt.nameOf(u), cents: c })),
    transfers: transfers(bal).map((t) => ({ from: rt.nameOf(t.from), to: rt.nameOf(t.to), cents: t.cents })),
    expenses: one<any>("select count(*) n, coalesce(sum(amount), 0) s from expenses where room_id=?", roomId) };
};

// ---------------- lists ----------------
const listName = (s?: string) => (s ?? "").toLowerCase().replace(/^(the|our|my)\s+/, "").replace(/\s*list$/, "").trim() || "list";
function findList(roomId: string, name?: string, create = false) {
  const n = name ? listName(name) : null;
  const l = n && n !== "list" ? one<any>("select * from lists where room_id=? and name=?", roomId, n) : one<any>("select * from lists where room_id=? order by created_at desc limit 1", roomId);
  if (l || !create) return l;
  const lid = id("lst");
  exec("insert into lists (id, room_id, name, created_at) values (?,?,?,?)", lid, roomId, n ?? "list", now());
  return one<any>("select * from lists where id=?", lid);
}
const itemKey = (s: string) => norm(s).replace(/^(the|some|a|an|more)\s+/, "").replace(/(es|s)$/, "");
const openItems = (listId: string) => all<any>("select * from list_items where list_id=? and done=0 order by created_at", listId);
const listView = (l: any) => ({ list: l.name, open: openItems(l.id).map((i) => i.text), done: all<any>("select text from list_items where list_id=? and done=1 order by created_at", l.id).map((i) => i.text) });

// ---------------- tools ----------------
export function registerGroupTools(def: (d: tools.ToolDef) => void) {
  const base = { risk: "write_internal" as const, idempotency: "safe" as const, defaultApproval: "none" as const };
  const read = { ...base, risk: "read" as const };

  def({ ...base, id: "poll.create", description: "Start a poll in this chat. For an RSVP use options Yes/No/Maybe. multi lets people pick several. closes: when voting ends (ISO or natural, e.g. 'friday 6pm').",
    inputSchema: obj({ question: str(), options: strs(), multi: { type: "boolean" }, closes: str() }, ["question", "options"]),
    async execute(i, ctx) {
      const seen = new Set<string>();
      const list = (i.options ?? []).map((o: any) => String(o).trim().slice(0, 80)).filter((o: string) => o && !seen.has(norm(o)) && seen.add(norm(o))).slice(0, 10);
      if (list.length < 2) rule("a poll needs at least two options");
      const closes = i.closes ? parseDeadline(String(i.closes)) : null;
      const pid = id("pol"), options = list.map((text: string, k: number) => ({ id: `o${k + 1}`, text }));
      exec(`insert into polls (id, workspace_id, room_id, agent_id, created_by, question, options, multi, status, closes_at, created_at) values (?,?,?,?,?,?,?,?, 'open', ?, ?)`,
        pid, ctx.run.workspace_id, ctx.room.id, ctx.agent.id, ctx.run.requested_by, String(i.question).trim().replace(/^\w/, (x) => x.toUpperCase()).slice(0, 200), S(options), i.multi ? 1 : 0, closes, now());
      emit("POLL_OPENED", { workspace_id: ctx.run.workspace_id, room_id: ctx.room.id, run_id: ctx.run.id, actor: ctx.agent.id, data: { poll_id: pid } });
      const p = one<any>("select * from polls where id=?", pid), already = prefillVotes(p, ctx.run.requested_by);
      return { status: "SUCCEEDED", output: { ...pollResults(p), ...(already.length ? { already_answered: already, note: "These people answered in the chat before the poll existed; their answers are counted — don't ask them again." } : {}) } };
    } });
  def({ ...base, id: "poll.vote", description: "Record the speaker's own vote in the open poll: an option number (1-based) or its text; several for multi-choice polls. Re-voting replaces their vote.",
    inputSchema: obj({ option: str() }, ["option"]),
    async execute(i, ctx) {
      const p = openPoll(ctx.room.id) ?? rule("there's no open poll in this chat");
      const ids = matchOptions(p, String(i.option), true);
      if (!ids.length || (!p.multi && ids.length > 1)) rule(`which one? ${opts(p).map((o, k) => `${k + 1}. ${o.text}`).join("  ")}`);
      exec("insert into poll_votes (poll_id, user_id, option_ids, updated_at) values (?,?,?,?) on conflict (poll_id, user_id) do update set option_ids=excluded.option_ids, updated_at=excluded.updated_at",
        p.id, ctx.run.requested_by, S(ids), now());
      return { status: "SUCCEEDED", output: { who: rt.nameOf(ctx.run.requested_by), choice: opts(p).filter((o) => ids.includes(o.id)).map((o) => o.text), results: pollResults(p) } };
    } });
  def({ ...read, id: "poll.results", description: "Current tally of the open (or most recent) poll in this chat, with who voted for what.", inputSchema: obj({}),
    async execute(_i, ctx) {
      const p = openPoll(ctx.room.id) ?? one<any>("select * from polls where room_id=? order by created_at desc limit 1", ctx.room.id) ?? rule("no polls in this chat yet");
      return { status: "SUCCEEDED", output: pollResults(p) };
    } });
  def({ ...base, id: "poll.close", description: "Close the open poll and announce the result (the poll's creator or a workspace admin only).", inputSchema: obj({}),
    async execute(_i, ctx) {
      const p = openPoll(ctx.room.id) ?? rule("there's no open poll in this chat");
      if (p.created_by !== ctx.run.requested_by && !isAdmin(p.workspace_id, ctx.run.requested_by)) throw new tools.ToolError("PERMISSION", `only ${rt.nameOf(p.created_by)} (who started the poll) can close it`);
      return { status: "SUCCEEDED", output: closePoll(p, ctx.run.requested_by) };
    } });

  def({ ...base, id: "expense.add", description: "Log a shared expense in this chat. paid_by: participant name (default: the speaker). split_among: participant names (default: everyone in the chat). Records only; never moves money.",
    inputSchema: obj({ amount: num(), description: str(), paid_by: str(), split_among: strs() }, ["amount"]),
    async execute(i, ctx) {
      const me = ctx.run.requested_by, c = cents(i.amount);
      if (!(c > 0 && c < 1e8)) rule("the amount should be a positive number");
      const payer = i.paid_by ? person(ctx.room.id, i.paid_by, me) : me;
      const among = [...new Set<string>(i.split_among?.length ? i.split_among.map((n: string) => person(ctx.room.id, n, me)) : rt.roomHumanIds(ctx.room.id))];
      if (among.length < 2 && among[0] === payer) rule("who should I split this with? Name them, or add me to your group chat");
      among.sort((a, b) => +(b === payer) - +(a === payer)); // payer first: they absorb leftover cents
      const eid = id("exp"), desc = String(i.description ?? "").trim().slice(0, 120) || "expense";
      exec("insert into expenses (id, workspace_id, room_id, agent_id, paid_by, amount, description, split_among, created_at) values (?,?,?,?,?,?,?,?,?)",
        eid, ctx.run.workspace_id, ctx.room.id, ctx.agent.id, payer, c / 100, desc, S(among), now());
      emit("EXPENSE_ADDED", { workspace_id: ctx.run.workspace_id, room_id: ctx.room.id, run_id: ctx.run.id, actor: me, data: { expense_id: eid, cents: c } });
      return { status: "SUCCEEDED", output: { expense_id: eid, paid_by: rt.nameOf(payer), cents: c, description: desc,
        split: among.map((u, k) => ({ name: rt.nameOf(u), cents: Math.floor(c / among.length) + (k < c % among.length ? 1 : 0) })) } };
    } });
  def({ ...read, id: "expense.balances", description: "Who owes whom in this chat: net balance per person and the fewest payments to settle up.", inputSchema: obj({}),
    async execute(_i, ctx) { return { status: "SUCCEEDED", output: balances(ctx.room.id) }; } });
  def({ ...base, id: "expense.settle", description: "Record a payment the speaker made to someone (default amount: what the speaker owes them). Records only; never moves money.",
    inputSchema: obj({ with: str("who the speaker paid"), amount: num() }, ["with"]),
    async execute(i, ctx) {
      const me = ctx.run.requested_by, to = person(ctx.room.id, i.with, me);
      if (to === me) rule("you can't pay yourself back");
      const c = i.amount != null ? cents(i.amount) : transfers(ledger(ctx.room.id)).filter((t) => t.from === me && t.to === to).reduce((s, t) => s + t.cents, 0);
      if (!(c > 0 && c < 1e8)) rule(i.amount != null ? "the amount should be a positive number" : `you don't owe ${rt.nameOf(to)} anything right now — say how much you paid`);
      exec("insert into settlements (id, room_id, from_user, to_user, amount, created_at) values (?,?,?,?,?,?)", id("stl"), ctx.room.id, me, to, c / 100, now());
      return { status: "SUCCEEDED", output: { from: rt.nameOf(me), to: rt.nameOf(to), cents: c, ...balances(ctx.room.id) } };
    } });

  def({ ...base, id: "list.add", description: "Add items to a shared list in this chat (groceries, packing, to-buy...). list: its name, e.g. 'grocery' (default: the chat's most recent list).",
    inputSchema: obj({ items: strs(), list: str() }, ["items"]),
    async execute(i, ctx) {
      const l = findList(ctx.room.id, i.list, true), have = new Set(openItems(l.id).map((x) => itemKey(x.text))), added: string[] = [], already: string[] = [];
      for (const raw of (i.items ?? []).flatMap((x: any) => splitList(String(x))).slice(0, 50)) {
        const text = raw.replace(/^(some|more)\s+/i, "").slice(0, 80);
        if (have.has(itemKey(text))) { already.push(text); continue; }
        have.add(itemKey(text)); added.push(text);
        exec("insert into list_items (id, list_id, text, done, added_by, created_at) values (?,?,?,0,?,?)", id("itm"), l.id, text, ctx.run.requested_by, now());
      }
      if (!added.length && !already.length) rule("what should I add?");
      return { status: "SUCCEEDED", output: { added, already, ...listView(l) } };
    } });
  def({ ...base, id: "list.check", description: "Check items off a shared list (bought, packed, done). item: one or several, e.g. 'eggs and milk'.",
    inputSchema: obj({ item: str(), list: str() }, ["item"]),
    async execute(i, ctx) {
      const lists = i.list ? [findList(ctx.room.id, i.list)].filter(Boolean) : all<any>("select * from lists where room_id=? order by created_at desc", ctx.room.id);
      const items = lists.flatMap((l) => openItems(l.id)), hits: any[] = [], missing: string[] = [];
      const find = (q: string, loose = true) => { const k = itemKey(q);
        return items.find((x) => !hits.includes(x) && (itemKey(x.text) === k || (loose && k.length > 2 && (itemKey(x.text).includes(k) || k.includes(itemKey(x.text)))))); };
      for (const q of find(String(i.item), false) ? [String(i.item)] : splitList(String(i.item))) { const h = find(q); if (h) hits.push(h); else missing.push(q); }
      if (!hits.length) rule(`I don't see ${i.item} on ${lists.length === 1 && lists[0].name !== "list" ? `the ${lists[0].name} list` : "the list"}`);
      for (const h of hits) exec("update list_items set done=1 where id=?", h.id);
      return { status: "SUCCEEDED", output: { checked: hits.map((h) => h.text), missing, ...listView(lists.find((l) => l.id === hits[0].list_id)) } };
    } });
  def({ ...read, id: "list.show", description: "Show a shared list (default: every list in this chat).", inputSchema: obj({ list: str() }),
    async execute(i, ctx) {
      const lists = i.list && listName(i.list) !== "list" ? [findList(ctx.room.id, i.list)].filter(Boolean) : all<any>("select * from lists where room_id=? order by created_at", ctx.room.id);
      return { status: "SUCCEEDED", output: { lists: lists.map(listView), asked: i.list ? listName(i.list) : null } };
    } });
  def({ ...base, id: "list.clear", description: "Clear a shared list: everything, or only checked-off items (done_only; without a list name: from every list).", inputSchema: obj({ list: str(), done_only: { type: "boolean" } }),
    async execute(i, ctx) {
      const ls = !i.list && i.done_only ? all<any>("select * from lists where room_id=? order by created_at", ctx.room.id) : [findList(ctx.room.id, i.list)].filter(Boolean);
      if (!ls.length) rule("there's no list to clear");
      const n = ls.reduce((s, l) => s + exec(`delete from list_items where list_id=?${i.done_only ? " and done=1" : ""}`, l.id).changes, 0);
      return { status: "SUCCEEDED", output: { removed: n, done_only: !!i.done_only, lists: ls.map(listView) } };
    } });
}

// ---------------- offline planner ----------------
const AMT = String.raw`\$?\s?(\d+(?:\.\d{1,2})?)`;
function planPolls(t: string, lt: string, c: { roomId?: string }): Step[] {
  if (/\b(close|end|stop|lock|finish)\s+(the\s+)?(poll|vote|voting|rsvps?)\b/.test(lt)) return [{ name: "poll.close", input: {} }];
  if (/\b(poll results|results|who voted|how'?s the (poll|vote)|vote count|tally the votes)\b|^who'?s coming\??$/.test(lt)) return [{ name: "poll.results", input: {} }];
  const mk =t.match(/^(?:(?:make|start|create|run|do|set up)\s+an?\s+)?poll(?:\s+(?:the group|everyone|us|the chat))?\s*(?::|-|—|about|on)\s*(.+)$/i)
    ?? t.match(/\b(?:make|start|create|run|do|set up)\s+an?\s+poll\b\s*(?::|-|—|about|on|for)?\s*(.*)$/i);
  if (mk || /\brsvps?\b/i.test(t)) {
    let body = (mk?.[1] ?? t).replace(/\s*\brsvps?\b[:!.]*/gi, " ").trim();
    const closes = body.match(/[,.;]?\s*\b(?:closes?|voting ends|deadline)\s+(?:at\s+|on\s+)?([^,.;?]+)/i);
    if (closes) body = body.replace(closes[0], "").trim();
    const listed = body.match(/[,.;:]?\s*\boptions?\s*(?:are|:|-)?\s*(.+)$/i);
    let options = listed ? splitList(listed[1].replace(/\s+or\s+/gi, ", ").replace(/[.?!]+$/, "")) : [];
    if (listed) body = body.replace(listed[0], "").trim();
    if (!options.length) options = splitList(body.match(/(?:[\w'-]+(?:,|\s+or)\s+)*[\w'-]+,?\s+or\s+[\w'-]+/i)?.[0].replace(/,?\s+or\s+/gi, ", ") ?? "");
    if (options.length < 2) options = ["Yes", "No", "Maybe"];
    return [{ name: "poll.create", input: { question: body || "Quick poll", options,
      ...(/\b(pick|choose|vote for) (any|all|several|multiple)\b|\bmultiple choice\b/i.test(t) ? { multi: true } : {}), ...(closes ? { closes: closes[1].trim() } : {}) } }];
  }
  const p = c.roomId ? openPoll(c.roomId) : null;
  if (VOTE_PREFIX.test(t) && t.replace(VOTE_PREFIX, "").trim()) return [{ name: "poll.vote", input: { option: t.replace(VOTE_PREFIX, "").trim() } }];
  if (p && matchOptions(p, t).length) return [{ name: "poll.vote", input: { option: t } }];
  return [];
}
function planExpenses(t: string, lt: string): Step[] {
  const settle = t.match(new RegExp(String.raw`\b(?:paid|sent|venmo'?d|zelle'?d|gave|repaid)\s+(?!(?:for|the|a|an|my|our|it|off|up|in|back|me|you|us)\b)([a-z]+)(?:\s+back)?(?:\s+${AMT})?(?=[\s.!]|$)`, "i"));
  if (settle && (/\bback\b/i.test(t) || (settle[2] && /^[A-Z]/.test(settle[1])))) return [{ name: "expense.settle", input: { with: settle[1], ...(settle[2] ? { amount: Number(settle[2]) } : {}) } }];
  const su = t.match(/\bsettled? up with ([a-z]+)\b/i);
  if (su) return [{ name: "expense.settle", input: { with: su[1] } }];
  const add = t.match(new RegExp(String.raw`(?:^|\s)(I|i|[A-Z][a-z]+)\s+(?:just\s+)?(?:paid|spent|covered|put down)\s+${AMT}\b(.*)$`));
  if (add) {
    const split = add[3].match(/[,;]?\s*\bsplit\s+(?:it\s+)?(?:(?:evenly|equally)\s+)?(?:\d+\s+ways\s*)?(?:(with|between|among)\s+(.+?))?[.!?]*$/i);
    const desc = (split ? add[3].replace(split[0], "") : add[3]).replace(/^\s*(?:dollars|bucks)?\s*(?:for|on)?\s*(?:the\s+)?/i, "").replace(/[,.!?\s]+$/, "").trim();
    let among = split?.[2] && !/\b(everyone|all|the group|us all)\b/i.test(split[2]) ? splitList(split[2]) : undefined;
    const payer = /^i$/i.test(add[1]) ? "me" : add[1];
    if (among && split![1].toLowerCase() === "with" && !among.some((n) => norm(n) === norm(payer))) among = [payer, ...among];
    return [{ name: "expense.add", input: { amount: Number(add[2]), description: desc || "expense", ...(payer !== "me" ? { paid_by: payer } : {}), ...(among ? { split_among: among } : {}) } }];
  }
  if (/\b(who owes|balances?|settle up|where do we stand|how much do i owe|what do i owe|owe)\b/.test(lt)) return [{ name: "expense.balances", input: {} }];
  return [];
}
function planLists(t: string, lt: string): Step[] {
  const add = t.match(/\b(?:add|put)\s+(.+?)\s+(?:to|on)\s+(?:the |our |my )?([\w' -]*?)\s*list\b/i);
  if (add) return [{ name: "list.add", input: { items: splitList(add[1]), ...(add[2].trim() ? { list: add[2].trim() } : {}) } }];
  const out = t.match(/\bwe(?:'re| are) (?:out of|low on)\s+(.+?)[.!]*$/i);
  if (out) return [{ name: "list.add", input: { items: splitList(out[1]) } }];
  const clear = lt.match(/\b(?:clear|empty|reset|wipe)\s+(?:out\s+)?(?:the |our |my )?([\w' -]*?)\s*list\b/) ?? lt.match(/\b(?:clear|remove)\s+(?:the |all )?(?:done|checked|checked-off|bought) (?:items|stuff|things)\b/);
  if (clear) return [{ name: "list.clear", input: { ...(clear[1]?.trim() ? { list: clear[1].trim() } : {}), ...(/\b(done|checked|bought)\b/.test(lt) ? { done_only: true } : {}) } }];
  if (/\b(what'?s on|show(?: me)?|read(?: me)?|see|send(?: me)?) (?:the |our |my )?[\w' -]*?\s*list\b|\bwhat do we (?:still )?need\b|^(?:the )?[\w-]*\s*list\??$/i.test(t))
    return [{ name: "list.show", input: lt.match(/(?:the |our |my )([\w' -]+?)\s*list\b/)?.[1] ? { list: lt.match(/(?:the |our |my )([\w' -]+?)\s*list\b/)![1] } : {} }];
  const chk = t.match(/^(?:i\s+|we\s+)?(?:got|bought|picked up|grabbed|packed|check(?:ed)? off|cross(?:ed)? off|remove|delete)\s+(?:the\s+|some\s+)?(.+?)(?:\s+(?:from|off|on)\s+(?:the\s+)?([\w' -]*?)\s*list)?[.!]*$/i);
  if (chk && !/\$\s?\d/.test(t)) return [{ name: "list.check", input: { item: chk[1], ...(chk[2]?.trim() ? { list: chk[2].trim() } : {}) } }];
  return [];
}
extraPlanners.push((text, c) => {
  const has = (n: string) => c.tools.includes(n);
  const t = text.replace(new RegExp(`^@?${c.agentName.replace(/[^\w]/g, "")}\\b[,:]?\\s*`, "i"), "").trim(), lt = t.toLowerCase();
  const steps = [...(has("poll.vote") ? planPolls(t, lt, c) : []), ...(has("expense.add") ? planExpenses(t, lt) : []), ...(has("list.add") ? planLists(t, lt) : [])];
  return { exclusive: true, steps: steps.slice(0, 1) };
});

// ---------------- chat summaries ----------------
const numbered = (r: any, tally = true) => r.options.map((o: any) => `${o.n}. ${o.text}${tally && o.votes ? ` — ${o.votes} (${o.voters.join(", ")})` : ""}`).join("\n");
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
extraSummaries["poll.create"] = (r) => `📊 ${r.question}\n${numbered(r, false)}${r.multi ? "\n(pick as many as you like)" : ""}${r.closes_at ? `\nVoting closes ${when(r.closes_at)}` : ""}\nReply with a number — no need to tag me.`;
extraSummaries["poll.vote"] = (j) => `✓ ${j.who}: ${j.choice.join(", ")}. ${j.results.options.filter((o: any) => o.votes).map((o: any) => `${o.text} ${o.votes}`).join(" · ")}`;
extraSummaries["poll.results"] = (r) => `📊 ${r.question}${r.status === "closed" ? " (closed)" : ""}\n${numbered(r)}\n${r.voters ? `${r.voters} voted${r.leading.length ? ` · ${r.status === "closed" ? "result" : "leading"}: ${r.leading.join(" & ")}` : ""}` : "No votes yet."}`;
extraSummaries["poll.close"] = (r) => `🔒 Poll closed: ${r.question}\n${numbered(r)}\n${!r.leading.length ? "No votes." : r.leading.length > 1 ? `Tie: ${r.leading.join(" & ")}` : `Winner: ${r.leading[0]}`}`;

const settleLines = (j: any) => j.transfers.length ? `To settle up:\n${j.transfers.map((t: any) => `• ${t.from} pays ${t.to} ${money(t.cents)}`).join("\n")}` : "All settled up ✅";
extraSummaries["expense.add"] = (j) => { const even = j.split.every((s: any) => s.cents === j.split.at(-1).cents);
  return `💸 ${j.paid_by} paid ${money(j.cents)} for ${j.description} — split ${j.split.length} ways (${even ? `${money(j.split[0].cents)} each: ${j.split.map((s: any) => s.name).join(", ")}` : j.split.map((s: any) => `${s.name} ${money(s.cents)}`).join(", ")}).`; };
extraSummaries["expense.balances"] = (j) => !j.expenses.n ? "No expenses yet. Tell me like \"I paid $60 for gas\"." :
  `${j.balances.length ? j.balances.map((b: any) => `• ${b.name} ${b.cents > 0 ? `is owed ${money(b.cents)}` : `owes ${money(-b.cents)}`}`).join("\n") : ""}\n${settleLines(j)}`.trim();
extraSummaries["expense.settle"] = (j) => `✓ Recorded: ${j.from} paid ${j.to} ${money(j.cents)}.\n${settleLines(j)}`;

const title = (n: string) => (n === "list" ? "The list" : `The ${n} list`);
const showOne = (v: any) => !v.open.length && !v.done.length ? `${title(v.list)} is empty.` : `📝 ${title(v.list)}:\n${v.open.map((x: string) => `• ${x}`).join("\n")}${v.done.length ? `${v.open.length ? "\n" : ""}✓ ${v.done.join(", ")}` : ""}`;
extraSummaries["list.add"] = (j) => `📝 ${j.added.length ? `Added ${j.added.join(", ")}` : "Nothing new"}${j.already.length ? ` (already on it: ${j.already.join(", ")})` : ""}. ${title(j.list)} has ${j.open.length} item${j.open.length === 1 ? "" : "s"}.`;
extraSummaries["list.check"] = (j) => `✓ Checked off ${j.checked.join(", ")}${j.missing.length ? ` (couldn't find ${j.missing.join(", ")})` : ""}. ${j.open.length ? `Still need: ${j.open.join(", ")}` : `${title(j.list)} is all done 🎉`}`;
extraSummaries["list.show"] = (j) => j.lists.length ? j.lists.map(showOne).join("\n\n") : `${j.asked ? title(j.asked) : "The list"} is empty.`;
extraSummaries["list.clear"] = (j) => `🧹 Cleared ${j.removed} ${j.done_only ? "checked-off " : ""}item${j.removed === 1 ? "" : "s"}.${j.lists.length === 1 ? ` ${j.lists[0].open.length ? `Still on ${title(j.lists[0].list).toLowerCase()}: ${j.lists[0].open.join(", ")}` : `${title(j.lists[0].list)} is empty.`}` : ""}`;
