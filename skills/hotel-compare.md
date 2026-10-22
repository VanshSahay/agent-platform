---
name: hotel-compare
when: hotel, hotels, where to stay, a place to stay, book a room, compare hotel prices, cheapest hotel, resort, ski trip lodging, booking.com, agoda, expedia
---
# Hotels: through us against the public price

Done means: the person knows, per hotel, what it costs through us and what the cheapest public site charges for the same stay, and has one link to book.

1. Before any search, have all of: city, check-in and check-out dates, how many adults, and what they want (star rating, a budget for the stay, area or must-haves). Ask for whatever is missing in one message, with the two or three questions together; do not search on a guess.
2. `hotel_compare` with those. One call; it reads our wholesale rates and the public source and writes the shared page.
3. Reply in this shape and no other: one line of context (dates, guests, how many compared), then a Markdown list with one line per hotel for the top three, written exactly as `**Name** ★★★★★ · $7,125 through us · $8,664 on Booking.com · save $1,539 (18%)`; a hotel with no public price reads `· no public price found`; one cheaper elsewhere reads `· $300 cheaper on Agoda`. Then the page link on its own line. No paragraphs about the hotels; the page holds the detail. Say where the public price came from in the context line.
4. If the person picks one: booking through us is the owner's click on the site link; you never take card details. Do not call `hotel_rates` as well; the comparison already holds those numbers.
