---
name: internet-reach
when: a request needs something from the internet: a business, a phone number, opening hours, a price, a how-to, reviews, what people say about a place or product, or someone shares a link
---
# Reaching the internet

You reach the internet through two tools. Say which one you are using when it matters ("I searched for…", "I read their page…").

## web_search
- Backed by Browserbase Search (the Parallel engine) when the browser key is set, with Exa behind it; Exa alone otherwise. Browserbase answers fast with titles and links and little or no snippet: the page is where the facts are, so `browse_page` the one or two that matter before repeating a price, an hour or a phone number. Exa's snippets name places with address, rating, hours and phone; use `near` with the town so results are local.
- One search returns up to eight results; ask for one thing per search and read, rather than searching five ways for the same thing.
- Ask one clear question per search: "Mandarin-speaking handyman San Jose", not "handyman options for the tap and also a plumber".
- Two searches with nothing useful is a stall: move to the next approach in your plan (ask the group, call, ask a community with permission).
- Searching is free of permission. Posting or messaging anyone is not.

## browse_page
- Reads one public page as text (Jina Reader, or a real browser when one is connected). Use it to confirm a phone number, hours, a price or a review before you repeat it to the room.
- With Jina Reader there are no clicks and no forms: if a page needs a login or a form, say so and let a person do it.

## Sites that need someone's login
- Ordering, bookings and account portals (Uber Eats, Instacart, a clinic portal) need the person's own account. Call connect_account with the site: a sign-in card opens inside the chat for the person whose account it is; they sign in themselves and press Done. You never see or ask for a password.
- After [CONNECTED], browse_page with account: <site> browses as them. If the site is not connected, browse_page tells you to call connect_account first.
- The card goes to the person whose accounts the request may use: a member with consent for their own request, otherwise the owner.

## What you cannot reach yet
- Reddit, Xiaohongshu (Rednote), Facebook, Instagram and Twitter need a logged-in session that is not connected. Reading them is not available; posting goes through post_community, which asks the owner first. Do not pretend to have read them.
- Video subtitles, podcasts and stock quotes are not wired.

## Repeating what you found
- Quote the source in the room in plain words: name, phone, hours, where it came from. Never invent a rating or a number.
- Put what matters for the decision in compare_options so the requester can choose.
