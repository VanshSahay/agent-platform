// Interpretation layer: plain words → an Agent Spec the user confirms → instructions, routines, and a sandbox rehearsal before deploy.
import { test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { setup, realFetch } from "./helpers"; // first: loads modules in the app's order (tools before planners)
import { one, all, J } from "../src/db";
import { serve } from "../src/server";
import * as spec from "../src/spec";

let server: ReturnType<typeof serve>;
beforeAll(() => { server = serve(0); });
afterAll(() => server.stop(true));
beforeEach(() => setup());
async function api(path: string, token: string, body?: any) {
  const r = await realFetch(new URL(path, server.url), { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function signup(name: string) {
  const r: any = await (await realFetch(new URL("/v1/auth/signup", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `${name.toLowerCase()}@example.com`, password: "password123" }) })).json();
  return { id: r.user.id as string, token: r.token as string, ws: one<any>("select workspace_id from memberships where user_id=?", r.user.id).workspace_id as string };
}

test("AC-SP1 a one-line request becomes an explicit spec: understanding, jobs, gap questions, boundaries, success signs, rehearsal", async () => {
  const s = await spec.interpret("Split our ski trip costs and remind everyone who owes what", "group");
  expect(s).toMatchObject({ name: "Tab", avatar: "🧾", audience: "group" });
  expect(s.skills).toContain("expense-splitting");
  expect(s.understanding).toMatch(/group chat/);
  expect(s.questions.map((q) => q.id)).toContain("pay"); // not mentioned, so it asks
  expect(s.boundaries.join(" ")).toMatch(/Never moves money/);
  expect(s.rehearsal.length).toBeGreaterThan(0);
  // What the request already says isn't asked again.
  const r = await spec.interpret("Grab me a table for 4 at hot spots in Brooklyn under $80, every Friday at 10am", "me");
  expect(r.questions.map((q) => q.id)).not.toContain("party");
  expect(r.questions.map((q) => q.id)).not.toContain("budget");
  expect(r.routines).toEqual([{ every: "weekly", day: 5, hour: 10, objective: expect.any(String) }]);
});

test("AC-SP2 plain-words routines: weekly, weekdays, daily, time of day", () => {
  expect(spec.routinesFrom("every Friday at 10am", "x")[0]).toMatchObject({ every: "weekly", day: 5, hour: 10 });
  expect(spec.routinesFrom("weekdays at 7pm", "x")[0]).toMatchObject({ every: "weekdays", hour: 19 });
  expect(spec.routinesFrom("every morning brief me", "x")[0]).toMatchObject({ every: "daily", hour: 8 });
  expect(spec.routinesFrom("find me a table", "x")).toEqual([]);
});

test("AC-SP3 a confirmed spec + answers compile into instructions and schedules; rehearsal runs in the sandbox and grades each scenario", async () => {
  const e = await signup("Ellie");
  const s = (await api("/v1/agents/interpret", e.token, { description: "Split our ski trip costs and remind everyone who owes what, every Sunday at 6pm", audience: "group", workspace_id: e.ws })).data;
  const a = (await api("/v1/agents", e.token, { workspace_id: e.ws, name: s.name, title: s.title, job: s.understanding, skills: s.skills, avatar: s.avatar, spec: s, answers: { pay: "venmo @ellie-k" } })).data;
  const agent = one<any>("select * from agents where id=?", a.id);
  expect(agent.instructions).toContain("venmo @ellie-k");
  expect(agent.instructions).toMatch(/Boundaries:/);
  expect(a.spec.answers).toEqual({ pay: "venmo @ellie-k" });
  const sch = one<any>("select * from schedules where agent_id=?", a.id);
  expect(J(sch.spec)).toEqual({ every: "weekly", hour: 18, day: 0 });
  expect(new Date(sch.next_at).getDay()).toBe(0);
  const r = (await api(`/v1/agents/${a.id}/rehearse`, e.token, {})).data.results;
  expect(r.length).toBeGreaterThan(0);
  const split = r.find((x: any) => /\$90/.test(x.say));
  expect(split).toMatchObject({ verdict: "pass" });
  expect(split.tools).toContain("expense.add");
  // Rehearsal stays in the sandbox room: nothing reached a real channel.
  expect(all<any>("select * from outbox")).toHaveLength(0);
  expect(one<any>("select mode from rooms r join events e on e.room_id=r.id where e.type='TOOL_CALL_REQUESTED' limit 1").mode).toBe("test");
});
