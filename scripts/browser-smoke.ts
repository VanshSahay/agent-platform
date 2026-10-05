// Live check of the built-in browser runner on a real site through Browserbase (no model credit needed: actions are scripted
// from what the runner actually observes). Run: bun --env-file=.env.local scripts/browser-smoke.ts
import { hooks } from "../src/model";
import { runBrowserTask } from "../src/browser-agent";

let step = 0;
hooks.model = (req) => {
  const page = req.messages[0].content;
  step++;
  if (step === 1) {
    const link = page.match(/\[(\d+)\] a "(?:Learn more|More information)[^"]*"/);
    if (!link) return { toolCalls: [{ id: "x", name: "done", input: { status: "failed", result: "no link found:\n" + page.slice(0, 400) } }] };
    return { toolCalls: [{ id: "c1", name: "click", input: { i: Number(link[1]) } }] };
  }
  return { toolCalls: [{ id: "d", name: "done", input: { status: "succeeded", result: page.match(/Title: (.*)/)?.[1] ?? "?" } }] };
};
const r = await runBrowserTask({ task: "Open the 'learn more' link and tell me the page title", startUrl: "https://example.com", workspaceId: "smoke" });
console.log(JSON.stringify({ status: r.status, result: r.result, final_url: r.final_url, steps: r.steps, replay: r.replay_url }, null, 2));

// Typing + Enter on a real form
step = 0;
hooks.model = (req) => {
  const page = req.messages[0].content;
  step++;
  if (step === 1) { const box = page.match(/\[(\d+)\] input:(?:text|search) /); return { toolCalls: [{ id: "t", name: "type", input: { i: Number(box?.[1] ?? 1), text: "browserbase", enter: true } }] }; }
  return { toolCalls: [{ id: "d", name: "done", input: { status: "succeeded", result: /browserbase\.com/i.test(page) ? "results include browserbase.com" : "no results: " + page.slice(-300) } }] };
};
const t = await runBrowserTask({ task: "search for browserbase", startUrl: "https://html.duckduckgo.com/html/", workspaceId: "smoke" });
console.log(JSON.stringify({ status: t.status, result: t.result, steps: t.steps }, null, 2));
process.exit(r.status === "succeeded" && /iana/i.test(r.final_url ?? "") && /q=browserbase|browserbase/i.test(t.result) ? 0 : 1);
