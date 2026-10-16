import { describe, expect, test } from "bun:test";
import { callTool, reply, toolCallsSoFar } from "../src/model/scripted.ts";
import { groupWorld, repliesTo } from "./helpers.ts";
import { FakeGoogle, FakeSlack } from "../src/tools/hands.ts";
import { freeSlots } from "../src/tools/catalog/google.ts";
import { TOOLS } from "../src/tools/registry.ts";

/** A scripted model that calls one tool once, then replies. */
const once =
  (name: string, input: unknown, text = "Done.") =>
  (req: Parameters<typeof toolCallsSoFar>[0]) =>
    toolCallsSoFar(req).some((c) => c.name === name) ? reply(text) : callTool(name, input);

describe("the catalogue", () => {
  test("matches Fo's 80 tool names, plus ours", () => {
    const names = new Set(TOOLS.map((t) => t.spec.name));
    const fo = [
      "list_events",
      "create_calendar",
      "check_availability",
      "find_mutual_availability",
      "create_event",
      "update_event",
      "delete_event",
      "move_events",
      "search_emails",
      "get_email_content",
      "label_email",
      "archive_email",
      "remove_email_label",
      "send_email_as_user",
      "find_files",
      "list_in_folder",
      "get_metadata",
      "share",
      "create_form",
      "get_spreadsheet",
      "update_spreadsheet",
      "search_user_spreadsheets",
      "get_slide_thumbnail",
      "append_slides",
      "replace_slide",
      "delete_slide",
      "get_connect_link",
      "request_call",
      "list_tasks",
      "get_task",
      "schedule_action",
      "list_scheduled_actions",
      "cancel_scheduled_action",
      "update_task_status",
      "browser_use",
      "wait_for_user_input",
      "connector_call",
      "get_current_time",
      "run_javascript",
      "search_tools",
      "publish_dashboard",
      "read_dashboard",
      "list_past_sessions",
      "get_session_transcript",
      "load_workspace_context",
      "search_memory",
      "present_files",
      "write_document",
      "generate_image",
      "analyze_image",
      "load_soul_document",
      "email_load_thread",
      "email_load_unprocessed",
      "slack_load_recent",
      "slack_load_aggregates",
      "slack_search_messages",
      "whatsapp_load_recent",
      "whatsapp_load_conversation",
      "whatsapp_get_summary",
      "web_search",
      "web_scrape",
      "capture_and_analyze",
      "search_products",
      "add_to_cart",
      "view_cart",
      "remove_from_cart",
      "checkout_cart",
      "save_address",
      "list_saved_addresses",
      "delete_saved_address",
      "text_to_speech",
      "send_sms",
      "register_pronunciations",
      "list_sms_groups",
      "place_call",
      "place_vendor_call",
      "search_contacts",
      "add_contact",
      "mcp_call",
    ];
    const missing = fo.filter((n) => !names.has(n));
    expect(missing).toEqual([]);
    expect(names.has("send_agent_email")).toBe(true); // Fo's send_wajo_email
    expect(fo.length + 1).toBe(80);
    expect(new Set(TOOLS.map((t) => t.spec.name)).size).toBe(TOOLS.length); // no duplicate names
  });

  test("free slots skip busy blocks and keep working hours", () => {
    const day = Date.UTC(2026, 9, 14, 0, 0, 0); // midnight UTC
    const h = (x: number) => day + x * 3600_000;
    const slots = freeSlots([{ start: h(10), end: h(11) }], { start: h(0), end: h(24) }, 60, { start: 9, end: 12 }, "UTC");
    expect(slots.map((x) => [new Date(x.start).getUTCHours(), new Date(x.end).getUTCHours()])).toEqual([
      [9, 10],
      [11, 12],
    ]);
  });

  test("a Google tool on your own account just runs; on someone else's it asks them", async () => {
    const google = new FakeGoogle(() => ({ id: "evt_1", htmlLink: "https://calendar.google.com/evt_1" }));
    const w = groupWorld(once("create_event", { title: "Cabin check-in", start: "2026-11-20T15:00:00Z", end: "2026-11-20T16:00:00Z" }), { google });
    w.app.vault.put("alex", "google", JSON.stringify({ refresh_token: "r" }));
    const own = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip put the check-in on my calendar" });
    expect(own?.status).toBe("done");
    expect(google.requests[0]!.url).toContain("/calendars/primary/events");
    expect(w.app.store.toolCallsForRun(own!.id)[0]!.evidence).toBe("google:event:evt_1");
    // Riley is a guest: the event would land on Alex's calendar, so Alex is asked first.
    const guest = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip put the check-in on the calendar" });
    expect(guest?.status).toBe("waiting");
    expect(w.app.attention.openFor("alex")[0]!.kind).toBe("guest_request");
    expect(google.requests).toHaveLength(1);
  });

  test("Google tools say so when the account is not connected", async () => {
    const w = groupWorld(once("list_events", {}, "Not connected."));
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip what's on my calendar?" });
    const call = w.app.store.toolCallsForRun(run!.id)[0]!;
    expect(call.status).toBe("failed");
    expect(String(call.result)).toContain("Google is not connected");
  });

  test("Slack tools use the person's own token from the vault", async () => {
    const slack = new FakeSlack((method) =>
      method === "conversations.list"
        ? { ok: true, channels: [{ id: "C1", name: "trip", num_members: 4 }] }
        : { ok: true, messages: [{ user: "U1", text: "cabin booked", ts: "1792000000.000" }] },
    );
    const w = groupWorld(once("slack_load_recent", { channel: "#trip" }), { slack });
    w.app.vault.put("alex", "slack", "xoxb-test");
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip what's new in #trip on slack?" });
    expect(slack.calls.map((c) => c.method)).toEqual(["conversations.list", "conversations.history"]);
    expect(w.app.store.toolCallsForRun(run!.id)[0]!.evidence).toBe("slack:history:C1");
  });

  test("write_document stores an artifact people can open at /d/:id", async () => {
    const w = groupWorld(once("write_document", { title: "Packing list", markdown: "# Packing\n- boots" }));
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip write the packing list" });
    const call = w.app.store.toolCallsForRun(run!.id)[0]!;
    const { documentId, url } = call.result as { documentId: string; url: string };
    expect(url).toContain(`/d/${documentId}`);
    expect(w.app.store.getArtifact(documentId)!.kind).toBe("document");
    expect(call.labelDone).toBe('Wrote "Packing list"');
  });

  test("checkout asks the owner, mints a single-use card into the vault, and never shows the number", async () => {
    const w = groupWorld((req) => {
      const calls = toolCallsSoFar(req);
      if (!calls.some((c) => c.name === "add_to_cart")) return callTool("add_to_cart", { title: "AA batteries", url: "https://walgreens.com/p/aa", priceUsd: 12 });
      if (!calls.some((c) => c.name === "save_address")) return callTool("save_address", { label: "Home", line1: "1 Main St", city: "San Jose" });
      if (calls.filter((c) => c.name === "checkout_cart").length < 2 && !JSON.stringify(req.messages).includes("single-use card")) return callTool("checkout_cart", {});
      return reply("Ordered.");
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip buy AA batteries from walgreens" });
    expect(run?.status).toBe("waiting");
    const card = w.app.attention.openFor("alex")[0]!;
    expect(card.kind).toBe("purchase_approval");
    expect(card.title).toContain("$12.00");
    await w.app.runtime.answerAttention(card.id, "Yes", "alex");
    expect(w.app.store.getRun(run!.id)!.status).toBe("done");
    expect(w.hands.payments.cards).toEqual([{ amountUsd: 12, merchant: "walgreens.com", personId: "alex" }]);
    expect(w.app.vault.services("alex")).toContain("card:card_1");
    const transcript = JSON.stringify(w.app.store.toolCallsForRun(run!.id).map((c) => c.result));
    expect(transcript).not.toContain("4242424242424242");
    expect(repliesTo(w.deliveries, w.room.id).at(-1)).toContain("Checkout at walgreens.com: $12.00");
  });

  test("send_agent_email goes from the assistant's own address after a yes", async () => {
    const w = groupWorld((req) =>
      toolCallsSoFar(req).some((c) => c.name === "send_agent_email" && JSON.stringify(req.messages).includes("Sent from"))
        ? reply("Emailed them.")
        : callTool("send_agent_email", { to: ["host@lakeview.example"], subject: "Hot tub", text: "Could someone look at the hot tub before Friday?" }),
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip email the host about the hot tub" });
    expect(run?.status).toBe("waiting");
    const item = w.app.attention.openFor("alex")[0]!;
    expect(item.kind).toBe("outreach_approval");
    await w.app.runtime.answerAttention(item.id, "Yes", "alex");
    expect(w.hands.email.sent).toEqual([
      { to: ["host@lakeview.example"], cc: [], subject: "Hot tub", text: "Could someone look at the hot tub before Friday?", replyToMessageId: undefined },
    ]);
  });

  test("mcp_call lists and calls tools on a connected server, through the vault", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { id: number; method: string; params?: { name?: string; arguments?: unknown } };
        const result =
          body.method === "initialize"
            ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "t", version: "1" } }
            : body.method === "tools/list"
              ? { tools: [{ name: "echo", description: "Echoes.", inputSchema: { type: "object" } }] }
              : { content: [{ type: "text", text: `echo:${JSON.stringify(body.params?.arguments)}` }] };
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });
    try {
      const w = groupWorld((req) => {
        const calls = toolCallsSoFar(req);
        if (!calls.length) return callTool("mcp_call", { server: "notes" });
        if (calls.length === 1) return callTool("mcp_call", { server: "notes", tool: "echo", args: { hi: 1 } });
        return reply("ok");
      });
      w.app.vault.put("alex", "mcp:notes", JSON.stringify({ url: `http://127.0.0.1:${server.port}/mcp` }));
      const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip use notes" });
      const calls = w.app.store.toolCallsForRun(run!.id);
      expect((calls[0]!.result as { name: string }[])[0]!.name).toBe("echo");
      expect(calls[1]!.result).toBe('echo:{"hi":1}');
      expect(calls[1]!.labelDone).toBe("notes · echo");
    } finally {
      server.stop(true);
    }
  });

  test("connector_call indexes an OpenAPI document and calls an operation with the stored token", async () => {
    let seenAuth = "";
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/openapi.json") return Response.json({ paths: { "/pets/{id}": { get: { operationId: "getPet", summary: "One pet" } } } });
        seenAuth = req.headers.get("authorization") ?? "";
        return Response.json({ id: u.pathname.split("/").pop(), name: "Rex" });
      },
    });
    try {
      const w = groupWorld((req) => (toolCallsSoFar(req).length ? reply("ok") : callTool("connector_call", { connector: "pets", operationId: "getPet", params: { id: 7 } })));
      w.app.vault.put(
        "alex",
        "api:pets",
        JSON.stringify({ baseUrl: `http://127.0.0.1:${server.port}`, openapiUrl: `http://127.0.0.1:${server.port}/openapi.json`, token: "sekret" }),
      );
      const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip look up pet 7" });
      expect(w.app.store.toolCallsForRun(run!.id)[0]!.result).toBe('{"id":"7","name":"Rex"}');
      expect(seenAuth).toBe("Bearer sekret");
    } finally {
      server.stop(true);
    }
  });

  test("run_javascript runs a snippet and returns what it printed", async () => {
    const w = groupWorld(once("run_javascript", { code: "console.log(new Date(2026, 10, 20).getDay(), 240/4)" }));
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip what day is the 20th and what's the split?" });
    expect((w.app.store.toolCallsForRun(run!.id)[0]!.result as { stdout: string }).stdout.trim()).toBe("5 60");
  });
});
