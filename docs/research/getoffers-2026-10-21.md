# GetOffers.com: where the hotel inventory comes from (21 Oct 2026)

Method: a signed-out capture of getoffers.com and /dashboard with REA (`capture-browser-scenario`, evidence `ev_9e0223fb…`, 609 network events, 111 scripts exported), then the signed-in dashboard in Ellie's own Chrome: a Barcelona hotel search (10–12 Nov 2026, 2 adults) with the network tab read, the search stream fetched and parsed, and the 103 loaded Nuxt chunks scanned for routes and vendor names. Observations are marked as such; the rest is inference.

## What the dashboard calls (observed)

GetOffers is a Nuxt app whose browser only ever talks to its own backend (`getoffers.com/api/...`); every supplier call is server-side, so no supplier key or host is visible from the client.

- Destination autocomplete: `GET /api/search/places?q=Barcelona&kind=city`.
- Hotel search: `GET /api/search/hotels/stream?city=…&checkIn=…&checkOut=…&adults=2&rooms=1`, a `text/event-stream`. Each frame carries `progress: {settled: n, total: 4}` and `data.merged: true`: **the server fans the search out to four suppliers and merges as each settles**, which is why the page says "Searching across our providers…". For Barcelona two suppliers returned results (88 and 12 hotels), two returned none.
- Rooms and rates: `POST /api/booking/hotel-rates`, then `/api/booking/hotel-reprice` before payment, `/api/booking/hotel/{id}/cancel` and `/refund-preview`.
- Also in the bundle: `/api/search/hotels` (non-streaming), `/api/search-cache/latest`, `/api/booking/flight-quote`, `/flight-refresh`, `/flight-services`, boats (`request-offers`, charters), transfers (`request-offers`, holds, `pay-rideclu`), experiences (`/api/experiences/bokun/...`, `/api/experiences/headout/...`), lounges, eSIM, loyalty, `/api/chat/stream` (the "AI Assistant"), `/api/transcribe`, `/api/fx/display-rate`, `/api/payments/topup`.

## Which suppliers (inferred from the stream's result ids and image hosts)

| Result id prefix | Decoded id | Photos served from | Inference |
|---|---|---|---|
| `ht_res_…` (88 of 100 results) | `{"searchId": "01a15ff8-…", "accommodationId": "Accommodation_27455575", "checkInDate", "checkOutDate", "occupancy": [{"adults": 2, "childrenAges": []}]}` | `i.happytravel.com` (1,707 photo URLs) | **HappyTravel** (happytravel.com, a B2B bedbank API). The `Accommodation_<n>` id and the photo CDN are theirs. |
| `tg_res_…` (12 of 100) | `{"h": "ES4531", "ci", "co", "ad": 2, "ro": 1, "ch": null, "a": "39948"}` | `i.travelapi.com` (144 photo URLs) | **TravelgateX** (hotel code plus an `access` id, 39948, is TravelgateX's HotelX shape). `i.travelapi.com` is Expedia's lodging image CDN, so the supplier behind this access is most likely **Expedia (EPS Rapid)** connected through TravelgateX. |
| two more suppliers | returned nothing for Barcelona | | Unknown: not named anywhere the client can see. The flight routes (`flight-quote`, `flight-services`, per-rate `board_code`, `cancel_until` ladders) use a Duffel-shaped schema, so Duffel Stays or Duffel Flights is a plausible fourth; not established. |

Other inventory the routes name outright: **Bokun** and **Headout** for experiences, **RideClu** for transfers, Stripe for top-ups.

## How "cheap" is found

Not a special price source: the server searches all four suppliers for the same stay, normalises each result into one record (`cheapest_rate_total_amount`, `board_codes`, `has_refundable_rate`, `cheapest_rate.cancel_until`), de-duplicates across suppliers by a name-based key (`hotel_key: "fallback:nm:alella arrey|4149:230"`; no GIATA id was present in this search, though the field exists), keeps the cheapest rate per property, and sorts "Cheapest first". Prices shown are the suppliers' net B2B rates plus the agency's margin (the dashboard is an agency account with a discount setting), which is the usual reason a bedbank aggregator undercuts consumer sites.

## Limits of this pass

Client evidence only: supplier names are inferred from id shapes and image hosts, not from a key or a host the browser contacted. The two silent suppliers and the flight source remain unknown. One search, one city, one date pair.

## 6. How much cheaper, measured (21 Oct 2026, same evening)

No supplier publishes a discount figure; RateHawk promises a price match and Hotelbeds sells net rates under contract, so the only way to know is a side-by-side. GetOffers's price is a wholesale rate plus the agency's margin (unknown, shown as 0% discount on this account), so it is an upper bound on the wholesale price. Booking.com totals read from the search results in USD for the same dates, 2 adults, 1 room.

| Hotel | Dates | GetOffers total (cheapest rate, terms) | Booking.com total (terms) | GetOffers vs Booking |
|---|---|---|---|---|
| Hotel Nouvel, Barcelona | 10–12 Nov 2026 | $273.02 (room only, refundable, HappyTravel) | $343 (twin inner, free cancellation) | **−20%** |
| Hotel Arrey Alella | 1–3 Dec 2026 | $260.82 (room only, refundable, TravelgateX) | $201 (double, no free cancellation shown) | +30% |
| Best Western Plus Alfa Aeropuerto | 1–3 Dec 2026 | $272.76 (room only, refundable, TravelgateX) | $205 (double or twin) | +33% |
| Hotel Lloret Ramblas | 1–3 Dec 2026 | $259.20 (room only, refundable, TravelgateX) | $217, struck from $234 (double or twin) | +19% |

What the sample shows, with its limits stated:

- For 10–12 Nov, 11 of the 12 GetOffers hotels I checked were **unavailable on Booking.com** for those dates (Sant Agustí, Catalonia Avinyó, H10 Racó del Pi, Oriente Atiram, Ikonik Ramblas, Hesperia Barri Gòtic, Condal, Leonardo Las Ramblas, Petit Palace Boqueria Garden, SERHS Rivoli Rambla, Ilunion Almirante). Those dates fall in a trade-fair week, and bedbank allotments stay open after retail sells out. The one overlap, Nouvel, was 20% cheaper through the bedbank at equal cancellation terms. That is the wholesale advantage in practice: availability when retail is sold out, and a lower price for the same refundable room.
- For 1–3 Dec, a quiet week, the TravelgateX-fed results were **19 to 33% more expensive** than Booking.com's cheapest rate, with refundable terms on the GetOffers side and no free cancellation shown on Booking's. Part of that gap is the terms, part is the agency margin, part is this supplier access simply not being competitive on those properties; the HappyTravel feed returned nothing for that search, so the better feed was absent.
- Taxes: Booking's card total is what it labels "Price"; GetOffers's total is `cheapest_rate_total_amount`. Whether both include Barcelona's tourist tax was not verified, so treat differences under about 10% as noise.

Reading for Circle: wholesale wins on sold-out dates and on refundable rates, and loses to the retail cheapest on quiet dates once a margin is on top. A fair comparison needs the same cancellation terms and the net rate before margin, which only an own supplier account gives. Sample: 4 priced pairs, 1 city, 2 date pairs.

## 7. Where leaked wholesale rates surface (checked 21 Oct 2026)

Method: Google Hotels' "All options" list for five Barcelona hotels, default dates 12–13 Nov 2026, nightly price in USD, read in the built-in browser. Google lists the official site first, then the cheapest seller, then "view more"; the expanded list did not render into the page text, so only the top undercutter per hotel is recorded. Agoda redirected the headless browser to its home page and could not be read.

| Hotel | Official site | Cheapest other seller | Gap to direct |
|---|---|---|---|
| Hotel Nouvel | $138, free cancellation | **Super.com** $133 | −4% |
| Hotel Catalonia Avinyó | $138, free cancellation | **Priceline** $124, free cancellation | −10% |
| Hotel Vincci Mae | $202 public, $178 member rate | **Hotels.com** $162, free cancellation | −20% vs public, −9% vs member |
| H10 Racó del Pi | $145 public, $131 member rate | Priceline $145 | parity (member rate wins) |
| Hotel Lloret Ramblas | $107 | Wego $138 | direct is cheapest |

What this says: on 3 of 5 hotels a third-party seller undercut the hotel's own site by 4 to 20%, and the undercutters were a wholesale reseller (Super.com, which buys bedbank rates) and the big OTAs' own discounting (Priceline, Hotels.com), not an obscure site. Hotels that answer with a member rate (H10, Vincci) close most of the gap, which is the "dynamic wholesale" remedy in practice. Five hotels, one date, one city: enough to show the pattern, not to size it.

Where to look, in order of how often leaks surface: Google Hotels' seller list (the metasearch aggregator every leak reaches), then Trivago and Kayak, then the resellers themselves: Super.com, Traveluro, Algotels, Hotelsone, ZenHotels/Ostrovok, Prestigia, getaroom/Hotelplanner, Trip.com and Agoda (both also buy from bedbanks), and Expedia/Booking package rates. Opaque channels (Priceline Express Deals, Hotwire) hide the hotel name and are leak-proof by design but cheap.

## 8. What Circle can call: GetOffers' MCP server (checked 21 Oct 2026)

- GetOffers exposes a remote MCP server (Streamable HTTP, JSON-RPC 2.0) with Bearer API keys (`go_live_…` and `go_test_…`), no OAuth. Phase 1 tools: `search_flights`, `search_hotels`, `search_transfers`, `search_activities`, `search_cars`, `search_yachts`, `create_booking`, `list_bookings`, `get_booking`, `cancel_booking`; `modify_booking` and `reschedule_booking` are listed as phase 2. Source: getoffers.com/integrations. The public developer docs page (getoffers.com/developers) is a 404; a PDF quickstart is sent with access.
- The endpoint is **`https://mcp.getoffers.com/`** (root). The documented `/v1` path is misrouted on their side (`Cannot POST /api/mcpv1`); the root answers `401 Invalid API key` to an unauthenticated initialize, so it is live.
- Keys are self-service for an agency account: Dashboard → Company → **MCP API keys**, with a key name and permission ticks for Search, Book and Read bookings. Ellie's account shows the form and "No keys yet". Not generated: creating a credential on the account is the owner's call.
- Circle needs no new code: Settings → Connections → Add MCP with that URL and the key stores it in the vault as `mcp:getoffers`, and `mcp_call` reaches the tools; a search is a read, `create_booking` is a write that the gate asks about, and reading the owner's connection from a guest's request asks the owner first. Payment settles against the agency's prepaid balance (Finance → Top Up, up to 5% prepayment discount), so the spending threshold and `request_purchase` apply before any `create_booking`.

## 9. Nuitée Connect (LiteAPI) rates, same hotels and dates (21 Oct 2026)

Ellie's Nuitée Connect account (connect.nuitee.com) is a distributor-network account with a sandbox key, a hosted B2B/B2C site, and a 12% default network markup. The key is in `.env` as `LITEAPI_API_KEY`. Rates below are from `POST /v3.0/hotels/rates` for Barcelona, 2 adults, USD, with names from `GET /v3.0/data/hotels`. `retailRate.total` is what the partner pays (taxes included, commission $0 on this key, so a net rate); `suggestedSellingPrice` is the public price Nuitée sees the room sold for; RFN is refundable, NRFN is not. The sandbox's rates are live content; whether every sandbox rate is bookable at that price is not stated in the docs.

| Hotel, 10–12 Nov 2026 | LiteAPI net total (terms) | Nuitée's public price | GetOffers total (terms) | Booking.com |
|---|---|---|---|---|
| Hotel Nouvel | **$239.55** (RFN) | $275.48 | $273.02 (refundable) | $343 (free cancellation) |
| Catalonia Avinyó | $265.62 (NRFN) | $305.46 | $273.57 (refundable) | unavailable |
| BW Plus Alfa Aeropuerto | **$270.07** (RFN) | $310.58 | $325.38 (refundable) | unavailable |
| Leonardo Las Ramblas | **$308.57** (RFN) | $354.86 | $337.71 (non-refundable) | unavailable |
| Hesperia Barri Gòtic | $319.38 (RFN) | $321.94 | $318.44 (non-refundable) | unavailable |
| Petit Palace Boqueria Garden | $328.36 (NRFN) | $331.97 | $341.67 (non-refundable) | unavailable |
| SERHS Rivoli Rambla | $336.29 (NRFN) | $386.73 | $344.65 (non-refundable) | unavailable |
| Hotel Medinaceli | $347.33 (NRFN) | $353.92 | $359.96 (non-refundable) | unavailable |
| Ilunion Almirante | $352.63 (NRFN) | $405.53 | $348.60 (refundable) | unavailable |
| Oriente Atiram | $297.67 (NRFN) | $342.32 | $304.57 (non-refundable) | unavailable |

Reading: on the sold-out week LiteAPI's net rate is 2 to 17% under GetOffers on the same hotel, and 30% under Booking.com on the one hotel Booking still had, usually with better cancellation terms; Nuitée's own "public price" sits about 13 to 15% above its net, which is the margin a reseller is expected to take. For 1–3 Dec, LiteAPI returned 87 Barcelona hotels (Hesperia Barri Gòtic $196 non-refundable, Medinaceli $236, Petit Palace $248) against GetOffers's 7; the two Booking-priced hotels from section 6 (Arrey Alella, Alfa Aeropuerto) were not in LiteAPI's December result set, so that pair stays unmeasured. One bad datum: Leonardo Gran Via's suggested price of $1,132 against a $267 net is a content error, the kind a matcher must discard.

Cost to use: search is free, bookings pay a commission; 264 Barcelona hotels came back for the November dates in one call, versus 100 (merged from four feeds) on GetOffers.
