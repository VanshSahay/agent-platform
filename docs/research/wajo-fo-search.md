# How search works in Fo

Researched 2026-10-15 with REA (`rea-agents` 6.5.0) over Fo's current client bundle, plus two live runs in Ellie's signed-in Fo Mini account. Observations are marked **live** (seen in the UI or network), **static** (read in shipped client code) or **inferred**. Nothing here is Fo's server code; the server is not visible from the client.

Evidence on Ellie's machine under `~/wajo-research/2026-10-15/`: `artifacts/` (351 chunks from assets.wajo.ai, manifests in `evidence/assets-manifest*.json`), REA whole-bundle Evidence `ev_628dae084a6175761054491105de5bc8d575817a441fac2880c3c9e9ff45a977` (256 public chunks, 584,993 AST nodes, 13,044 findings, graph 2,443 nodes / 5,298 edges, 0 parse failures, coverage partial) and REA focused Evidence `ev_b52cc7de6d554c590aa5bcedcd8e6323602e8ec2143d9cd6ffa45f30937d8dc2` (the 11 search and chat chunks, 209,991 AST nodes, 9,831 findings). Screenshots: [screens/fo-search-ladder.jpg](screens/fo-search-ladder.jpg), [screens/fo-search-lookup.jpg](screens/fo-search-lookup.jpg).

Fo has two things called search. Both were asked for; both are here.

## 1. The agent searching the world

**Live, question 1** ("Find a Mandarin-speaking handyman in San Jose… just search, do not call"). Fo did not answer in one turn. It wrote a one-line message before each group of tool calls, and each message carried its own step list:

| Fo's message | Steps under it |
|---|---|
| "The provider index came back empty for that, so I'm searching the open web for Mandarin-speaking handymen in San Jose." | Completed 3 steps: *Handyman search run through*, *Researched*, then two *Handyman listings searched* |
| "The general results aren't confirming Mandarin speakers, so I'm checking listings that specifically advertise Chinese-language service." | 1 step |
| "Yelp blocked me, but the Chinese community directory (ccyp) might list confirmed Mandarin-speaking repair services in San Jose. Checking that." | 1 step: *Mandarin handyman listings searched* |
| "Report to user first, then keep working." | then a long-running phase: *Searching for a Mandarin-speaking handyman* with a progress line "Digging for confirmed Mandarin-speaking handymen in San Jose now, opening the Chinese-contractor listings directly" |
| "DuckDuckGo loaded fine and points back to Yelp results, but Yelp itself is behind a hard verification wall. Better source: the Chinese community forum thread…" | 1 step: *Handyman listings browsed through* |
| "The forum is mid-verification; reloading to see if it clears." | *Refreshing the browser to look for handymen* |

Six minutes in it had not finished. The run is still open in Ellie's Fo at `wajo.ai/fo/c/972c961c-…`.

**Live, question 2** ("What time does the Santa Clara County main library in San Jose close today?"). One step, *Library hours looked up*, and an answer in under 20 seconds that names its source in prose ("per the library's own site") with no link or citation card.

**Static, the step labels.** The chat renderer `ChatBubble-Ckaejq4L.js` carries a registry of 80 tool names with running/done labels and a family per tool. The search-related entries: `web_search` (knowledge) "Searching the web…" / "Searched the web"; `web_scrape` (knowledge) "Reading web page…" / "Read web page"; `capture_and_analyze` (knowledge) "Looking at the page…" / "Looked at the page"; `browser_use` (operator) "Operating the browser…" / "Operated the browser"; `search_memory` (operator); `search_contacts`; `search_emails`, `find_files`, `search_user_spreadsheets` (google); `slack_search_messages`; `search_products` (shopping); `search_tools` (operator) "Finding the right tools…". Family fallbacks when a tool is not in the registry: knowledge "Researching…" / "Researched", operator "Operating…" / "Operated", unknown "Working…" / "Worked". Label precedence is `tool.meta.running ?? tool.displayLabel ?? registry` (function `Rs`/`zs` in the same chunk), so the server may send a label per call and it wins.

**Inferred from the two together.** The labels seen live ("Handyman listings searched", "Library hours looked up") are not in the registry, so the server is sending a per-call `displayLabel` written in the past tense from the query. The step labelled *Researched* is a tool with no registry entry in the knowledge family, and it sat above two indented search lines, so it is a research tool that fans out several web searches in one step. "The provider index" is Fo's own vendor directory: the client's endpoint map has `ACTION_PROVIDERS.search = /v1/action-providers:search` (`endpoints-DRJG9g09.js`) and the RPC table marks `SearchActionProviders` as `deny` for the consumer client, so only the agent calls it. The order Fo followed was: provider index → open web search → reformulated search ("Chinese-language service") → a directory site (ccyp) → a browser session (DuckDuckGo, Yelp, a forum) → long-running mode with progress lines.

**What that means for us.** The ladder is the same shape as our planner's approach ladder (search → ask the group → call → community → person). Fo's advantages are in presentation, not mechanism: a label per step derived from the query, the model's own one-line narration between tool calls kept in the thread, and a hand-off to a long-running job that posts progress. We had generic labels ("Searched the web"), threw the narration away (recorded as a `delta` event only), and already had the long-running hand-off (`delegate_task`).

## 2. Searching your own chats

**Live.** The sidebar's "Chat history" (⇧⌘K) opens `/search`. Typing "parking" produced `/search?q=parking` and one result, the "Bear Mountain Parking Info" chat, under a "Results" heading. Empty query shows the same list under "Recent".

**Static, the page** (`search-BRM-f6fj.js`, route component `dt`): the query is URL state (`q`, plus `ownerSub` and `agentIds` filters), kept with `navigate({search, replace: true})`; the input is debounced 300 ms (`at = 300`); the list is virtualised with infinite paging; an empty state says "No chats match *q*." or "No chats yet."; rows show the chat title, the agent avatar, the channel icon, a date and, when present, a `snippet`.

**Static, two queries run together** (`rt` in the same chunk):

1. The recents list with the query as a filter: `useRecents` → server function with `{workspaceId, scope: "workspace", agentIds, search, includeShared, pageToken}` (live request 16 in the network log carried `search: "parking"`). This is the title-match list.
2. A semantic search: `chat.queries-BNbMLf5c.js` builds `queryKey: search({workspaceId, query, scope, agentIds})` and calls the `SearchSessions` server function with `{orgId, query (trimmed to 256), pageSize: 10, agentIds, includeShared}`, enabled only when the query has 3 or more characters and at least one agent is selected. The RPC table maps it to `POST /v1/sessions:search` (`allow`). Its `hits` carry `sessionId`, `agentId` and a `snippet`; hits whose session is already in list 1 are dropped, the rest are appended.

So: a cheap filter over titles answers instantly and a server-side semantic search over message content fills in, deduplicated, with snippets. Errors are retried separately ("hasRecentsError" / "hasSemanticError").

## 3. What was built in Circle from this

- `GET /api/search?q=` and a "Search chats" box above the Rooms list: 300 ms debounce, three characters minimum, one row per room with who said it and a snippet, room-name matches appended, "Results" heading, "No chats match …" empty state. Scoped to the rooms the caller is in and to messages they may see. Implemented as SQL `LIKE` over message text; swap in FTS5 when a circle's history makes it slow.
- Search steps carry their query: `Searched: mandarin handyman san jose`, `Read ccyp.com`. A tool may now return a `label` for its own record; the footer and the Why? drawer use it.
- Narration: when the model writes a line and calls tools in the same turn, the line is kept in the thread (source `narration`, shown without a bubble) and delivered as `progress`, which the iMessage adapter skips so groups are not spammed.

Not copied: the provider index (no vendor directory yet), the semantic index over chats (keyword search is enough at family scale), and per-call labels written by the server (ours are derived from the query, which is free).

## 4. Fo's tool catalogue, and what we take from it

**Static.** The 80 tool names the chat renderer knows, by the family the server assigns (from `ChatBubble-Ckaejq4L.js`, REA focused Evidence `ev_b52cc7de…`):

| Family | Tools |
|---|---|
| google (26) | list_events, create_calendar, check_availability, find_mutual_availability, create_event, update_event, delete_event, move_events, search_emails, get_email_content, label_email, archive_email, remove_email_label, send_email_as_user, find_files, list_in_folder, get_metadata, share, create_form, get_spreadsheet, update_spreadsheet, search_user_spreadsheets, get_slide_thumbnail, append_slides, replace_slide, delete_slide |
| operator (24) | get_connect_link, request_call, list_tasks, get_task, schedule_action, list_scheduled_actions, cancel_scheduled_action, update_task_status, browser_use, wait_for_user_input, connector_call, get_current_time, run_javascript, search_tools, publish_dashboard, read_dashboard, list_past_sessions, get_session_transcript, load_workspace_context, search_memory, present_files, write_document, generate_image, analyze_image |
| knowledge (12) | load_soul_document, email_load_thread, email_load_unprocessed, slack_load_recent, slack_load_aggregates, slack_search_messages, whatsapp_load_recent, whatsapp_load_conversation, whatsapp_get_summary, web_search, web_scrape, capture_and_analyze |
| shopping (8) | search_products, add_to_cart, view_cart, remove_from_cart, checkout_cart, save_address, list_saved_addresses, delete_saved_address |
| voice (4) | text_to_speech, send_sms, register_pronunciations, list_sms_groups |
| calls (2) | place_call, place_vendor_call |
| contacts (2) | search_contacts, add_contact |
| wajo (1) | send_wajo_email |
| mcp (1) | mcp_call |

Our registry has 24: plan, web_search, browse_page, connect_account, find_person, ask_room, ask_person, wait_for_user_input, place_call, send_sms, post_community, read_community_replies, compare_options, remember, search_memory, schedule_action, track_commitment, update_commitment, request_purchase, stay_quiet, delegate_task, update_task, steer_task, watch_for.

**What the shape of Fo's catalogue says.** Fo's agent is one general loop with a wide, flat set of tools and a `search_tools` call to find the right one when the catalogue is too large for the prompt. Three pairs matter for us: `web_search` / `web_scrape` (read) are separate from `browser_use` (act); `place_call` is separate from `place_vendor_call` (a business call with its own script); and `search_contacts` / `add_contact` give the agent a shared address book across chats. `get_session_transcript` and `list_past_sessions` let it read its own earlier chats, with `search_memory` beside them. Connectors (`connector_call`) and MCP (`mcp_call`) are how it reaches anything else without a bespoke tool.

**Taken: all of it.** On 2026-10-15 the whole catalogue was built into Circle under the same names (`send_wajo_email` is `send_agent_email`), in `src/tools/catalog/`: Google through one OAuth app and per-person refresh tokens in the vault; MCP and OpenAPI connectors per person; a cart, addresses and single-use cards for checkout; documents, dashboards, images and voice notes as artifacts at `/d/:id`; a multi-step browser; the assistant's own mailbox with inbound mail as events; Slack with the person's token; calls through a voice vendor. Every write still goes through the same gate, and a tool whose service is not connected says so and hands out a connect link. The test `the catalogue matches Fo's 80 tool names` keeps the list honest.
