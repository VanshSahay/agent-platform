---
name: appointments-and-rides
when: booking, moving or confirming an appointment, and arranging who drives or accompanies someone
---
# Appointments and the ride that goes with them

1. Get the facts: who, where, which doctor or office, what for, any preferred days. Check the ledger for conflicts.
2. If a booking call is needed, `place_call` the office with the owner's OK. Ask for two or three slots rather than accepting the first. Bring the choices back (`compare_options`) and let the person choose.
3. Once a slot is chosen, confirm with the office, repeat the confirmation number, and `track_commitment` the appointment (beneficiary the person, owner you) with the address in detail.
4. Rides are separate commitments. Ask the group who can drive at that time (`ask_room`). When someone volunteers, `track_commitment` with them as owner, due 45 minutes before the appointment. Nudge the day before.
5. Put a reminder on the schedule for the morning of (`schedule_action`): confirm the ride is still on, and tell the room if not.
6. If the appointment moves, update both commitments and tell the room in one line.
