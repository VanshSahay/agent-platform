import { describe, expect, test } from "bun:test";
import { callTool, reply, toolCallsSoFar } from "../src/model/scripted.ts";
import { recordSpend } from "../src/runtime/spend.ts";
import { groupWorld, repliesTo } from "./helpers.ts";
import { FakeGoogle, type FakePublicRates, FakeSlack } from "../src/tools/hands.ts";
import { freeSlots } from "../src/tools/catalog/google.ts";
import { TOOLS } from "../src/tools/registry.ts";
import { type BookingRow, type KestrelRow, parseBooking, parseBookingRows, parseKestrel, sellerSearchUrl } from "../src/tools/providers/public-rates.ts";
import { hotelKey } from "../src/tools/catalog/hotels.ts";

/** A scripted model that calls one tool once, then replies. */
const once =
  (name: string, input: unknown, text = "Done.") =>
  (req: Parameters<typeof toolCallsSoFar>[0]) =>
    toolCallsSoFar(req).some((c) => c.name === name) ? reply(text) : callTool(name, input);

describe("the catalogue", () => {
  test("matches Fo's tool names, less the twins of core tools and the unsandboxed code runner, plus ours", () => {
    const names = new Set(TOOLS.map((t) => t.spec.name));
    const fo = [
      "list_events",
      "create_calendar",
      "check_availability",
      "find_mutual_availability",
      "create_event",
      "update_event",
      "delete_event",
      "move_events",
      "search_emails",
      "get_email_content",
      "label_email",
      "archive_email",
      "remove_email_label",
      "send_email_as_user",
      "find_files",
      "list_in_folder",
      "get_metadata",
      "share",
      "create_form",
      "get_spreadsheet",
      "update_spreadsheet",
      "search_user_spreadsheets",
      "get_slide_thumbnail",
      "append_slides",
      "replace_slide",
      "delete_slide",
      "get_connect_link",
      "request_call",
      "list_tasks",
      "get_task",
      "schedule_action",
      "list_scheduled_actions",
      "cancel_scheduled_action",
      "update_task_status",
      "browser_use",
      "wait_for_user_input",
      "connector_call",
      "get_current_time",
      "search_tools",
      "publish_dashboard",
      "read_dashboard",
      "list_past_sessions",
      "get_session_transcript",
      "load_workspace_context",
      "search_memory",
      "present_files",
      "write_document",
      "generate_image",
      "analyze_image",
      "load_soul_document",
      "email_load_thread",
      "email_load_unprocessed",
      "slack_load_recent",
      "slack_load_aggregates",
      "slack_search_messages",
      "whatsapp_load_recent",
      "whatsapp_load_conversation",
      "whatsapp_get_summary",
      "web_search",
      "search_products",
      "add_to_cart",
      "view_cart",
      "remove_from_cart",
      "checkout_cart",
      "save_address",
      "list_saved_addresses",
      "delete_saved_address",
      "text_to_speech",
      "send_sms",
      "register_pronunciations",
      "list_sms_groups",
      "place_call",
      "add_contact",
      "mcp_call",
    ];
    const missing = fo.filter((n) => !names.has(n));
    expect(missing).toEqual([]);
    expect(names.has("send_agent_email")).toBe(true); // Fo's send_wajo_email
    expect(fo.length + 1).toBe(75);
    expect(new Set(TOOLS.map((t) => t.spec.name)).size).toBe(TOOLS.length); // no duplicate names
  });

  test("hotel_compare puts our price next to the cheapest public one per hotel, savings first, on a shared page", async () => {
    process.env.HOTEL_MARKUP_PCT = "10";
    process.env.HOTEL_SITE_URL = "https://shop.example";
    const w = groupWorld(
      once("hotel_compare", { city: "Barcelona", countryCode: "ES", checkIn: "2026-12-01", checkOut: "2026-12-03", limit: 5 }, "Nouvel is $264 with us vs $343 on Booking."),
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip compare hotels in Barcelona Dec 1-3 for 2" });
    const call = w.app.store.toolCallsForRun(run!.id)[0]!;
    expect(call.status).toBe("done");
    expect(call.evidence).toBe("fake-hotels:1+fake-public-rates:1");
    // The public side is asked for the star classes of the hotels we are about to show, so Google's list covers them.
    expect((w.app.hands.publicRates as FakePublicRates).queries[0]!.classes).toEqual([3, 4]);
    expect((w.app.hands.publicRates as FakePublicRates).queries[0]!.names).toEqual(["Hotel Nouvel", "Catalonia Avinyó", "Leonardo Las Ramblas"]);
    const r = call.result as { rows: string[]; matched: number; bookThroughUs: string; page: string };
    // Nouvel: $239.55 net + 10% = $264 against $343 on Booking; Catalonia (accent and no "Avinyó" in the public name) still matches at $292 vs $290 on Agoda.
    expect(r.rows[0]).toContain(
      "Hotel Nouvel 3★: through us $264 (refundable) · public $343 on Booking.com (all-in, refundable) · save $79 (23%) with us · Super.com lists $290 before taxes & fees",
    );
    expect(r.rows[1]).toContain("Catalonia Avinyó 4★: through us $292 · public $290 on Agoda (before taxes & fees) · $2 cheaper there");
    expect(r.rows[2]).toContain("no public price found");
    expect(r.matched).toBe(2);
    expect(r.bookThroughUs).toBe("https://shop.example/hotels?name=Barcelona&checkin=2026-12-01&checkout=2026-12-03&rooms=1&adults=2&currency=USD");
    const page = w.app.store.listArtifacts(w.app.store.listAgents("alex")[0]!.id, { roomId: w.room.id }).find((a) => a.kind === "hotels")!;
    expect(page.title).toBe("Hotels: Barcelona, 2026-12-01 to 2026-12-03");
    const data = page.data as { rows: { name: string; oursUsd: number; pub?: { seller: string } }[]; bookUrl: string; nights: number };
    expect(data.rows.map((x) => [x.name, x.oursUsd, x.pub?.seller])).toEqual([
      ["Hotel Nouvel", 264, "Booking.com"],
      ["Catalonia Avinyó", 292, "Agoda"],
      ["Leonardo Las Ramblas", 339, undefined],
    ]);
    expect(data.nights).toBe(2);
    expect(w.app.store.listAttention({ roomId: w.room.id })).toHaveLength(0);
    // A second ask for the same stay within twelve hours reuses the public prices instead of paying Google again.
    const again = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "@pip compare hotels in Barcelona Dec 1-3 for 2" });
    const second = w.app.store.toolCallsForRun(again!.id)[0]!;
    expect(second.evidence).toBe("fake-hotels:2+fake-public-rates:1:cached");
    expect((w.app.hands.publicRates as FakePublicRates).queries).toHaveLength(1);
    delete process.env.HOTEL_MARKUP_PCT;
    delete process.env.HOTEL_SITE_URL;
  });

  test("Google Hotels rows become one public offer per hotel: the cheapest major seller made all-in with Google's tax estimate, a discount reseller's lower before-tax figure noted", () => {
    const rows: KestrelRow[] = [
      {
        type: "hotel",
        hotel_id: "h1",
        name: "Alpes Hôtel du Pralong",
        total_base: 5866.68,
        taxes: 586.53,
        fees: 44.6,
        total_with_taxes: 6497.81,
        website: "https://alpeshoteldupralong.com/",
      },
      {
        type: "offer",
        hotel_id: "h1",
        name: "Alpes Hôtel du Pralong",
        source: "Alpes Hôtel du Pralong",
        official: true,
        total: 7883.21,
        link: "https://www.google.com/travel/lodging/clk?a",
      },
      {
        type: "offer",
        hotel_id: "h1",
        name: "Alpes Hôtel du Pralong",
        source: "Super.com",
        official: false,
        total: 5911.28,
        partner_url: "https://www.super.com/travel/transition/?checkin_at=2027-01-13",
      },
      { type: "offer", hotel_id: "h1", name: "Alpes Hôtel du Pralong", source: "Booking.com", official: false, total: 8925.83, free_cancel: true },
      { type: "status", hotels: 1 } as KestrelRow,
    ];
    expect(parseKestrel(rows)).toEqual([
      {
        // Google's estimate for this hotel is 10% tax plus $44.60 fees: the official site's 7,883 before tax is 8,716 all-in, still under Booking's listed 8,926.
        name: "Alpes Hôtel du Pralong",
        totalUsd: 8716,
        seller: "Official site",
        refundable: false,
        url: "https://www.google.com/travel/lodging/clk?a",
        allIn: true,
        taxesEstimated: true,
        listedBelow: { seller: "Super.com", totalUsd: 5911, url: "https://www.super.com/travel/transition/?checkin_at=2027-01-13" },
      },
    ]);
  });

  test("past the daily cap on public lookups, hotel_compare still prices our side and says the public column is paused", async () => {
    process.env.PUBLIC_RATES_DAILY_CAP_USD = "0.05";
    const w = groupWorld(once("hotel_compare", { city: "Barcelona", countryCode: "ES", checkIn: "2026-12-01", checkOut: "2026-12-03" }, "Here."));
    recordSpend(w.app.store.db, { provider: "apify", usd: 0.06, units: "booking run", at: new Date(w.clock.now()).toISOString() });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip compare hotels in Barcelona Dec 1-3" });
    const call = w.app.store.toolCallsForRun(run!.id)[0]!;
    const r = call.result as { matched: number; publicError?: string; rows: string[] };
    expect(r.matched).toBe(0);
    expect(r.publicError).toContain("paused for today");
    expect(r.rows[0]).toContain("through us $240");
    expect((w.app.hands.publicRates as FakePublicRates).queries).toHaveLength(0);
    delete process.env.PUBLIC_RATES_DAILY_CAP_USD;
  });

  test("Booking.com rows become all-in offers: the stay total plus what Booking lists as paid on top; unknown names and sold-out rooms are skipped", () => {
    const rows: BookingRow[] = [
      {
        type: "hotel",
        name: "Snow Lodge Hotel Courchevel 1850",
        url: "https://www.booking.com/hotel/fr/snow-lodge.html",
        room_name: "Suite 303",
        price_total: 12899.52,
        taxes_fees_excluded: 34.49,
        free_cancellation: true,
      },
      { type: "status", hotel_name: "Snow Lodge Hotel Courchevel 1850", error: null },
      { type: "status", hotel_name: null, error: "ValueError: Booking.com autocomplete has no hotel named 'Les 3 Vallées'" },
      { type: "hotel", name: "Le Lana", price_total: 30233.25, taxes_fees_excluded: 35.47, sold_out: true },
    ];
    expect(parseBookingRows(rows)).toEqual([
      {
        name: "Snow Lodge Hotel Courchevel 1850",
        totalUsd: 12934,
        seller: "Booking.com",
        refundable: true,
        url: "https://www.booking.com/hotel/fr/snow-lodge.html",
        allIn: true,
        room: "Suite 303",
      },
    ]);
  });

  test("public hotel links carry the dates on sellers that take them in the URL", () => {
    const q = { city: "Courchevel", countryCode: "FR", checkIn: "2027-01-13", checkOut: "2027-01-17", adults: 2 };
    expect(sellerSearchUrl("Booking.com", "Le Saint Joseph", q)).toBe(
      "https://www.booking.com/searchresults.html?ss=Le%20Saint%20Joseph%2C%20Courchevel&checkin=2027-01-13&checkout=2027-01-17&group_adults=2&no_rooms=1&group_children=0&selected_currency=USD",
    );
    expect(sellerSearchUrl("Expedia.com", "Le Lana", q)).toContain("startDate=2027-01-13&endDate=2027-01-17&adults=2");
    expect(sellerSearchUrl("Super.com", "Le Lana", q)).toBeUndefined();
  });

  test("Booking.com's results page parses into one total per hotel, in-area only", () => {
    const text = [
      "Courchevel: 13 properties found",
      "Le Saint Joseph",
      "Opens in new window",
      "Courchevel 1850",
      "Breakfast included",
      "Free cancellation",
      "Per night$1,336",
      "$6,678",
      "Price $6,678",
      "5 nights, 2 adults",
      "See availability",
      "Hotel Le Carlina Courchevel 1850",
      "Opens in new window",
      "Superior Queen Room",
      "Per night$1,504",
      "$8,082$7,521",
      "Original price $8,082. Current price $7,521.",
      "Price $7,521",
      "5 nights, 2 adults",
      "Looking for more options?",
      "Hotel Le Coucou Méribel",
      "Opens in new window",
      "Méribel",
      "Price $6,384",
      "5 nights, 2 adults",
    ].join("\n");
    expect(parseBooking(text)).toEqual([
      { name: "Le Saint Joseph", totalUsd: 6678, seller: "Booking.com", refundable: true, url: "https://www.booking.com", allIn: true },
      { name: "Hotel Le Carlina Courchevel 1850", totalUsd: 7521, seller: "Booking.com", refundable: false, url: "https://www.booking.com", allIn: true },
    ]);
    expect(hotelKey("Hôtel Le K2 Altitude")).toBe(hotelKey("Hotel Le K2 Altitude"));
  });

  test("flight_compare matches itineraries by flight numbers and says where each side wins or is missing", async () => {
    const w = groupWorld(once("flight_compare", { origin: "lax", destination: "JFK", date: "2026-12-06", cabin: "business" }, "AA3177 is the same price both ways."));
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip business class LAX to JFK Dec 6" });
    const call = w.app.store.toolCallsForRun(run!.id)[0]!;
    expect(call.status).toBe("done");
    expect(call.evidence).toBe("fake-flights:1+fake-public-flights:1");
    expect(w.hands.flights.queries[0]).toMatchObject({ origin: "LAX", destination: "JFK", cabin: "business", adults: 1 });
    const r = call.result as { rows: string[]; matched: number; oursOnly: number; publicOnly: number };
    expect(r.matched).toBe(2);
    expect(r.publicOnly).toBe(1);
    expect(r.rows[0]).toBe("American AA3177 > AA1796 · 23:55–10:09 · 7h14 · 1 stop · through us $787 (First, bag included) · public $788 on American · same price");
    expect(r.rows[1]).toContain("AA4 · 06:30–14:59 · 5h29 · nonstop · through us $1,950 (First, bag included) · public $2,099 on American · save $149 with us");
    expect(r.rows[2]).toContain("Delta DL1 · 06:15–14:31 · 5h16 · nonstop · not in our inventory · public $3,849 on Delta");
    const page = w.app.store.listArtifacts(w.app.store.listAgents("alex")[0]!.id, { roomId: w.room.id }).find((a) => a.kind === "flights")!;
    expect(page.title).toBe("Flights: LAX to JFK, 2026-12-06");
    expect(w.app.store.listAttention({ roomId: w.room.id })).toHaveLength(0);
  });

  test("hotel_rates lists the wholesale source's offers cheapest first, net next to public, with evidence and no gate", async () => {
    const w = groupWorld(once("hotel_rates", { city: "Barcelona", countryCode: "es", checkIn: "2026-12-01", checkOut: "2026-12-03" }, "Hotel Nouvel is $240 net vs $275 public."));
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip hotel in Barcelona Dec 1-3?" });
    const calls = w.app.store.toolCallsForRun(run!.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe("done");
    expect(calls[0]!.evidence).toBe("fake-hotels:1");
    expect(w.hands.hotels.searches[0]).toEqual({ city: "Barcelona", checkIn: "2026-12-01", checkOut: "2026-12-03" });
    const out = String(calls[0]!.result);
    expect(out.indexOf("Hotel Nouvel")).toBeLessThan(out.indexOf("Catalonia"));
    expect(out).toContain("$240 net vs $275 public");
    expect(out).toContain("+ $34 paid at the hotel");
    expect(w.app.store.listAttention({ roomId: w.room.id })).toHaveLength(0);
  });

  test("free slots skip busy blocks and keep working hours", () => {
    const day = Date.UTC(2026, 9, 14, 0, 0, 0); // midnight UTC
    const h = (x: number) => day + x * 3600_000;
    const slots = freeSlots([{ start: h(10), end: h(11) }], { start: h(0), end: h(24) }, 60, { start: 9, end: 12 }, "UTC");
    expect(slots.map((x) => [new Date(x.start).getUTCHours(), new Date(x.end).getUTCHours()])).toEqual([
      [9, 10],
      [11, 12],
    ]);
  });

  test("a Google tool on your own account just runs; on someone else's it asks them", async () => {
    const google = new FakeGoogle(() => ({ id: "evt_1", htmlLink: "https://calendar.google.com/evt_1" }));
    const w = groupWorld(once("create_event", { title: "Cabin check-in", start: "2026-11-20T15:00:00Z", end: "2026-11-20T16:00:00Z" }), { google });
    w.app.vault.put("alex", "google", JSON.stringify({ refresh_token: "r" }));
    const own = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip put the check-in on my calendar" });
    expect(own?.status).toBe("done");
    expect(google.requests[0]!.url).toContain("/calendars/primary/events");
    expect(w.app.store.toolCallsForRun(own!.id)[0]!.evidence).toBe("google:event:evt_1");
    // Riley is a guest: the event would land on Alex's calendar, so Alex is asked first.
    const guest = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip put the check-in on the calendar" });
    expect(guest?.status).toBe("waiting");
    expect(w.app.attention.openFor("alex")[0]!.kind).toBe("guest_request");
    expect(google.requests).toHaveLength(1);
  });

  test("Google tools say so when the account is not connected", async () => {
    const w = groupWorld(once("list_events", {}, "Not connected."));
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip what's on my calendar?" });
    const call = w.app.store.toolCallsForRun(run!.id)[0]!;
    expect(call.status).toBe("failed");
    expect(String(call.result)).toContain("Google is not connected");
  });

  test("Slack tools use the person's own token from the vault", async () => {
    const slack = new FakeSlack((method) =>
      method === "conversations.list"
        ? { ok: true, channels: [{ id: "C1", name: "trip", num_members: 4 }] }
        : { ok: true, messages: [{ user: "U1", text: "cabin booked", ts: "1792000000.000" }] },
    );
    const w = groupWorld(once("slack_load_recent", { channel: "#trip" }), { slack });
    w.app.vault.put("alex", "slack", "xoxb-test");
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip what's new in #trip on slack?" });
    expect(slack.calls.map((c) => c.method)).toEqual(["conversations.list", "conversations.history"]);
    expect(w.app.store.toolCallsForRun(run!.id)[0]!.evidence).toBe("slack:history:C1");
  });

  test("write_document stores an artifact people can open at /d/:id", async () => {
    const w = groupWorld(once("write_document", { title: "Packing list", markdown: "# Packing\n- boots" }));
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip write the packing list" });
    const call = w.app.store.toolCallsForRun(run!.id)[0]!;
    const { documentId, url } = call.result as { documentId: string; url: string };
    expect(url).toContain(`/d/${documentId}`);
    expect(w.app.store.getArtifact(documentId)!.kind).toBe("document");
    expect(call.labelDone).toBe('Wrote "Packing list"');
  });

  test("read_page shows who claimed and ticked what, with the chat's people and ids", async () => {
    const w = groupWorld(once("read_page", { pageId: "Packing" }, "Sam has the stove."));
    w.app.store.putArtifact({
      id: "art_page",
      agentId: w.agent.id,
      roomId: w.room.id,
      kind: "document",
      title: "Packing list",
      data: {
        markdown: "# Packing\n- stove\n- boots",
        state: { checked: { "packing:boots": "Jo" }, claimed: { "packing:stove": "Sam" }, added: {} },
      },
      share: "room",
      createdAt: w.clock.now(),
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip what's claimed on the packing list?" });
    const call = w.app.store.toolCallsForRun(run!.id).find((c) => c.name === "read_page")!;
    const content = call.result as { title: string; claimed: Record<string, string>; people: { id: string; displayName: string }[] };
    expect(call.status).toBe("done");
    expect(content.title).toBe("Packing list");
    expect(content.claimed).toEqual({ "packing:stove": "Sam" });
    expect(content.people).toContainEqual({ id: "sam", displayName: "Sam" });
    expect(call.evidence).toBeUndefined();
  });

  test("checkout asks the owner, then clears the budget without claiming an order: no card, cart kept, footer says so", async () => {
    const w = groupWorld((req) => {
      const calls = toolCallsSoFar(req);
      if (!calls.some((c) => c.name === "add_to_cart")) return callTool("add_to_cart", { title: "AA batteries", url: "https://walgreens.com/p/aa", priceUsd: 12 });
      if (!calls.some((c) => c.name === "save_address")) return callTool("save_address", { label: "Home", line1: "1 Main St", city: "San Jose" });
      if (calls.filter((c) => c.name === "checkout_cart").length < 2 && !JSON.stringify(req.messages).includes("order NOT placed")) return callTool("checkout_cart", {});
      return reply("I've ordered the batteries.");
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip buy AA batteries from walgreens" });
    expect(run?.status).toBe("waiting");
    const card = w.app.attention.openFor("alex")[0]!;
    expect(card.kind).toBe("purchase_approval");
    expect(card.title).toContain("$12.00");
    await w.app.runtime.answerAttention(card.id, "Yes", "alex");
    expect(w.app.store.getRun(run!.id)!.status).toBe("done");
    expect(w.hands.payments.cards).toEqual([]);
    expect(w.app.vault.services("alex")).not.toContain("card:card_1");
    expect(w.app.store.getKv("cart:alex") ?? "[]").not.toBe("[]");
    const last = repliesTo(w.deliveries, w.room.id).at(-1)!;
    expect(last).toContain("order not placed");
    // A reply that still claims the order gets the correction: clearing a budget is not buying.
    expect(last).toContain("Correction");
  });

  test("browser_use asks before clicking inside a signed-in site; a guest's look at the owner's account asks too", async () => {
    const w = groupWorld((req) =>
      toolCallsSoFar(req).length ? reply("ok") : callTool("browser_use", { url: "https://ubereats.com/orders", account: "ubereats.com", steps: [{ click: "#reorder" }] }),
    );
    w.app.vault.put("alex", "browser:ubereats.com", "ctx_1");
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip reorder my usual" });
    expect(run?.status).toBe("waiting");
    const item = w.app.attention.openFor("alex")[0]!;
    expect(item.kind).toBe("action");
    expect(item.title).toContain("use ubereats.com as Alex");
    expect(w.hands.browser.runs).toEqual([]);
    const w2 = groupWorld((req) =>
      toolCallsSoFar(req).length ? reply("ok") : callTool("browser_use", { url: "https://ubereats.com/orders", account: "ubereats.com", steps: [{ scroll: "down" }] }),
    );
    w2.app.vault.put("alex", "browser:ubereats.com", "ctx_1");
    expect((await w2.app.runtime.handleMessage({ roomId: w2.room.id, personId: "riley", text: "@pip what did alex order last?" }))?.status).toBe("waiting");
    expect(w2.hands.browser.runs).toEqual([]);
  });

  test("one yes covers moving around a signed-in site for the errand; a step that confirms asks again", async () => {
    const step = (click: string) => callTool("browser_use", { url: "https://swiggy.com/dineout/book", account: "swiggy.com", steps: [{ click }] });
    const w = groupWorld((req) => {
      const n = toolCallsSoFar(req).length;
      return n <= 1 ? step("text=Sun 26") : n === 2 ? step("text=2 guests") : n === 3 ? step("text=Confirm booking") : reply("ok");
    });
    w.app.vault.put("alex", "browser:swiggy.com", "ctx_1");
    await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "book Hauz Khas Social Sunday 8pm for 2" });
    const first = w.app.attention.openFor("alex")[0]!;
    expect(first.title).toBe("OK to use swiggy.com as Alex for this?");
    await w.app.runtime.answerAttention(first.id, "Yes", "alex");
    // The date and the guests went through on that one yes; the confirm click waits for its own.
    expect(w.hands.browser.runs).toHaveLength(2);
    const second = w.app.attention.openFor("alex")[0]!;
    expect(second.title).toBe("OK to confirm on swiggy.com as Alex?");
    expect(second.detail).toContain("Confirm booking");
    // Tapping yes twice on the first card changes nothing and starts no follow-up run.
    expect(await w.app.runtime.answerAttention(first.id, "Yes", "alex")).toBeUndefined();
    expect(w.app.store.listRuns({ roomId: w.ownerDm.id })).toHaveLength(1);
  });

  test("a guest's request that reads the owner's connected account asks the owner first, before the tool runs", async () => {
    const w = groupWorld((req) => (toolCallsSoFar(req).length ? reply("ok") : callTool("list_saved_addresses", {})));
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip where does alex get things delivered?" });
    expect(run?.status).toBe("waiting");
    const item = w.app.attention.openFor("alex")[0]!;
    expect(item.title).toBe("OK for Riley to read your shopping account?");
    expect(w.app.store.toolCallsForRun(run!.id)[0]!.status).toBe("running");
    // Sam consented to their own accounts, so Sam's reads of Sam's account do not ask.
    const w2 = groupWorld((req) => (toolCallsSoFar(req).length ? reply("ok") : callTool("list_saved_addresses", {})));
    expect((await w2.app.runtime.handleMessage({ roomId: w2.room.id, personId: "sam", text: "@pip where do I get things delivered?" }))?.status).toBe("done");
  });

  test("connector_call keeps the token on the API's own origin and gates on the operation's real method", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(`${req.method} ${new URL(req.url).pathname}`);
        if (new URL(req.url).pathname === "/openapi.json")
          return Response.json({ paths: { "/pets/{id}": { delete: { operationId: "deletePet", parameters: [{ name: "id" }] } } } });
        return Response.json({ ok: true });
      },
    });
    try {
      const w = groupWorld((req) => {
        const calls = toolCallsSoFar(req);
        if (!calls.length) return callTool("connector_call", { connector: "pets", path: "https://attacker.example/x", method: "GET" });
        if (calls.length === 1) return callTool("connector_call", { connector: "pets", operationId: "deletePet", params: { id: 7 } });
        return reply("ok");
      });
      w.app.vault.put("alex", "api:pets", JSON.stringify({ baseUrl: `http://127.0.0.1:${server.port}`, openapiUrl: `http://127.0.0.1:${server.port}/openapi.json`, token: "tok" }));
      const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip clean up alex's pets" });
      const calls = w.app.store.toolCallsForRun(run!.id);
      expect(String(calls[0]!.result)).toContain("leaves http://127.0.0.1");
      expect(run?.status).toBe("waiting");
      expect(w.app.attention.openFor("alex")[0]!.detail).toContain("DELETE /pets/{id}");
      expect(seen.some((l) => l.startsWith("DELETE"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("send_agent_email goes from the assistant's own address after a yes", async () => {
    const w = groupWorld((req) =>
      toolCallsSoFar(req).some((c) => c.name === "send_agent_email" && JSON.stringify(req.messages).includes("Sent from"))
        ? reply("Emailed them.")
        : callTool("send_agent_email", { to: ["host@lakeview.example"], subject: "Hot tub", text: "Could someone look at the hot tub before Friday?" }),
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip email the host about the hot tub" });
    expect(run?.status).toBe("waiting");
    const item = w.app.attention.openFor("alex")[0]!;
    expect(item.kind).toBe("outreach_approval");
    await w.app.runtime.answerAttention(item.id, "Yes", "alex");
    expect(w.hands.email.sent).toEqual([
      { to: ["host@lakeview.example"], cc: [], subject: "Hot tub", text: "Could someone look at the hot tub before Friday?", replyToMessageId: undefined },
    ]);
  });

  test("mcp_call lists and calls tools on a connected server, through the vault", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { id: number; method: string; params?: { name?: string; arguments?: unknown } };
        const result =
          body.method === "initialize"
            ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "t", version: "1" } }
            : body.method === "tools/list"
              ? { tools: [{ name: "echo", description: "Echoes.", inputSchema: { type: "object" } }] }
              : { content: [{ type: "text", text: `echo:${JSON.stringify(body.params?.arguments)}` }] };
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });
    try {
      const w = groupWorld((req) => {
        const calls = toolCallsSoFar(req);
        if (!calls.length) return callTool("mcp_call", { server: "notes" });
        if (calls.length === 1) return callTool("mcp_call", { server: "notes", tool: "echo", args: { hi: 1 } });
        return reply("ok");
      });
      w.app.vault.put("alex", "mcp:notes", JSON.stringify({ url: `http://127.0.0.1:${server.port}/mcp` }));
      const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip use notes" });
      const calls = w.app.store.toolCallsForRun(run!.id);
      expect((calls[0]!.result as { name: string }[])[0]!.name).toBe("echo");
      expect(calls[1]!.result).toBe('echo:{"hi":1}');
      expect(calls[1]!.labelDone).toBe("notes · echo");
    } finally {
      server.stop(true);
    }
  });

  test("connector_call indexes an OpenAPI document and calls an operation with the stored token", async () => {
    let seenAuth = "";
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/openapi.json") return Response.json({ paths: { "/pets/{id}": { get: { operationId: "getPet", summary: "One pet" } } } });
        seenAuth = req.headers.get("authorization") ?? "";
        return Response.json({ id: u.pathname.split("/").pop(), name: "Rex" });
      },
    });
    try {
      const w = groupWorld((req) => (toolCallsSoFar(req).length ? reply("ok") : callTool("connector_call", { connector: "pets", operationId: "getPet", params: { id: 7 } })));
      w.app.vault.put(
        "alex",
        "api:pets",
        JSON.stringify({ baseUrl: `http://127.0.0.1:${server.port}`, openapiUrl: `http://127.0.0.1:${server.port}/openapi.json`, token: "sekret" }),
      );
      const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip look up pet 7" });
      expect(w.app.store.toolCallsForRun(run!.id)[0]!.result).toBe('{"id":"7","name":"Rex"}');
      expect(seenAuth).toBe("Bearer sekret");
    } finally {
      server.stop(true);
    }
  });
});
