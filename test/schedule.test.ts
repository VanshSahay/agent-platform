// Schedules people actually ask for, in their own time zone.
import { test, expect, beforeEach } from "bun:test";
import { one, J, setTz, zoned, fromZoned, tzOf, exec } from "../src/db";
import * as rt from "../src/runtime";
import { setup, user, workspace, installAgent, say, scriptModel, call } from "./helpers";

let ellie: string, ws: string;
beforeEach(() => { setup(); ellie = user("Ellie"); ws = workspace("Home", ellie); });
const LA = "America/Los_Angeles";

test("AC-SC1 recurring: specific days + minutes, weekends, intervals; computed in the person's zone, across DST", () => {
  const sat = fromZoned(2026, 9, 3, 12, 0, LA); // Sat Oct 3 2026, noon in LA
  const mwf = rt.nextRecurring({ days: [1, 3, 5], hour: 7, minute: 30, tz: LA }, sat);
  expect(zoned(mwf, LA)).toMatchObject({ dow: 1, h: 7, mi: 30, d: 5 }); // Mon Oct 5, 7:30 LA time
  expect(zoned(rt.nextRecurring({ days: [1, 3, 5], hour: 7, minute: 30, tz: LA }, mwf), LA)).toMatchObject({ dow: 3, d: 7 });
  expect(zoned(rt.nextRecurring({ every: "weekends", hour: 10, tz: LA }, sat), LA)).toMatchObject({ dow: 0, h: 10, d: 4 });
  expect(rt.nextRecurring({ interval_minutes: 180 }, sat) - sat).toBe(180 * 6e4);
  expect(rt.nextRecurring({ interval_minutes: 1 }, sat) - sat).toBe(15 * 6e4); // floor: no busy loops
  // DST ends Sun Nov 1 2026 in the US: a 7:00 daily check stays at 7:00 local on both sides
  const before = rt.nextRecurring({ every: "daily", hour: 7, tz: LA }, fromZoned(2026, 9, 31, 5, 0, LA)); // Sat Oct 31, 5am: next is 7:00 PDT, then 7:00 PST
  const after = rt.nextRecurring({ every: "daily", hour: 7, tz: LA }, before + 1000);
  expect([zoned(before, LA).h, zoned(after, LA).h]).toEqual([7, 7]);
  expect(after - before).toBe(25 * 36e5); // the extra hour of Nov 1
});

test("AC-SC2 the agent schedules in the requester's zone: Mon/Wed/Fri at 7:30, 'every 3 hours', wall-clock 'at'; tells it back; learns zones from chat", async () => {
  setTz(ellie, LA);
  const coach = installAgent("coach-accountability", ws, ellie);
  const room = rt.privateRoomFor(ellie, coach);
  const seen = scriptModel(call("reminder.schedule", { text: "Did you run?", days: ["mon", "wed", "fri"], time: "07:30" }), (r) => ({ text: r.messages.at(-1)!.content }));
  await say(room.id, ellie, "check in mon wed fri at 7:30");
  expect(seen[0].system).toMatch(/Now: .*\(America\/Los_Angeles, UTC-0[78]:00\)/);
  const s = one<any>("select * from schedules where room_id=? and kind='recurring' order by created_at desc", room.id);
  expect(J(s.spec)).toMatchObject({ days: [1, 3, 5], hour: 7, minute: 30, tz: LA });
  expect(zoned(s.next_at, LA)).toMatchObject({ h: 7, mi: 30 });
  expect([1, 3, 5]).toContain(zoned(s.next_at, LA).dow);
  expect(J(one<any>("select data from events where type='TOOL_CALL_COMPLETED' order by seq desc").data).output ?? "").toBeDefined();

  scriptModel(call("reminder.schedule", { text: "stretch", every_minutes: 180 }), { text: "ok" });
  await say(room.id, ellie, "remind me to stretch every 3 hours");
  expect(J(one<any>("select spec from schedules where objective='stretch'").spec)).toEqual({ interval_minutes: 180 });

  scriptModel(call("reminder.schedule", { text: "call mom", at: "2027-01-10T18:00" }), { text: "ok" }); // no offset: 6pm in *her* zone
  await say(room.id, ellie, "remind me to call mom jan 10 at 6pm");
  expect(zoned(one<any>("select next_at from schedules where objective='call mom'").next_at, LA)).toMatchObject({ h: 18, d: 10 });

  scriptModel(call("settings.timezone", { tz: "Europe/Lisbon" }), { text: "Got it" });
  await say(room.id, ellie, "I'm in Lisbon this week");
  expect(tzOf(ellie)).toBe("Europe/Lisbon");
  scriptModel(call("settings.timezone", { tz: "Mars/Olympus" }), (r) => ({ text: r.messages.at(-1)!.content }));
  await say(room.id, ellie, "I'm on Mars");
  expect(tzOf(ellie)).toBe("Europe/Lisbon");
});
