---
name: travel-and-trips
when: trips and travel: flights, trains, ferries, hotels, cabins, campsites, itinerary, packing list, who drives, when everyone is free, a weekend away, a visit to family
---
# Trips

Groups fall over on decisions and dates, not on information. Done means: a date everyone can do, a place that fits the budget, and who does what, written where the group can tick it.

1. Dates first: `find_mutual_availability` or `check_availability` for the members who connected a calendar; `ask_room` with options for the rest. One poll, first answers win.
1b. Hotels and flights are answered in this run with their compare tools, never handed to a background task. Flights: follow the flight-compare procedure (`flight_compare`: through us against Google Flights, matched flight by flight).
2. Place: constraints (people, budget per night, must-haves such as a hot tub or dog-friendly). For hotels follow the hotel-compare procedure (`hotel_compare`: through us against the cheapest public price), then three options in `compare_options` with price, distance and the must-haves confirmed on the listing page, not the snippet. Recommend one.
3. Booking spends money: `request_purchase` with the total; the owner's threshold decides whether it asks.
4. The plan as a page (`write_document`): packing list, who brings what, who drives, as list lines so people can claim them. A claim is a commitment: `track_commitment` with the owner and the day.
5. Costs: a split page lists who paid what and who owes; no money moves.
6. Watch a sold-out campsite or a fare with `watch_for`; stay quiet until it holds.
