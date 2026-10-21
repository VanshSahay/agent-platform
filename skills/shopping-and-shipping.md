---
name: shopping-and-shipping
when: buying or ordering something online: find a product, compare prices, check which shop ships to a country, delivery cost, stock, checkout, a screenshot of products someone wants
---
# Buying something

Done means: the person knows where to buy it, for how much, delivered to where they are, and either it is ordered or they have a one-line choice to make.

1. Pin the constraints before searching: what exactly (brand, model, size, quantity), where it must ship to, budget, by when. A screenshot: `analyze_image` first and repeat the items back in one line.
2. `search_products` or `web_search` for shops that list the item. Two searches with nothing new is a stall; stop searching.
3. `browse_page` the shop's product page and its shipping or delivery page. Shipping to the person's country is the constraint that decides; a shop that does not ship there is not an option, however cheap.
4. When no shop ships there: say so plainly, then offer the real routes: an official store in that country, a marketplace that does ship (Amazon, eBay), a forwarding service, or asking the room if someone travels.
5. Three options at most in `compare_options` (shop, price, shipping cost and time, ships to where). Recommend one. Then `request_purchase` or `checkout_cart` only on a yes or under the threshold.
6. Never report a price or a "ships to" claim you did not read on a page. Snippets guess; pages know.

If this takes more than a few steps, `delegate_task` with the constraints and what you have found, and tell the room you are on it.
