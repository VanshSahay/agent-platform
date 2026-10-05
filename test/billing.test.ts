// Model choice and AI billing: platform credits (open models via OpenRouter, metered with markup) vs bring-your-own-key.
import { test, expect, beforeEach, beforeAll, afterAll, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { one, all, exec, now, S } from "../src/db";
import * as billing from "../src/billing";
import { serve } from "../src/server";
import { setup, realFetch, net, say, lastFrom, customAgent } from "./helpers";
import * as rt from "../src/runtime";

let server: ReturnType<typeof serve>;
beforeAll(() => { server = serve(0); });
afterAll(() => server.stop(true));
beforeEach(() => { setup(); process.env.OPENROUTER_API_KEY = "or-PLATFORM"; });
afterEach(() => { delete process.env.OPENROUTER_API_KEY; delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; delete process.env.PLATFORM_ADMINS; });

async function api(path: string, token: string, body?: any, method?: string) {
  const r = await realFetch(new URL(path, server.url), { method: method ?? (body ? "POST" : "GET"), headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function signup(name: string) {
  const r: any = await (await realFetch(new URL("/v1/auth/signup", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `${name.toLowerCase()}@example.com`, password: "password123" }) })).json();
  return { id: r.user.id as string, token: r.token as string, ws: one<any>("select workspace_id from memberships where user_id=?", r.user.id).workspace_id as string };
}
/** Fake OpenAI-compatible endpoint; `reply` decides each response. */
function fakeChat(re: RegExp, reply: (body: any) => any = () => ({ content: "hi from an open model" }), cost = 0.01) {
  const seen: { body: any; auth: string | null; url: string }[] = [];
  net.on(re, (req, b) => {
    seen.push({ body: b, auth: req.headers.get("authorization"), url: req.url });
    return Response.json({ choices: [{ message: reply(b) }], usage: { prompt_tokens: 1000, completion_tokens: 200, ...(cost != null ? { cost } : {}) } });
  });
  return seen;
}

test("AC-CR1 credits mode: open models on OpenRouter with the platform key, billed with markup from the monthly allowance", async () => {
  const e = await signup("Ellie");
  const seen = fakeChat(/openrouter\.ai\/api\/v1\/chat\/completions/, (b) => !b.tools || b.messages.some((m: any) => m.role === "tool")
    ? { content: "Remembered." } : { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "memory__remember", arguments: S({ text: "likes window seats", scope: "room" }) } }] });
  const a = customAgent(e.ws, e.id, ["reminders"]);
  const room = rt.privateRoomFor(e.id, a);
  await say(room.id, e.id, "remember that I like window seats");
  expect(lastFrom(room.id, a.id)).toBe("Remembered.");
  expect(seen.every((s) => s.auth === "Bearer or-PLATFORM")).toBe(true);
  // Background steps (the intake brief) use the cheap tier; the agent's tool-calling turn uses standard.
  expect(seen.find((s) => !s.body.tools)?.body.model).toBe("qwen/qwen3.7-flash");
  expect(seen.filter((s) => s.body.tools).map((s) => s.body.model)).toContain("deepseek/deepseek-v4-pro");
  expect(seen.find((s) => s.body.tools)?.body.provider).toEqual({ require_parameters: true }); // only providers that support tool calling
  expect(seen[0].body.usage).toEqual({ include: true }); // OpenRouter reports the real cost
  expect(one<any>("select count(*) n from memories where scope_type='room' and text='likes window seats'").n).toBe(1); // the dotted tool name survived the wire format
  const billed = all<any>("select cost_usd from usage where workspace_id=? and kind='model_input_tokens'", e.ws).reduce((s, r) => s + r.cost_usd, 0);
  expect(billed).toBeCloseTo(seen.length * 0.01 * 1.25, 6);
  expect(billing.balance(e.ws).allowance_left).toBeCloseTo(20 - billed, 6); // personal plan: $20/month
});

test("AC-CR2 the workspace picks the model per profile; a malformed tool call falls through to the next model", async () => {
  const e = await signup("Ellie");
  const models = await api(`/v1/workspaces/${e.ws}/ai`, e.token, { models: { fast: "openrouter:meta-llama/llama-4-maverick" } }, "PUT");
  expect(models.data.models).toEqual({ fast: "openrouter:meta-llama/llama-4-maverick" }); // "hello" is a quick step
  expect((await api(`/v1/workspaces/${e.ws}/ai`, e.token, { models: { standard: "not-a-model" } }, "PUT")).status).toBe(400);
  const seen = fakeChat(/openrouter\.ai/, (b) => b.model.startsWith("meta-llama") ? { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "memory__remember", arguments: "{oops" } }] } : { content: "fallback answered" });
  const a = customAgent(e.ws, e.id, []);
  const room = rt.privateRoomFor(e.id, a);
  await say(room.id, e.id, "hello");
  expect(seen.filter((s) => s.body.tools).map((s) => s.body.model)).toEqual(["meta-llama/llama-4-maverick", "qwen/qwen3.7-flash"]); // pick first, then the tier default
  expect(lastFrom(room.id, a.id)).toBe("fallback answered");
});

test("AC-CR3 BYOK: the workspace's own key is used, nothing is billed, the key is never shown; removing it returns to credits", async () => {
  const e = await signup("Ellie");
  const put = await api(`/v1/workspaces/${e.ws}/provider-keys/openrouter`, e.token, { key: "or-MINE-SECRET" }, "PUT");
  expect(put.data.mode).toBe("byok");
  const seen = fakeChat(/openrouter\.ai/);
  const a = customAgent(e.ws, e.id, []);
  const room = rt.privateRoomFor(e.id, a);
  await say(room.id, e.id, "hello");
  expect(seen[0].auth).toBe("Bearer or-MINE-SECRET");
  expect(one<any>("select sum(cost_usd) s from usage where workspace_id=?", e.ws).s).toBe(0);
  expect(billing.balance(e.ws).allowance_left).toBe(20);
  const view = await api(`/v1/workspaces/${e.ws}/ai`, e.token);
  expect(view.data).toMatchObject({ mode: "byok", byok: ["openrouter"], platform: ["openrouter"] });
  expect(JSON.stringify(view.data) + JSON.stringify(all("select * from events"))).not.toContain("SECRET");
  // BYOK never silently spends platform credits: no key for the provider → clear error, not the platform key.
  exec("update workspaces set ai_models=? where id=?", S({ standard: "anthropic:claude-sonnet-5-5" }), e.ws);
  await api(`/v1/workspaces/${e.ws}/provider-keys/openrouter`, e.token, undefined, "DELETE");
  expect((await api(`/v1/workspaces/${e.ws}/ai`, e.token)).data.mode).toBe("credits");
  expect((await api(`/v1/workspaces/${e.ws}/ai`, e.token, { mode: "byok" }, "PUT")).status).toBe(400); // needs a key first
});

test("AC-CR4 any OpenAI-compatible server (self-hosted open models), never on a private network", async () => {
  const e = await signup("Ellie");
  expect((await api(`/v1/workspaces/${e.ws}/provider-keys/custom`, e.token, { base_url: "http://llm.internal.test/v1" }, "PUT")).status).toBe(400);
  expect((await api(`/v1/workspaces/${e.ws}/provider-keys/custom`, e.token, { base_url: "https://llm.example/v1/", key: "tg-key" }, "PUT")).status).toBe(200);
  await api(`/v1/workspaces/${e.ws}/ai`, e.token, { models: { fast: "custom:llama3.1:8b", standard: "custom:llama3.1:8b" } }, "PUT");
  const seen = fakeChat(/llm\.example/, () => ({ content: "self-hosted says hi" }), null as any);
  const a = customAgent(e.ws, e.id, []);
  const room = rt.privateRoomFor(e.id, a);
  await say(room.id, e.id, "hello");
  expect(seen[0].url).toBe("https://llm.example/v1/chat/completions");
  expect(seen[0].body.model).toBe("llama3.1:8b"); // colons inside model ids survive
  expect(lastFrom(room.id, a.id)).toBe("self-hosted says hi");
});

test("AC-CR5 out of credits stops platform inference; Stripe top-ups add exactly what was paid, once; admins can grant", async () => {
  const e = await signup("Ellie");
  exec("update workspaces set plan='free' where id=?", e.ws);
  billing.charge(e.ws, 3); // $2 allowance + $1 into credits
  fakeChat(/openrouter\.ai/);
  const a = customAgent(e.ws, e.id, []);
  const room = rt.privateRoomFor(e.id, a);
  await say(room.id, e.id, "hello");
  expect(lastFrom(room.id, a.id)).toMatch(/out of AI credits/);
  expect((await api(`/v1/workspaces/${e.ws}/credits/checkout`, e.token, { usd: 10 })).status).toBe(501);
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  net.on(/api\.stripe\.com\/v1\/checkout\/sessions/, () => Response.json({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }));
  expect((await api(`/v1/workspaces/${e.ws}/credits/checkout`, e.token, { usd: 10 })).data.url).toContain("checkout.stripe.com");
  expect(net.to(/stripe/)[0].body).toContain(`metadata%5Bworkspace_id%5D=${e.ws}`);
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const event = S({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_status: "paid", amount_total: 1000, metadata: { workspace_id: e.ws, credits_usd: "999" } } } });
  const sign = (raw: string, secret = "whsec_test") => { const t = Math.floor(now() / 1000); return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`; };
  const hook = (sig: string) => realFetch(new URL("/v1/webhooks/stripe", server.url), { method: "POST", headers: { "stripe-signature": sig }, body: event });
  expect((await hook(sign(event, "wrong"))).status).toBe(401);
  expect((await hook(sign(event))).status).toBe(200);
  expect((await hook(sign(event))).status).toBe(200); // Stripe retries: credited once
  expect(billing.balance(e.ws).credits).toBe(9); // $10 paid (not the metadata's claim) minus the $1 overdraft
  await say(room.id, e.id, "hello again");
  expect(lastFrom(room.id, a.id)).toBe("hi from an open model");
  expect((await api("/v1/admin/credits", e.token, { workspace_id: e.ws, usd: 5 })).status).toBe(403);
  process.env.PLATFORM_ADMINS = "ellie@example.com";
  const after = (await api("/v1/admin/credits", e.token, { workspace_id: e.ws, usd: 5 })).data.credits;
  expect(after).toBeGreaterThan(13.9); expect(after).toBeLessThan(14); // +$5 grant, minus the "hello again" calls
});

test("AC-CR6 model catalog: tool-capable OpenRouter models with open-weight flags, availability and marked-up prices per mode", async () => {
  const e = await signup("Ellie");
  net.on(/openrouter\.ai\/api\/v1\/models/, () => Response.json({ data: [
    { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", pricing: { prompt: "0.0000001", completion: "0.0000004" }, supported_parameters: ["tools"] },
    { id: "some/no-tools", name: "No tools", pricing: { prompt: "0", completion: "0" }, supported_parameters: [] }] }));
  const list = (await api(`/v1/models?workspace=${e.ws}`, e.token)).data;
  const llama = list.find((m: any) => m.id === "openrouter:meta-llama/llama-3.3-70b-instruct");
  expect(llama).toMatchObject({ open: true, available: true, in_per_m: 0.1, price_in_per_m: 0.125 });
  expect(list.some((m: any) => m.id.includes("no-tools"))).toBe(false);
  expect(list.find((m: any) => m.id === "anthropic:claude-sonnet-5-5").available).toBe(false); // no platform Anthropic key here
});

test("AC-CR7 non-model usage is metered in credits too: searches, browser tasks, chat-line messages, phone turns", async () => {
  const e = await signup("Ellie");
  const { recordUsage } = await import("../src/db");
  recordUsage({ workspace_id: e.ws, kind: "search_calls", qty: 4 });
  recordUsage({ workspace_id: e.ws, kind: "channel_messages", qty: 10 });
  recordUsage({ workspace_id: e.ws, kind: "model_input_tokens", qty: 500, cost_usd: 0.002 }); // pre-priced model usage isn't charged twice
  expect(all<any>("select kind, cost_usd from usage where workspace_id=? order by id", e.ws).map((r) => [r.kind, r.cost_usd]))
    .toEqual([["search_calls", .02], ["channel_messages", .05], ["model_input_tokens", .002]]);
  expect(billing.balance(e.ws).allowance_left).toBeCloseTo(20 - .07, 6);
  process.env.PRICE_SEARCH_CALLS = "0";
  recordUsage({ workspace_id: e.ws, kind: "search_calls", qty: 3 });
  expect(one<any>("select cost_usd from usage where workspace_id=? order by id desc limit 1", e.ws).cost_usd).toBe(0);
  delete process.env.PRICE_SEARCH_CALLS;
});

test("AC-CR8 step-aware routing: cheap tier for quick asks, research tier for research, a frontier model only when stuck", async () => {
  const e = await signup("Ellie");
  const a = customAgent(e.ws, e.id, ["web-research"]);
  const run = (objective: string, extra: any = {}) => ({ objective, brief: null, kind: "message", ...extra });
  expect(rt.routeProfile(a, run("thanks, that's great!", { brief: S({ plan: [], side_effects: [] }) }))).toBe("fast"); // small talk only
  expect(rt.routeProfile(a, run("remember I like window seats"))).toBe("standard"); // may call tools: never the cheap tier
  expect(rt.routeProfile(a, run("Research and compare the three best co-working spaces in Lisbon"))).toBe("research-standard");
  expect(rt.routeProfile(a, run("x".repeat(200)))).toBe("standard");
  expect(rt.routeProfile(a, run("hi", { brief: S({ plan: [1, 2, 3, 4].map((i) => ({ text: `step ${i}` })) }) }))).toBe("research-standard");
  expect(rt.routeProfile(a, run("hi", { kind: "schedule" }))).toBe("standard"); // scheduled work runs unattended: don't skimp
  expect(rt.routeProfile({ ...a, model_profile: "escalation" }, run("hi"))).toBe("escalation"); // a pinned profile wins
  // Stuck → escalate: with only an OpenRouter key, the frontier tier is reached through OpenRouter.
  const seen = fakeChat(/openrouter\.ai/, () => ({ content: "ok" }));
  const { generate } = await import("../src/model");
  await generate({ profile: "standard", escalate: true, workspaceId: e.ws, system: "s", messages: [{ role: "user", content: "hi" }] });
  expect(seen[0].body.model).toBe("anthropic/claude-sonnet-5.5");
  process.env.OPENROUTER_MODEL_ESCALATION = "openrouter:moonshotai/kimi-k3"; // every tier is overridable
  await generate({ profile: "standard", escalate: true, workspaceId: e.ws, system: "s", messages: [{ role: "user", content: "hi" }] });
  expect(seen[1].body.model).toBe("moonshotai/kimi-k3");
  delete process.env.OPENROUTER_MODEL_ESCALATION;
});
