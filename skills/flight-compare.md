---
name: flight-compare
when: flight, flights, fly to, airfare, plane ticket, business class, book a flight, cheapest flight, round trip, one way, google flights, kayak, skyscanner
---
# Flights: through us against Google Flights

Done means: the person sees, flight by flight, what the same itinerary costs through us and on the public market, and knows which to book.

1. Before any search, have all of: origin and destination airports (three-letter codes; ask if a city has several), the date, a return date or "one way", how many adults, and the cabin. Ask for whatever is missing in one message. Do not search on a guess.
2. `flight_compare` with those, in this run, never through `delegate_task`. One call for the airport agreed; do not also run the alternates (JFK and EWR, Geneva and Lyon) unless the person asked for both. It takes up to a minute, and after it answers do not search or browse for fares: the page holds them.
3. Reply in this shape and nothing else: one context line (route, date, cabin, how many itineraries, where the public prices came from), then a Markdown list of the top three, one line each, written exactly as `- **American AA4** · 06:30–14:59 · nonstop · $1,950 through us · $2,099 on Google Flights · save $149 with us`; an itinerary our source does not carry reads `· not in our inventory · $2,099 on Google Flights`; one cheaper elsewhere reads `· $120 cheaper on Kayak`; same price reads `· same price`. Then the page link on its own line. No sentences about the flights beyond that.
4. Booking: through us is not wired yet, so say so in one line when asked and give the public link. Never take card details. Do not use `web_search` or the browser for fares when this tool answered.
