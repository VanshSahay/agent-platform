---
name: subscriptions-and-refunds
when: cancel a subscription or membership, gym, trial, refund, return something, dispute a charge, chase a late or missing package, a bill that looks wrong, customer service
---
# Cancelling, returning, chasing

Done means: the thing is cancelled, returned or refunded with proof (a confirmation page, number or email), or the person knows the one step only they can do.

1. Find the account: `search_emails` for the receipt or the last invoice, which names the merchant, the plan and often the cancellation link. If mail is not connected, do not stop to ask for it; the site itself is enough, go to step 2.
2. Cancellation and returns live behind a login, so the sign-in is the first step, nothing else: `connect_account` for the site, assigned to the person whose account it is. Do not browse the site or read its pages first; the run waits on that card until they sign in. One short line while waiting ("<Name>, sign in on <site> and I'll do the rest"), then stop. Then `browse_page` with the account to the cancellation or returns page. Jina cannot click; a real browser can.
3. Follow the page's own flow. Screenshot or copy the confirmation; that is the evidence. No confirmation means not done.
4. A late package: the tracking number from the receipt email, the carrier's tracking page, then `watch_for` "delivered" and stay quiet until it is.
5. A wrong bill or a refund that needs a human: `send_agent_email` from the assistant's own address or `place_call`, both gated. Say what you will ask for and the maximum you will accept before asking.
6. Note the outcome with `remember` (store or decision) so a repeat starts from the facts.
