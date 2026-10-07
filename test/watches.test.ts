// Website availability watches: look on a schedule (fast around the drop), act or notify the moment something's there,
// never twice for the same opening, stop when the window passes, pause after a "no".
import { test, expect, beforeEach } from "bun:test";
import { one, all, J, advance, now } from "../src/db";
import * as rt from "../src/runtime";
import { checkSiteWatches, parseCheck, checkTask } from "../src/watches";
import { setup, user, workspace, customAgent, installAgent, say, scriptModel, call, runsIn, lastFrom, events, pendingApprovals } from "./helpers";

let ellie: string, ws: string;
beforeEach(() => { setup(); ellie = user("Ellie"); ws = workspace("Home", ellie); });

test("AC-W1 a watch is set from chat with what/where/when/limits; checks run every 30s around the opening; a hit tells the person once with the link", async () => {
  const b = installAgent("booker-bookings", ws, ellie);
  const room = rt.privateRoomFor(ellie, b);
  const opens = new Date(now() + 2 * 3600e3).toISOString();
  scriptModel(call("watch.site", { what: "Knicks presale, 2 tickets", url: "https://www.ticketmaster.com/knicks", opens_at: opens, max_price: 150, quantity: 2 }), { text: "Watching — I'll text you the moment they're up." });
  await say(room.id, ellie, "watch ticketmaster for Knicks presale tickets, 2 under $150, opens in two hours");
  const w = one<any>("select * from site_watches where room_id=?", room.id);
  expect(w).toMatchObject({ site: "ticketmaster.com", what: "Knicks presale, 2 tickets", max_price: 150, quantity: 2, action: "notify", status: "active" });
  expect(w.next_check_at).toBe(Date.parse(opens) - 60_000);                 // first look a minute before it opens
  expect(checkTask(w)).toMatch(/Look only — do not add to cart[\s\S]*AVAILABLE: yes\|no \| PRICE/);

  // Not yet open: nothing happens before the first check time
  const looks: number[] = [];
  const look = async () => { looks.push(now()); return "AVAILABLE: no | PRICE: n/a | DETAIL: presale not started"; };
  await checkSiteWatches(look);
  expect(looks).toHaveLength(0);
  advance(2 * 3600e3 - 30_000); await checkSiteWatches(look);
  expect(looks).toHaveLength(1);
  const after = one<any>("select next_check_at, checks from site_watches where id=?", w.id);
  expect(after.checks).toBe(1); expect(after.next_check_at - now()).toBeGreaterThan(29_000); expect(after.next_check_at - now()).toBeLessThanOrEqual(30_000); // 30s cadence around the drop

  // It opens: the person is told once, with the link; the same opening isn't offered again
  advance(30_000);
  scriptModel({ text: "They're up — $120 each: https://www.ticketmaster.com/knicks. Want me to grab 2?" });
  await checkSiteWatches(async () => "AVAILABLE: yes | PRICE: $120 | DETAIL: Sec 212 pairs at $120");
  await rt.drain();
  expect(events("WATCH_HIT").map((e) => e.data)).toEqual([expect.objectContaining({ site: "ticketmaster.com", price: 120, action: "notify" })]);
  expect(lastFrom(room.id, b.id)).toMatch(/They're up — \$120 each/);
  // Over the price cap: no hit
  advance(30_000);
  await checkSiteWatches(async () => "AVAILABLE: yes | PRICE: $210 | DETAIL: only floor seats left");
  expect(events("WATCH_HIT")).toHaveLength(1);
});

test("AC-W2 action='act' hands the agent a pre-planned browser step that needs approval; a 'no' pauses the watch; the window passing expires it", async () => {
  const b = installAgent("booker-bookings", ws, ellie);
  const room = rt.privateRoomFor(ellie, b);
  scriptModel(call("watch.site", { what: "Hotel Riverside Alfama, Nov 12-15", url: "https://www.booking.com/hotel/pt/riverside-alfama.html", until: new Date(now() + 3 * 864e5).toISOString(), every_minutes: 60, max_price: 200, action: "act" }), { text: "Watching." });
  await say(room.id, ellie, "watch booking.com for a room at Hotel Riverside Alfama Nov 12-15 under $200 and book it when one opens");
  const w = one<any>("select * from site_watches where room_id=?", room.id);
  expect(w).toMatchObject({ action: "act", every_min: 60 });
  expect(w.checks).toBe(1);                                                     // the worker looked right away (read-only), nothing there yet
  advance(3600e3);
  await checkSiteWatches(async () => "AVAILABLE: yes | PRICE: $176 | DETAIL: Superior room, 3 nights");
  await rt.drain();
  const apr = pendingApprovals(room.id)[0];
  expect(apr).toMatchObject({ tool_id: "browser.task" });
  expect(J(apr.input)).toMatchObject({ site: "booking.com", start_url: w.url });
  expect(J(apr.input).task).toMatch(/Hotel Riverside Alfama, Nov 12-15[\s\S]*at or under \$200[\s\S]*Complete the purchase or booking/);
  // She says no → paused, not re-asked next check
  await say(room.id, ellie, "reject");
  advance(3600e3); await checkSiteWatches(async () => "AVAILABLE: yes | PRICE: $176 | DETAIL: still there");
  expect(one<any>("select status from site_watches where id=?", w.id).status).toBe("paused");
  expect(lastFrom(room.id, b.id)).toMatch(/Paused watching booking\.com/);
  // Resume by words, then the window passes
  scriptModel(call("watch.cancel", { watch: "Riverside", resume: true }), { text: "Back on it." });
  await say(room.id, ellie, "keep watching the Riverside");
  expect(one<any>("select status from site_watches where id=?", w.id).status).toBe("active");
  advance(4 * 864e5); await checkSiteWatches(async () => "AVAILABLE: no | PRICE: n/a | DETAIL: sold out");
  expect(one<any>("select status from site_watches where id=?", w.id).status).toBe("expired");
  expect(lastFrom(room.id, b.id)).toMatch(/Stopped watching booking\.com/);
  expect(parseCheck("blah\nAVAILABLE: yes | PRICE: $1,250.00 | DETAIL: two seats")).toEqual({ available: true, price: 1250, detail: "two seats" });
});
