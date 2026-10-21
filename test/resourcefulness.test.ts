import { describe, expect, test } from "bun:test";
import { callTool, lastUserText, reply, toolCallsSoFar, transcriptHas } from "../src/model/scripted.ts";
import { FakeSearch } from "../src/tools/hands.ts";
import { groupWorld, repliesTo } from "./helpers.ts";

const HIT = [{ title: "Zalto Gravitas Omega", url: "https://shop.example/zalto", snippet: "€54.10" }];

describe("resourcefulness guards", () => {
  test("searching in circles opens a plan the model never wrote and moves it to the next rung", async () => {
    const w = groupWorld(
      (req) => {
        const n = toolCallsSoFar(req).filter((c) => c.name === "web_search").length;
        if (n < 6) return callTool("web_search", { query: `zalto glass shop ${n}` });
        return reply("Two shops carry it: shop.example and zalto.shop.");
      },
      { search: new FakeSearch(() => HIT) },
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip find a shop that sells the Zalto Gravitas Omega and ships to the US" });
    const plan = w.app.planner.get(run!.id)!;
    expect(plan.auto).toBe(true);
    expect(plan.goal).toContain("ships to the US");
    // Four searches pass; the fifth and sixth count as stalls, and two stalls move the step from search to browse.
    expect(w.app.planner.activeStep(plan)?.approach).toBe("browse");
    const notes = w.model.calls.at(-1)!.messages.flatMap((m) => (typeof m.content === "string" && m.content.startsWith("[planner]") ? [m.content] : []));
    expect(notes.some((n) => n.includes('the plan now tries "browse"'))).toBe(true);
    expect(run!.status).toBe("done");
  });

  test("a reply that drops a constraint is sent back once with the gap named", async () => {
    const w = groupWorld(
      (req) => {
        if (transcriptHas(req, "[check]")) return reply("Neither shop ships to the US; a US stockist is wineglasses.example.");
        const n = toolCallsSoFar(req).length;
        if (n < 3) return callTool("web_search", { query: `zalto ${n}` });
        return reply("Two German shops carry both glasses.");
      },
      {
        search: new FakeSearch(() => HIT),
        completer: (system) => (system.includes("honours every constraint") ? '{"ok": false, "missing": "ships to the US"}' : ""),
      },
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip find a shop with both glasses that ships to the US" });
    expect(run!.status).toBe("done");
    const replies = repliesTo(w.deliveries, w.room.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("US stockist");
    expect(w.model.completions.filter((c) => c.system.includes("honours every constraint"))).toHaveLength(1);
  });

  test("a short run is not checked, and a judge that returns nothing never blocks a reply", async () => {
    const w = groupWorld((req) => (toolCallsSoFar(req).length ? reply("Found it.") : callTool("web_search", { query: "x" })), { search: new FakeSearch(() => HIT) });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip quick one" });
    expect(run!.status).toBe("done");
    expect(w.model.completions.some((c) => c.system.includes("honours every constraint"))).toBe(false);
    const replies = repliesTo(w.deliveries, w.room.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Found it.");
  });

  test("after eight tool calls the model is told to hand the rest to a task", async () => {
    const w = groupWorld(
      (req) => {
        if (transcriptHas(req, "delegate_task")) return reply("Handing this to a task.");
        const n = toolCallsSoFar(req).length;
        return callTool(n % 2 ? "browse_page" : "web_search", n % 2 ? { url: "https://shop.example/zalto" } : { query: `q${n}` });
      },
      { search: new FakeSearch(() => HIT) },
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip research every shop" });
    expect(run!.status).toBe("done");
    expect(w.app.store.toolCallsForRun(run!.id).length).toBe(8);
    expect(lastUserText(w.model.calls.at(-1)!)).toContain("delegate_task");
  });
});
