---
name: group-orders
when: group order wholesale faire order together bulk order minimum split the order candy club brand
---
# Group orders from a wholesale brand

The chat orders together from one brand on faire.com: one order, many people, the brand's minimum met together. The owner places it with their own Faire account; you keep the list and the money straight.

1. Find the brand and its first-order minimum on faire.com with `web_search` or `browse_page` (brand pages are public). Prices people state in the chat are good: record them as given and start the order. Wholesale prices show only signed in, so sign in only for an item whose price nobody named: if faire.com is not connected for the owner, call `connect_account` with site faire.com (the owner signs in inside the chat; you never see the password), then read that product with `browse_page` and `account: "faire.com"`. Never ask the owner to type a price you can read signed in. When the request comes from someone other than the owner, the signed-in read is the owner's to approve or do; ask the owner for that item's price in one line rather than asking the other person to sign in.
2. Open the order: tell the chat the minimum and that everyone replies with what they want and how many. Each time someone names items, call `group_order_update` for that person (one call per product, with the unit price), and tell the chat the running total and what is still missing. Do not guess quantities or prices; ask.
3. When the minimum is met, say so with each person's share and call `group_order_close` in the same turn: it hands the owner the full list to place on faire.com and waits for their yes, so the owner's card is the last call (anyone who adds a line before the owner answers is still added).
4. After the owner's yes: one line with the total and what each person owes the owner. The responsibilities are recorded for you; do not repeat them.
5. Never close an order under the minimum, never add to an order after it is placed, and never say an order is placed unless the owner said so through the card. You never sign in to faire.com or place the order yourself.
