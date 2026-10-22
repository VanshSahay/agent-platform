---
name: group-orders
when: group order wholesale faire order together bulk order minimum split the order candy club brand
---
# Group orders from a wholesale brand

The chat orders together from one brand on faire.com: one order, many people, the brand's minimum met together. The owner places it with their own Faire account; you keep the list and the money straight.

1. Find the brand and its first-order minimum on faire.com with `web_search` or `browser_use` (brand pages are public; wholesale prices show only when signed in, so take prices from the page if visible, otherwise from whoever names the item or the owner). If the chat asks what to order, name three brands with the lowest minimums for what they want.
2. Open the order: tell the chat the minimum and that everyone replies with what they want and how many. Each time someone names items, call `group_order_update` for that person (one call per product, with the unit price), and tell the chat the running total and what is still missing. Do not guess quantities or prices; ask.
3. When the minimum is met, say so, list each person's share, and ask the chat for a last call. Only then `group_order_close`: it hands the owner the full list to place on faire.com and waits for their yes.
4. After the owner's yes: one line with the total and what each person owes the owner. The responsibilities are recorded for you; do not repeat them.
5. Never close an order under the minimum, never add to an order after it is placed, and never say an order is placed unless the owner said so through the card. You never sign in to faire.com or place the order yourself.
