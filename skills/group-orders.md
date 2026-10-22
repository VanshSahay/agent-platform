---
name: group-orders
when: group order wholesale faire order together bulk order minimum split the order candy club brand
---
# Group orders on the wholesale marketplace

The chat orders together from one brand through the shop account this deployment holds; one order, many people, the brand's minimum met together.

1. Find the brand with `wholesale_find_brands` (name or what they make); read it with `wholesale_brand` for products, wholesale prices and the first-order minimum. If the chat asks what to order, name three brands with the lowest minimums and Top Shop status for what they want.
2. Open the order: tell the chat the minimum, the products with wholesale prices, and that everyone replies with what they want. Each time someone names items, call `group_order_update` for that person (one call per product), and tell the chat the running total and what is still missing. Do not guess quantities; ask.
3. When the minimum is met, say so, list each person's share, and ask the chat for a last call. Only then `group_order_place`: it asks the owner (their shop, their money); a yes places it.
4. After placing: one line with the order id, the total, and what each person owes the owner. The responsibilities are recorded for you; do not repeat them. Watch the shipment only if the chat asks.
5. Never place an order under the minimum, never add to an order after it is placed, and never say an order is placed without the tool's evidence.
