---
name: hotel-compare
when: hotel, hotels, where to stay, a place to stay, book a room, compare hotel prices, cheapest hotel, resort, ski trip lodging, booking.com, agoda, expedia
---
# Hotels: through us against the public price

Done means: the person knows, per hotel, what it costs through us and what the cheapest public site charges for the same stay, and has one link to book.

1. Before any search, have all of: city, check-in and check-out dates, how many adults, and what they want (star rating, a budget for the stay, area or must-haves). Ask for whatever is missing in one message, with the two or three questions together; do not search on a guess.
2. `hotel_compare` with those, in this run, never through `delegate_task`: it takes under a minute and the reply is the result. One call. After it answers, do not call `hotel_rates`, `web_search`, `browse_page` or `browser_use` for prices, and do not re-run for a different star rating or nearby town unless the person asks: the page already holds the numbers, and every extra call is another minute of waiting.
3. Reply in this shape and nothing else: one context line (dates, guests, how many compared, where the public prices came from; they are all-in totals from major sellers, with Google's tax estimate added where the seller lists before tax; say "taxes estimated" when the row says so. When a discount reseller lists a lower figure, say it is before taxes and fees and never call it the price: its checkout adds them), then a Markdown list of the top three, one line each, written exactly as `- **Name** ★★★★★ · $7,125 through us · $8,664 on Booking.com · save $1,539 (18%)`; with no public price the line ends `· no public price found`; cheaper elsewhere ends `· $300 cheaper on Agoda`. Then the page link on its own line. No sentences about the hotels, no "also", no caveats about other hotels: the card under your reply and the page carry everything else.
4. If the person picks one: booking through us is the owner's click on the site link; you never take card details. Do not call `hotel_rates` as well; the comparison already holds those numbers.
