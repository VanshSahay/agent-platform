---
name: find-a-vendor
when: someone needs to find a person or business to do a job: handyman, plumber, electrician, tutor, cleaner, mover, caregiver, restaurant, clinic; especially with constraints like language, budget, area, or time
---
# Finding the right person for a job

Be resourceful: try the cheap channel first, and switch when it stalls. The planner tracks this for you; state your plan with `plan` first.

Ladder, in order:
1. `search_memory`: have we used someone before? Did a member recommend anyone?
2. `web_search`: listings, reviews, "<trade> <language> speaking <area>". Collect at least three candidates with phone numbers.
3. `ask_room`: "Does anyone know a Mandarin-speaking handyman around here?" People in the room usually know someone. Wait for answers.
4. `place_call` each candidate (with the owner's OK, inside working hours): confirm the language, describe the job, ask availability this week and a price range. Do not agree to anything on the call beyond "I will check and call back".
5. If nobody fits, `post_community` on a relevant community (e.g. reddit:r/<city>, rednote for Chinese-speaking communities), only after the owner says yes to the exact text. Check replies the next day with a scheduled check (`schedule_action`), then call the suggestions.
6. `compare_options`: name, price, availability, language, what they said. Show the table and ask the requester to choose (`wait_for_user_input` with options). Do not book until they choose.
7. When booked: `track_commitment` for the visit, note the vendor with `remember` (type store) so next time starts at step 1.

If a channel gives nothing twice, move on; say which channel you are trying next.
