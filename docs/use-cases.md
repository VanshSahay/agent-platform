# Circle: use cases and scenarios

What people actually ask a shared assistant to do, by the shape of the group, with the evidence each case rests on. Companion to [multiplayer-spec.md](multiplayer-spec.md), which says how the machinery works; this note says what it is for.

Method: every use case below is traced to something observed, not invented. Sources are competitor products (their starter prompts, feature pages and marketing errands), surveys of how couples, families, friend groups and housemates coordinate, user reports, and our own Fo research. Where a case is a composition of two observed things it is tagged `[inferred]`. Numbers from vendor-run surveys are treated as directional.

---

## 1. Sources

| Tag | Source | What it tells us |
|---|---|---|
| `[Fo]` | Wajo Fo starter prompts, category taxonomy, schedule examples and marketing errands ([research/wajo-fo-build.md](research/wajo-fo-build.md) §3, §6) | Twelve starter prompts (cancel a subscription, track a late package, Saturday to-do reminder, book a home repair, pay a toll or ticket, send a gift, make a call, book an appointment, help with a bill, set a reminder, help with an email, plan a trip). Twenty-one categories: booking, business, children, delivery, doctor, email-reply, email-send, events, finance, gift, government, groceries, haircut, home-services, insurance, personal-care, pets, refunds, schedule, subscriptions, travel. Schedule examples: "When a family birthday lands on my calendar, send me gift options", "Watch for a Yosemite campsite opening and book it", "Dispute this parking ticket, and if it fails, just pay it". |
| `[Instinct]` | TechCrunch, eesel review (Oct 2026) | Text or call it; it follows up on dropped threads, arranges a ride to the airport, books a handyman, books a dinner that fits the calendar, cancels subscriptions, buys groceries, books tickets, plans trips; has its own email address to sign up and contact businesses. |
| `[Ohai]` | ohai.ai feature pages | Shared family calendar across Google, Apple, Outlook; flags conflicts and suggests times; to-dos shared with household members and assigned to others; one-time or recurring reminders for anyone in the household; forward school emails and flyers to extract dates; school schedule upload creates holidays, early dismissals, conferences; weekly meals plus grocery list to Instacart; suggested lists: chores, travel prep, gift shopping, grocery runs, weekend plans, packing. |
| `[Maple]` | App Store listing, Inquirer | Family calendar, family email inbox, to-dos, chore tracker, meal planner up to 60 days, grocery lists, shared notes, summarising school emails. |
| `[Jam]` | App Store listing | Calendar first; forward an email to populate events; driver assignment for pickups and drop-offs; shared shopping lists. |
| `[Hearth]` | hearthdisplay.com blog | Photograph a flyer, invitation, sports schedule, school notice, supply list or handwritten grocery list and it becomes calendar events or a list, with approval; recurring patterns (a season of practices) populate the calendar. |
| `[Cozi]` | ParentMap reader survey, Cozi press kit | Most popular family organiser in the survey; main uses are the shared colour-coded calendar with appointment reminders, grocery lists, recipes and meal plans; chores exist but no usage data. |
| `[Yohana]` | UW benefits page, Japanese press | Human-backed family concierge: daily menus and shopping lists, food ordering, finding children's lessons, weekend outings and trips, reservations and calendar entries, gifts, appointments, finding local professionals for home maintenance, pet care. Users include singles and seniors, not only parents. |
| `[Duckbill]` | usecarly comparison | Hybrid human plus AI: booking appointments, returns, chasing refunds, disputing a medical bill, calling providers, researching and scheduling vendors, cancelling subscriptions, negotiating with customer service, researching summer camps. |
| `[FancyHands]` | money.com review, long-time user posts | Restaurant for six with one gluten-free, summer camp list, haggling with the cable company, finding a specific yoga mat, replacement table hardware, oven repair given error codes, painter estimate, sewer insurance sign-up, research hiking spots and dry cleaners, plan my birthday. |
| `[Mindtrip]` | survey of 1,000+ US leisure travellers | 90% travel with someone; 67% in groups of two to four. Top frustration is mismatched preferences in the group, then uneven budgets, then too many options. |
| `[KAYAK]` | survey | Nearly half of Americans are stressed planning travel for friends or family; top pain points are choosing accommodation, picking a destination, aligning schedules. |
| `[Trip interviews]` | two small interview studies of friend groups | Decision-making is the biggest pain; info is scattered across Google Docs, Messenger and Venmo; organisers end up deciding for everyone; receipts, bills and photos need sharing. |
| `[Howbout]` | howbout.app (vendor) | Friend-group pains: group chat chaos, juggling apps, never knowing when everyone is free; features are availability views, date polls, a chat per plan. |
| `[Partiful]` | NBC, TechCrunch | Birthdays, housewarmings, weddings; heaviest in the post-college years; RSVP tracking, text blasts, shared album; guests need no app. |
| `[Vodafone]` | Vodafone UK survey, Nov 2025 (vendor-run) | 83% of UK families have a group chat; 61% use it for family news, 39% photos, 37% to plan the week ahead, 23% for support; Saturday is the busiest day; 79% share personal news there first. |
| `[HKU]` | HKU survey of 4,914 (2020) | Family chats carry daily life matters (57.5%) and expressing care (39.6%). |
| `[Honeydue]` | TechCrunch 2017 | 75% of 600 couples co-manage some or all finances; spreadsheets are the most used tool; bill splitting used by only about 5%, categorising spend is popular. |
| `[Cupla]` | Cupla 2023 survey of ~700 users (vendor-run) | 75% of users create at least one shared event a month; women do more of the creating, assigning and completing. |
| `[Mental load]` | care.com, Mumsnet, Remember The Milk, spreadsheet guides | Fixed chore ownership ("100% yours") beats rotating; split by domain (one partner owns bills and doctors, the other school papers); each partner owns their own relatives' birthdays; a written default split rule for money; "track without score-keeping". |
| `[Caring]` | caringvillage.com guides | Aging-parent coordination: appointments, medication list with doses and prescribers, refills, rides, meal prep, home safety, insurance claims and bills, POA and documents, one daily status update so the primary carer is not buried in texts, weekly check-in, assigning "a ride to therapy" to a volunteer, scoping paid caregivers. |
| `[CSO]` `[SpareRoom]` | Irish CSO 2021; SpareRoom survey | Housemates disagree about chores (49%), guests (45%), noise (42%), expenses (24%); cleanliness is the top conflict (60%), then noise, then bills. |
| `[Meta AI]` | WhatsApp help, Tom's Guide | In a group it answers when mentioned, visible to all; used to settle "where should we go" debates and suggest activities; cannot read messages it was not mentioned in. |
| `[Messenger]` | Pocket-lint 2021 | Split Payments: ask people for money in a group chat and see who has paid. |
| `[NNg]` | Nielsen Norman Group study of voice assistants | Most common uses are information lookup, weather, messaging a person; transactions about 1%. A floor, and a reminder that most asks are small. |

What the sources agree on, across every group shape: the work is **lists, dates, money, calls and remembering**, spread across too many apps, with one person carrying the load. A group assistant wins by doing those five things in the chat that already exists.

---

## 2. Scenarios

Each scenario is a few turns long and names the spec machinery it exercises. Names follow the test fixture: Alex (owner), Sam (member, consented), Jo (member, low tech comfort), Riley (guest).

### 2.1 Solo

**S1. The dropped thread.** Alex, in their DM: "Did the plumber ever get back to me?" The assistant searches the agent mailbox and Alex's Gmail (own account, no approval), finds no reply since Tuesday, and offers to call. Alex: "yes". The gate opens an item in the same chat (owner, outreach, not on the trust list); Alex's "go ahead" is the decision; the call is placed from the assistant's number, the summary posted with the footer "1 call · 4 min". A commitment is tracked: plumber to confirm a slot by Friday. `[Instinct]` `[Fo]`
Spec: §6.0, §7.1 step 5, §10.1, §12.

**S2. The subscription.** "Cancel the gym, I haven't been since March." Browser hand finds the cancellation page; the site needs a login, so a connect card appears in the DM; Alex signs in inside the embedded browser; the assistant cancels, screenshots the confirmation, and stores "Alex cancelled gym membership, 18 Oct" as an observation that consolidation promotes to a fact. `[Fo starter]` `[Duckbill]`
Spec: §8b of design.md (connect_account), §9.3.

**S3. The watch.** "Tell me when the Yosemite site for the 14th opens up and book it." Creates a watch with a disclosed authorisation (basis user_requested, premise "Alex still wants the 14th", outreach none), checks every few hours, stays quiet, and on a hit books under the spending threshold and posts once. `[Fo schedule example]`
Spec: §10.6, §8.3 silence.

### 2.2 Couples

**C1. Who's cooking.** Alex and Sam in their couple room: "Pip, do a meal plan for the week and a shopping list; Sam's veg Mon to Wed." The assistant makes a page: seven dinners as list lines, a shopping list below, each tickable and claimable. Sam claims Tuesday and Thursday; the ledger records two commitments owned by Sam. Thursday 5pm the assistant nudges Sam in Sam's DM, not the room. `[Ohai]` `[Maple]` `[Cozi]` `[Mental load]`
Spec: §10.3 pages with claims, §10.1 nudges to DM.

**C2. Whose card.** Sam: "Order the air filter again." Sam is a consented member with their own card connected, so checkout uses Sam's card and asks Sam, in Sam's DM, when it is above Sam's threshold. Alex never sees a card. If Sam has no card connected, it is Alex's card and Alex's approval; the room hears "I've asked Alex to OK that". `[Fo]` `[Honeydue]`
Spec: §7.2 table, §7.3 co-owners.

**C3. The split.** "We paid the deposit from my account, split it." A `split` page: who paid, who owes, settle-up line. No money moves; the page is the record. Later, "add the dinner, Sam paid 86" updates the page and the room gets one line with the link. `[Honeydue]` `[Splitwise]` `[Messenger]`
Spec: §10.5.

**C4. The in-laws' birthdays.** Alex, in their DM: "Remind me a week before anyone in my family's birthday and suggest a gift." A person-scoped rule for Alex; the couple room never sees it. When one fires, the assistant posts gift options in Alex's DM, and a purchase under the threshold passes. `[Fo schedule example]` `[Mental load]` (each partner owns their own relatives)
Spec: §9.2 DM facts stay in the DM, §10.6.

**C5. The dentist in the group.** Alex, in the couple room: "what time is my dentist on Thursday?" The answer goes to Alex's DM using Alex's calendar; the room hears "sent that to you". Being the owner does not make Alex's calendar room-visible. `[inferred]`
Spec: §8.5.

### 2.3 Family with kids

**F1. The flyer.** Jo photographs the school term calendar into the family room. The assistant extracts the dates, makes a page listing them, and asks the room "add these to the family calendar?" One yes from any member; events land on the owner's calendar (the room's shared one) and the page link is pinned. Early dismissals become a watch that posts the day before. `[Ohai]` `[Hearth]` `[Jam]`
Spec: §10.2 ask_room, §10.4, §10.6.

**F2. Who's driving.** "Who can take Mia to practice Saturday 9?" A poll to the room with the members as options; Sam claims it; the commitment is tracked with Sam as owner and Mia as beneficiary; a reminder goes to Sam Friday night in Sam's DM. `[Jam]` driver assignment `[Caring]` rides
Spec: §10.2 polls, §10.1.

**F3. Jo and the phone.** Jo (low tech comfort): "the tv thing isn't working again". The prompt switches: one step at a time, "what do you see on the screen?", no jargon. When the fix needs the streaming password, the assistant says "I'll ask Alex for that" and opens an item in Alex's DM rather than asking Jo to read it out. A `lesson` memory records where Jo got stuck. `[design.md §4]`
Spec: §6.5, invariant 10.

**F4. Chores without score-keeping.** "Set up chores: bins Sam, dishwasher Mia, laundry Alex, every week." A recurring page regenerated Monday; ticks are events; the assistant stays quiet unless something is two days overdue, then one DM nudge. The room is never told who is behind. `[Mental load]` `[Maple]`
Spec: §10.3 page events, §8.3 silence, §10.1.

### 2.4 Family with an aging parent

**P1. The appointment and the ride.** In the siblings' room: "Mum's cardiology is the 3rd at 10, who's taking her?" The assistant adds it to the shared calendar, polls the siblings, records the driver as a commitment, and three days before confirms with the clinic by phone from its own number, disclosed as "Alex's assistant calling about Mrs K's appointment" after Alex's one-time yes. `[Caring]` `[Fo]`
Spec: §7.1 outreach, §10.1, §12.

**P2. The one update.** Riley (a guest; the paid carer, on iMessage, never signed up) texts the room "BP 150/90 this morning, she ate well". The assistant records it as a room observation and, per the room's rule "post one daily summary at 6pm", folds the day's notes into one message, so the siblings read one update instead of twelve texts. Riley's request "can you order her the compression socks" needs Alex's card: a card in Alex's DM, the room hears "I've asked Alex". `[Caring]`
Spec: §5 guests, §7.2, §8.4 heartbeat, §10.6.

**P3. The medication list.** "Keep Mum's meds list: metformin 500 twice a day from Dr Shah, …" A page, not a chat message, shared with the room; changes are events with who changed what; the pharmacy refill is a watch on the date. Nothing about it is visible in any other room the assistant is in. `[Caring]`
Spec: §10.3, §9.2 room scope.

### 2.5 Friend groups and trips

**T1. Pick a date.** In "Tahoe trip": "when can everyone do a long weekend in Feb?" The assistant asks each member for calendar read access once (their own account, their own yes, in their DM), computes free slots, and posts two candidate weekends as a poll. Decision made in the room; the organiser does not decide for everyone. `[Howbout]` `[KAYAK]` `[Mindtrip]`
Spec: §10.4 find_time, §7.2 guard, §10.2 polls.

**T2. Who brings what.** "Packing list for the cabin, and who's bringing the stove?" One page; items claimed by colour; the stove claim becomes Sam's commitment; the assistant posts the link once and then only speaks when asked or when the list is done (confetti, no message). `[Trip interviews]` `[Ohai]` packing lists
Spec: §10.3.

**T3. The cabin booking.** "Book the cabin, Alex is paying, we'll split after." Purchase above the threshold: card in Alex's DM, room told, booked on Alex's card, and the split page is created with four equal shares. Riley (a guest invited by link for view-only) can read the page but not claim. `[Mindtrip]` uneven budgets `[Trip interviews]`
Spec: §7.2, §10.5, §6.2 invite roles.

**T4. The debate.** "Pip, settle it: tacos or ramen?" Answer in the room, one message, with a recommendation, no page. The rule from the prompt: stay in the chat when it is an answer. `[Meta AI]`
Spec: §8.3, design.md "When to make a page".

### 2.6 Housemates and neighbours

**H1. Bills.** "Electric is 142 this month, split three ways, Riley already paid me." Split page updated; the assistant does not chase anyone unless a rule says to. `[CSO]` `[SpareRoom]`
Spec: §10.5.

**H2. The street.** A neighbours' WhatsApp group adds the assistant for "the street party and the skip". It introduces itself, answers only when named or on those two topics, and otherwise stays silent. A guest neighbour asking "can you order the skip" gets "I've asked Alex to OK that". `[Vodafone]` planning the week `[Meta AI]` mention-only
Spec: §6.3 introduction, §8.1, §8.4.

---

## 3. One hundred use cases

Columns: who typically asks; the ask as it would be typed; what the assistant does (the primitive, not the prose); approvals and privacy; evidence. "DM" means the answer or card goes to the asker's private chat even if asked in a group (spec §8.5).

### Solo (the owner alone)

| # | Ask | What happens | Approvals / privacy | Evidence |
|---|---|---|---|---|
| 1 | "Cancel the subscription I'm not using" | Finds it in mail, browser cancels, screenshot as evidence | Own account; connect card if login needed | `[Fo starter]` `[Duckbill]` `[Instinct]` |
| 2 | "Track down my late package" | Mail search for tracking, carrier page, posts status; watch until delivered | None | `[Fo starter]` |
| 3 | "Every Saturday morning remind me what's still open" | Schedule; reads the ledger; stays quiet if empty | None | `[Fo starter]` |
| 4 | "Find and book someone to fix the gate" | Search, two or three calls, compare, requester chooses, book | Calls gated once; working hours | `[Fo starter]` `[Instinct]` `[Yohana]` |
| 5 | "Pay this parking ticket" / "dispute it, and if that fails pay it" | Browser on the authority site, pays under threshold | Purchase gate; government category | `[Fo starter]` `[Fo schedule]` |
| 6 | "Send flowers to my sister for Friday" | Shop, cart, checkout with single-use card; address from contacts | Purchase gate | `[Fo starter]` `[Yohana]` |
| 7 | "Call the clinic and move my appointment to next week" | Call from own number, disclosed as assistant; calendar updated | Call gate | `[Fo starter]` `[FancyHands]` |
| 8 | "Help me with this bill" (overcharge) | Reads the bill, calls or emails the provider, negotiates | Outreach gate | `[Fo starter]` `[Duckbill]` `[FancyHands]` |
| 9 | "Reply to this email saying yes but ask for Tuesday" | Draft; sends as the owner only with send-as-me on, else from the agent address | Per-send gate | `[Fo starter]` `[Fo permissions]` |
| 10 | "Plan a weekend in Lisbon under 600" | Research, page with options and a recommendation; books on a yes | Purchase gate | `[Fo starter]` `[Instinct]` |
| 11 | "Dinner near my hotel tonight that fits my calendar" | Calendar read, search, book a table, add to calendar | Booking call or form gate | `[Instinct]` |
| 12 | "Get me a ride to the airport at 5am Thursday" | Books via connected app or calls a cab firm | Purchase gate | `[Instinct]` |
| 13 | "Did X ever reply?" | Mail thread search; offers the follow-up | None; follow-up gated | `[Instinct]` |
| 14 | "Watch for a campsite / ticket / price drop and book it" | Watch with authorisation and premise; books under threshold | Purchase gate | `[Fo schedule]` `[Yutori]` |
| 15 | "Return this and chase the refund" | Returns portal, label, watch the refund | Own account | `[Duckbill]` |
| 16 | "Find a yoga mat like this one under 40" | Search, three options, buy on a yes | Purchase gate | `[FancyHands]` |
| 17 | "Oven shows F3, book a repair" | Research the code, call a repairer, book | Call gate | `[FancyHands]` |
| 18 | "Remind me to take the bins out Tuesday nights" | Recurring reminder | None | `[Fo starter]` `[Ohai]` |
| 19 | "Remember I take the 8:15 train and hate the aisle seat" | Observation then fact; applies when booking later | Person scope | `[Instinct memory]` |
| 20 | "Forget that, I changed jobs" | Retracts the fact; new fact dated | Person scope | `[Instinct memory]` |
| 21 | "Sign me up for the pottery class, use your email" | Agent's own address for sign-up; OTP to agent inbox | Purchase gate if paid | `[Instinct]` `[Fo OTP card]` |
| 22 | "Summarise what the HOA sent this month" | Mail search and summary in chat | None | `[Maple]` school emails `[Gemini]` |

### Couples

| # | Ask | What happens | Approvals / privacy | Evidence |
|---|---|---|---|---|
| 23 | "Meal plan for the week, Sam's veg Mon-Wed, and a shopping list" | Page: dinners and list, tickable, claimable | None | `[Ohai]` `[Maple]` `[Cozi]` |
| 24 | "Order the groceries from that list" | Cart from the page; checkout | Payer's card and threshold | `[Ohai]` Instacart `[Instinct]` |
| 25 | "Who's cooking Thursday?" | Reads the page claims; answers in chat | None | `[Mental load]` |
| 26 | "Set up chores: bins me, dishwasher Sam, weekly" | Recurring page; fixed ownership; quiet nudges to DM | None | `[Mental load]` fixed ownership |
| 27 | "Split the deposit, I paid it" | Split page with settle-up line | None; no money moves | `[Honeydue]` `[Splitwise]` |
| 28 | "What did we spend on eating out this month?" | Dashboard from recorded expenses | Both owners' data only if both consented | `[Honeydue]` categorising |
| 29 | "Book us a table Friday, somewhere new" | Search with both preferences from memory; book | Booking gate; whoever asked pays | `[Instinct]` `[Cupla]` date nights |
| 30 | "When are we both free next week for the plumber?" | Both calendars (each consented); free slots; schedule the visit | Calendar guard per person | `[Ohai]` conflicts `[Howbout]` |
| 31 | "Add my dentist to our calendar" | Owner's shared calendar event | None | `[Cozi]` |
| 32 | "Remind Sam to call the landlord" | Reminder to Sam in Sam's DM, commitment owned by Sam | Sam can decline the ownership | `[Ohai]` "remind X" |
| 33 | "Anniversary is the 12th, find a gift under 100 and book somewhere" | Person-scoped for the asker; gift options in DM; booking on yes | DM only; partner never sees | `[Fo schedule]` birthdays `[Mental load]` |
| 34 | "Renew the car insurance, compare first" | Research, page comparing three, buy on a yes | Purchase gate; insurance category | `[Fo categories]` |
| 35 | "Cancel Sam's gym" (asked by Alex) | Needs Sam's account: asks Sam in Sam's DM | Account owner approves | spec §7.2 `[inferred]` |
| 36 | "Pay the electric when it comes in, under 200" | Watch on inbound email; pays under rule | Rule from owner; threshold | `[Fo schedule]` `[Mental load]` bills |
| 37 | "We're hosting Sunday, who's coming, what do we need" | Guest list page (RSVPs via text blast from agent number), shopping list | Outreach gate for texts | `[Partiful]` |
| 38 | "Plan the Christmas visit to my parents, flights and a gift" | Trip page; flights on a yes; gift under threshold | Purchase gate | `[Fo starter]` travel `[Mental load]` |
| 39 | "Text Sam that I'll be late" (via the agent, on a channel) | Agent sends from its number, disclosed | Outreach to a member: allowed within the room | `[Fo]` outbound texting entitlement |
| 40 | "Find a cleaner that does fortnightly, Thursdays" | Vendor search, calls, compare, requester chooses | Call gate | `[Yohana]` `[FancyHands]` |
| 41 | "Keep a running list for the hardware store" | Page, add-item from either person | None | `[Ohai]` suggested lists |
| 42 | "Book the vet for Biscuit's jab" | Call or form; calendar; reminder | Call gate; pets category | `[Fo categories]` `[Yohana]` |
| 43 | "What's our default split rule?" / "set it to 60/40" | Rule memory, room scope; split pages use it | Owner or co-owner | `[Mental load]` written split rule |
| 44 | "Did we ever pay the deposit for the venue?" | Mail and expense search; answer in chat | Own accounts | `[Instinct]` dropped threads |

### Family with kids

| # | Ask | What happens | Approvals / privacy | Evidence |
|---|---|---|---|---|
| 45 | (photo of school calendar) "add these" | Dates extracted; page; one yes adds to calendar | ask_room | `[Ohai]` `[Hearth]` `[Jam]` |
| 46 | "Forward: school newsletter" | Dates and deadlines extracted; only relevant ones posted | None | `[Ohai]` filters newsletters `[Maple]` |
| 47 | "Who's taking Mia to practice Saturday?" | Poll; claim becomes commitment; DM reminder | None | `[Jam]` driver assignment |
| 48 | "Soccer schedule (photo), it's every Tuesday till June" | Recurring events; conflicts flagged | None | `[Hearth]` recurring patterns `[Ohai]` conflicts |
| 49 | "Remind the kids to pack PE kit Mondays" | Recurring reminder to the room or a member | None | `[Ohai]` `[Fo starter]` |
| 50 | "Summer camp options for a 9-year-old, July, under 400/week" | Research page comparing; book on a yes | Purchase gate; children category | `[Duckbill]` `[FancyHands]` `[Yohana]` |
| 51 | "Book Mia's dentist, after school" | Call the practice, calendar | Call gate; doctor category | `[Fo starter]` |
| 52 | "Birthday party for Mia the 20th: invites, cake, 12 kids" | Page with tasks; RSVPs via agent texts; cake ordered on a yes | Outreach gate for parents' numbers; purchase gate | `[Partiful]` `[Hearth]` invitations |
| 53 | "What's for dinner this week" | Meal page regenerated weekly; favourites reused | None | `[Maple]` `[Ohai]` |
| 54 | "Send the grocery list to Instacart" | Cart and checkout | Payer's card | `[Ohai]` |
| 55 | "Chore chart for the kids, with ticks" | Page; ticks are events; weekly reset; no public scoreboard unless asked | None | `[Maple]` `[Hearth]` streaks `[Mental load]` |
| 56 | "Mum, the tv isn't working" (from Jo, low tech) | One step at a time; password routed to Alex | Never asks Jo for a code | design.md §4 |
| 57 | "Babysitter for Friday 7-11" | Contacts first, then a sitter service; texts from agent number | Outreach gate | `[Yohana]` `[Fo contacts]` |
| 58 | "Pay the school trip, 45" | Form on the school portal; under threshold | Connect card for the portal | `[Fo starter]` government or portal |
| 59 | "Where did we put the passports?" | Memory recall; "you said the grey box, 3 Jan" | Room scope | `[Instinct memory]` |
| 60 | "Who's free Sunday for the grandparents?" | Members' calendars (consented); answer in chat | Calendar guard | `[Ohai]` `[Howbout]` |
| 61 | "Haircuts for both kids Saturday" | Call the barber, book two slots | Call gate; haircut category | `[Fo categories]` |
| 62 | "Return the shoes that don't fit" | Returns flow, label to the room | Own account | `[Duckbill]` |
| 63 | "Gift for the teacher, we're all chipping in" | Gift options; purchase; split page across parents' room | Purchase gate; guests see only the split | `[Fo starter]` gift `[Messenger]` |
| 64 | "Daily: tell me at 7am what's on today for everyone" | Heartbeat with the room's calendar; quiet if nothing | None | `[Fo starter]` `[Vodafone]` plan the week |
| 65 | "Track Mia's reading minutes" | Dashboard; adds from chat | None | `[Hearth]` routines |
| 66 | "Pet insurance renewal is due, compare" | Research page; renew on a yes | Purchase gate; insurance, pets | `[Fo categories]` |

### Family with an aging parent, and extended family

| # | Ask | What happens | Approvals / privacy | Evidence |
|---|---|---|---|---|
| 67 | "Mum's cardiology is the 3rd at 10, who's taking her?" | Calendar, poll, commitment, DM reminder | None | `[Caring]` |
| 68 | "Confirm the appointment with the clinic the day before" | Schedule with disclosed outreach; call from agent number | Owner yes once | `[Caring]` `[Fo]` |
| 69 | "Keep her meds list" | Page; changes are events with author; room scope only | Never visible elsewhere | `[Caring]` |
| 70 | "Refill the metformin by the 20th" | Watch; pharmacy call or portal | Call gate | `[Caring]` |
| 71 | "One update a day at 6, not every text" | Room rule; daily summary from the day's notes | Owner rule | `[Caring]` primary carer buried in texts |
| 72 | "Find a Mandarin-speaking handyman for her flat" | Community suggestions (with permission), calls, compare, choose | Community post gate; call gate | design.md §1 canonical errand |
| 73 | "Who's visiting this week?" | Rota page; claims | None | `[Caring]` care shifts |
| 74 | "Order her compression socks" (from Riley, the paid carer, a guest) | Owner's card; card in Alex's DM; group told | guest_request | `[Caring]` spec §5 |
| 75 | "What did the GP say last month?" | Room memory recall with dates | Room scope | `[Instinct memory]` |
| 76 | "Insurance claim for the walker" | Form on the insurer site; documents from the room's files | Connect card | `[Caring]` finance lead |
| 77 | "Set up a weekly check-in call with Mum, Sundays at 5, from your number" | Schedule; call with a short script; summary to the room | Disclosed outreach to a member | `[Caring]` weekly check-in |
| 78 | "She can't work the new phone" (Jo, low tech) | Tech-help procedure; lesson memory; never asks for codes | DM with Jo; Alex for passwords | design.md §4 |
| 79 | "Family birthdays this year, with reminders" | Page; reminders a week before to the room | None | `[Fo schedule]` `[Vodafone]` |
| 80 | "Plan Christmas dinner: who's bringing what" | Page with claims | None | `[Prospect essay]` `[Vodafone]` |
| 81 | "Book the restaurant for 14 for Dad's 70th" | Calls, availability, deposit | Call gate; purchase gate | `[FancyHands]` party of six `[Partiful]` |
| 82 | "Share the photos from Sunday to the album" | Files to an artifact; link | None | `[Vodafone]` photos 39% `[Partiful]` album |
| 83 | "Which sibling owes what for the carer this month" | Split page from recorded invoices | Only the siblings' room | `[Caring]` `[Honeydue]` |
| 84 | "Hire a cleaner for her, Tuesdays, scope: kitchen and bathroom" | Vendor search, calls, written scope in a page | Call gate | `[Caring]` scoping paid help |

### Friend groups and trips

| # | Ask | What happens | Approvals / privacy | Evidence |
|---|---|---|---|---|
| 85 | "When can everyone do a long weekend in Feb?" | Each member's calendar (own yes), free slots, poll | Calendar guard per person | `[Howbout]` `[KAYAK]` |
| 86 | "Options for a cabin, 6 people, under 250 a night, hot tub" | Research page with three options and a recommendation | None | `[Mindtrip]` too many options |
| 87 | "Book it, Alex pays, split after" | Purchase on Alex's card; split page with six shares | Purchase gate | `[Mindtrip]` uneven budgets |
| 88 | "Packing list and who's bringing the stove" | Page with claims; stove claim is a commitment | None | `[Trip interviews]` `[Ohai]` |
| 89 | "Running tab for the trip" | Split page; add from chat ("Sam paid 86 for dinner") | None | `[Splitwise]` `[Trip interviews]` Venmo |
| 90 | "Tacos or ramen, settle it" | One message with a recommendation; no page | None | `[Meta AI]` |
| 91 | "Dinner Friday for 8, one gluten-free, near the station" | Search, call, book | Call gate | `[FancyHands]` |
| 92 | "Sam's birthday: plan something, don't tell Sam" | Separate room without Sam; the assistant never surfaces it in the main room | Room scope; memory visibility | `[Partiful]` `[FancyHands]` plan my birthday |
| 93 | "Send the invite to the whole list and track RSVPs" | Text blast from the agent number; RSVP page | Outreach gate; guests need no app | `[Partiful]` |
| 94 | "Tickets for the gig go on sale Friday 10am, get 4" | Watch; purchase at release under threshold | Purchase gate | `[Instinct]` `[Fo schedule]` |
| 95 | "Catch me up, I was off grid" | Summary of the room since the person's last message | Only that room's messages | `[Gemini]` `[Apple]` summaries |
| 96 | "Book the 9:40 ferry for all of us" | Purchase with names from contacts | Purchase gate | `[Mindtrip]` |
| 97 | "Fantasy league: remind everyone to set lineups Saturday" | Recurring reminder to the room | None | `[inferred]` from `[Vodafone]` Saturday peak |
| 98 | "Itinerary page we can all edit" | Page with sections; add-item | None | `[Trip interviews]` Google Docs replacement |

### Housemates and neighbours

| # | Ask | What happens | Approvals / privacy | Evidence |
|---|---|---|---|---|
| 99 | "Electric is 142, split three ways, Riley paid me already" | Split page | None | `[CSO]` `[SpareRoom]` expenses |
| 100 | "Cleaning rota, weekly, fixed jobs" | Recurring page; quiet nudges to DMs | None | `[CSO]` chores 49% `[SpareRoom]` cleanliness 60% |
| 101 | "Guests rule: tell everyone two days before" | Room rule; the assistant reminds the host when a calendar entry names a guest | Owner rule | `[CSO]` guests 45% |
| 102 | "Order the skip for the street clean-up" (neighbour, guest) | Owner's card; card in Alex's DM | guest_request | `[Vodafone]` planning; spec §5 |
| 103 | "Street party: who's bringing what, and tell the council" | Page with claims; council email from the agent address | Outreach gate | `[Vodafone]` `[Partiful]` |
| 104 | "Who has a ladder?" | Memory recall across the room's notes | Room scope | `[Instinct memory]` |

(104 rather than 100: the last four are the neighbours' shape, which no competitor serves and which the invite-by-link model makes cheap.)

---

## 4. Patterns across the hundred

Counting the table by primitive (a row can count in more than one):

| Primitive | Cases | Note |
|---|---|---|
| A shared page (list, split, rota, plan, options) | 37 | The single most common outcome. Lists with claims cover meals, chores, packing, who-brings-what, care rotas. |
| A purchase | 25 | Whose card follows whose ask; threshold per payer; single-use card. |
| A call, text or email to a third party from the agent's own identity | 23 | Always gated, always in working hours, always disclosed. Fo's biggest differentiator and ours. |
| A schedule, watch, reminder or heartbeat | 23 | Silence is the default; disclosure is approval in advance. |
| Calendar read or write across more than one person | 12 | Needs per-person consent and the guard; the solo case is trivial, the group case is the product. |
| An answer or card routed to a DM from a group | 10 | The rule that keeps the owner's mail private in their own family chat. |
| Memory recall ("where did we put", "what did the GP say") | 6 | Room scope makes it safe; dates make it useful. |
| A poll or group question | 4 | First answer wins for questions; tally for polls. Fewer rows than its importance: it sits inside many of the page cases. |
| A guest served through the owner | 4 | Carers, neighbours, the friend who never signed up. |

Three things the sources say that the spec should keep honouring:

1. **Most asks are small.** `[NNg]` puts transactions at about 1% of assistant use; `[Vodafone]` says family chats are mostly news and photos. The assistant must be cheap to ignore: mention-only in groups, one line, silence on timers.
2. **Fixed ownership beats fairness algorithms.** `[Mental load]` and `[CSO]` both point at "whose job is it" as the fight. Claims on a page and a commitment with one owner are the product; a rotating scheduler is not.
3. **Decisions are the pain, not information.** `[Mindtrip]`, `[KAYAK]` and the trip interviews all rank mismatched preferences and decision-making above finding options. Polls, a recommendation in chat, and "the requester chooses" are worth more than a longer research page.

---

## 5. Coverage against the branch

Which of the hundred the current build can run today, with fakes where keys are missing:

- **Runs end to end offline (scripted model, fake hands):** pages with ticks and claims, splits as pages, polls as `ask_room` with options (tally is new), calendar free slots, purchases with a threshold, calls and texts through the gate, schedules and watches, memory recall with scope, guest requests through the owner, low-tech-comfort routing, DM-per-person cards. That covers about 80 of the cases above in shape.
- **Needs a key to be real:** Google (OAuth app), the agent mailbox (AgentMail or Resend), calls and SMS (Vapi, Twilio), cards (Stripe Issuing), Instacart (none; would be a browser flow).
- **Not built (listed in the spec as new):** personal answers routed to DMs automatically (§8.5), polls with a tally and deadline (§10.2), a `split` artifact kind with settle-up (§10.5), page edits as events (§10.3), `find_time` as one tool (§10.4), photo-to-dates for flyers (cases 45, 48: `analyze_image` exists, the page and calendar step is not wired), co-owners (§7.3), summaries of a room since last seen (case 95).
