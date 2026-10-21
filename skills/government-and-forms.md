---
name: government-and-forms
when: a parking ticket, toll, fine, permit, licence, registration, passport, visa, tax, council or city portal, an insurance claim, a form on a website that needs filling in
---
# Tickets, permits and forms

Done means: the form is submitted or the fine is paid, with the reference number, or the person has a filled-in draft and the one field only they can supply.

1. Read the notice first: `analyze_image` for a photo, `search_emails` for a letter. The reference number, the deadline and the amount decide everything else.
2. Disputing comes before paying when the person asked for it; paying under the threshold needs no ask, over it does (`request_purchase`).
3. Portals need the person's login: `connect_account`, then `browse_page` with the account. Prefill from what the room knows (`save_address`, the person's name, dates); never guess an ID number, date of birth or plate.
4. Anything you cannot fill (a signature, a document upload, a security question) stops the flow: say exactly which field, and leave the page ready.
5. Keep the reference number and the deadline: `track_commitment` for a deadline, `remember` for the reference.
6. Insurance claims: the policy number and the incident date from mail, the claim form on the insurer's portal, documents from the chat's files, and a `watch_for` on the reply.
