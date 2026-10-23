import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, test } from "bun:test";
import { AnthropicModel } from "../src/model/anthropic.ts";
import { daysAgoIso, recordSpend, SpendLog, spendSummary, startOfDayIso } from "../src/runtime/spend.ts";
import { openDb } from "../src/store/db.ts";
import { ApifyHotels } from "../src/tools/providers/public-rates.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** The OpenRouter door through a fake fetch: a priced non-streaming reply, and a stream whose price rides the last delta. */
function openRouterDoor(onUsage: (u: unknown) => void, seen: { bodies: Record<string, unknown>[] }) {
  const sse = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 300, cost: 0.0042 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.bodies.push(body);
    if (body.stream) return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    return jsonRes({
      id: "msg_2",
      type: "message",
      role: "assistant",
      model: "m",
      content: [{ type: "text", text: "yes" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 40, output_tokens: 3, cost: 0.00011 },
    });
  };
  const client = new Anthropic({ apiKey: "x", baseURL: "https://openrouter.test/api", maxRetries: 0, fetch: fetch as unknown as typeof globalThis.fetch });
  return new AnthropicModel(client, { includeUsage: true, onUsage: onUsage as never });
}

describe("spend monitor", () => {
  test("an OpenRouter call records usage.cost with its tokens and run id, streamed or not", async () => {
    const got: { model: string; input: number; output: number; usd?: number; runId?: string }[] = [];
    const seen = { bodies: [] as Record<string, unknown>[] };
    const model = openRouterDoor((u) => got.push(u as (typeof got)[number]), seen);
    const turn = await model.turn({ model: "m", effort: "low", system: { stable: "s", volatile: "" }, messages: [{ role: "user", content: "hi" }], tools: [], runId: "run_1" });
    expect(turn.text).toBe("hi");
    expect(got[0]).toEqual({ model: "m", input: 1200, output: 300, usd: 0.0042, runId: "run_1" });
    await model.complete({ system: "s", prompt: "p", model: "m" });
    expect(got[1]).toEqual({ model: "m", input: 40, output: 3, usd: 0.00011, runId: undefined });
    expect(seen.bodies.every((b) => JSON.stringify(b.usage) === JSON.stringify({ include: true }))).toBe(true);

    const db = openDb();
    const log = new SpendLog();
    log.record({ provider: "openrouter", usd: got[0]!.usd ?? 0, units: `${got[0]!.input} in / ${got[0]!.output} out tokens`, runId: got[0]!.runId });
    log.attach(db); // entries made before the database opened are kept
    const rows = db.query("SELECT provider, usd, units, run_id FROM spend").all();
    expect(rows).toEqual([{ provider: "openrouter", usd: 0.0042, units: "1200 in / 300 out tokens", run_id: "run_1" }]);
  });

  test("an Apify sync run is followed by a read of the actor's last run and its usageTotalUsd is recorded", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes("run-sync-get-dataset-items")) return jsonRes([{ type: "status", fetched_at: "2026-10-13T17:00:00Z" }]);
      if (String(url).includes("/runs/last")) return jsonRes({ data: { id: "abc", usageTotalUsd: 0.21, usage: { ACTOR_COMPUTE_UNITS: 0.052 } } });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const db = openDb();
    const log = new SpendLog(db);
    const hotels = new ApifyHotels("tok", undefined, log);
    const r = await hotels.search({ city: "Chicago", countryCode: "US", checkIn: "2026-11-01", checkOut: "2026-11-03", adults: 2 });
    expect(r.offers).toEqual([]);
    expect(urls[1]).toBe("https://api.apify.com/v2/acts/kestrel~google-hotels-prices/runs/last?status=SUCCEEDED");
    const rows = db.query("SELECT provider, usd, units, note FROM spend").all();
    expect(rows).toEqual([{ provider: "apify", usd: 0.21, units: "apify run abc 0.052 CU", note: "hotels Chicago 2026-11-01" }]);
  });

  test("the summary groups by provider and by run inside the window, with hosting prorated", () => {
    const db = openDb();
    const at = (h: number) => `2026-10-13T${String(h).padStart(2, "0")}:00:00.000Z`;
    recordSpend(db, { provider: "openrouter", usd: 0.004, units: "1200 in / 300 out tokens", runId: "r1", at: at(9) });
    recordSpend(db, { provider: "openrouter", usd: 0.001, units: "300 in / 20 out tokens", runId: "r1", at: at(9) });
    recordSpend(db, { provider: "apify", usd: 0.21, units: "apify run abc 0.05 CU", at: at(10) });
    recordSpend(db, { provider: "browserbase", usd: 0.002, units: "browserbase 72 s", runId: "r2", at: at(11) });
    recordSpend(db, { provider: "liteapi", usd: 0, units: "1 rates search", at: at(11) });
    recordSpend(db, { provider: "openrouter", usd: 5, units: "yesterday", runId: "r0", at: "2026-10-12T23:00:00.000Z" });
    const since = "2026-10-13T00:00:00.000Z";
    const s = spendSummary(db, { since, until: "2026-10-14T00:00:00.000Z", flyUsdPerMonth: 30.4375 });
    expect(s.byProvider).toEqual({
      openrouter: { usd: 0.005, count: 2 },
      apify: { usd: 0.21, count: 1 },
      browserbase: { usd: 0.002, count: 1 },
      liteapi: { usd: 0, count: 1 },
      fly: { usd: 1, count: 0 },
    });
    expect(s.hostingUsd).toBe(1);
    expect(s.totalUsd).toBe(1.217);
    expect(s.byRun).toEqual([
      { runId: "r1", usd: 0.005, byProvider: { openrouter: 0.005 } },
      { runId: "r2", usd: 0.002, byProvider: { browserbase: 0.002 } },
    ]);
    expect(startOfDayIso(Date.parse("2026-10-13T17:00:00Z"))).toBe(since);
    expect(daysAgoIso(7, Date.parse("2026-10-13T17:00:00Z"))).toBe("2026-10-06T17:00:00.000Z");
  });
});

test("a model stream that breaks mid-way is retried, and the turn still comes back", async () => {
  AnthropicModel.retryBaseMs = 0;
  const seen: { bodies: Record<string, unknown>[] } = { bodies: [] };
  const good = openRouterDoor(() => undefined, { bodies: [] });
  // The first stream sends message_start twice (what OpenRouter did in eval run 13); the second is whole.
  const start = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`;
  let calls = 0;
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    seen.bodies.push(JSON.parse(String(init?.body)));
    calls += 1;
    if (calls === 1) return new Response(start + start, { status: 200, headers: { "content-type": "text/event-stream" } });
    return (good as unknown as { client: { fetch: typeof globalThis.fetch } }).client.fetch(url, init);
  };
  const model = new AnthropicModel(new Anthropic({ apiKey: "x", baseURL: "https://openrouter.test/api", maxRetries: 0, fetch: fetch as unknown as typeof globalThis.fetch }), {
    includeUsage: true,
  });
  const turn = await model.turn({ model: "m", system: { stable: "s", volatile: "" }, messages: [{ role: "user", content: "hi" }], tools: [], effort: "low" } as never);
  expect(turn.text).toBe("hi");
  expect(seen.bodies).toHaveLength(2);
});
