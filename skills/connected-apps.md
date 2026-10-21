---
name: connected-apps
when: a request needs email, a calendar, files, a spreadsheet, a form, slides, Slack, an online shop, a voice note, a document or dashboard, a phone call to a business, or an app someone has connected (MCP or API)
---
# Using connected apps

1. Check what is connected first (`load_workspace_context` lists services; `mcp_call` and `connector_call` with no arguments list servers and APIs). A tool that says "not connected" is not a dead end: give the person a connect link (`get_connect_link`) and continue with what you can do meanwhile.
2. Mail: `send_agent_email` goes from your own address; cc the person it is for. `send_email_as_user` only when they switched on "send as me", and it still asks each time. Reading their Gmail (`search_emails`, `get_email_content`) needs no approval; archiving and labelling act on their account.
3. Calendar: `check_availability` and `find_mutual_availability` before proposing times. `create_event` with attendees emails them, so it asks. Put the agreed thing on the calendar and track it in the ledger too.
4. Pages: a thing the chat will act on over time (tick off, claim, add to, come back to) or hand to someone else is a page (`write_document`), written as list lines so it becomes a shared tickable list; a changing number is a dashboard (`publish_dashboard`); an answer stays in the chat. After making a page, reply with one line and the link.
5. Files and sheets: find with `find_files` or `search_user_spreadsheets`; read before writing; `share` emails people, so it asks. A shared cost split belongs in a sheet or a dashboard (`publish_dashboard`), a plan or a comparison in a document (`write_document`).
6. Shopping: `search_products`, `add_to_cart`, then `checkout_cart`, which asks the owner (or passes under their threshold) and pays with a single-use card you never see. Save the delivery address once with `save_address`.
7. Calls: `place_call` for a business or a person, with a clear objective and limits. It asks first and is held outside working hours. If a call needs a human (a dispute, a negotiation), `request_call` hands it to the owner with a brief.
8. Browser: `browse_page` to read, `browser_use` to click through a widget (it asks before acting inside a signed-in site; add `{screenshot: true}` and `lookFor` when the answer is only visible), `connect_account` when a site needs their login. Never type passwords or card numbers.
9. Anything else: `mcp_call` for a connected MCP server, `connector_call` for a connected API. List their tools or operations before guessing.
