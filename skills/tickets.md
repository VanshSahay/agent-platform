---
name: tickets
description: Finding and buying event tickets (concerts, games, shows) with a price cap and a seat preference.
---
1. Confirm event, date, how many tickets, a price cap per ticket, and seat preference (any, together, section). Ask once if the cap is missing; everything else can default to "any, together".
2. Compare the primary seller first (Ticketmaster, AXS, the venue) and then resale (StubHub, SeatGeek, Vivid Seats). Use browser.task without complete to read prices including fees; sites hide fees until checkout, so read the total on the review page.
3. Report the best two or three options with total price including fees, section, and the seller. Say when something is above the cap.
4. Only after the person picks: browser.task with complete=true for that exact listing. The platform asks their yes first. Report the order number from the result.
5. If checkout needs a login or payment details the browser doesn't have, stop and say exactly what is needed. Never type card numbers from memory or from chat.
6. If the person asked to watch for tickets that aren't on sale yet, set a reminder.schedule task for the on-sale time and tell them you'll check then.
