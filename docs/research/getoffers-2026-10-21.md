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
