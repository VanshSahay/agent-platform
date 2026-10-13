import { describe, expect, test } from "bun:test";
import { ExaSearch, JinaReader, mcpText, parseExa } from "../src/tools/reach.ts";

const PLACES = `Title: Mandarin speaking handyman San Jose - Exa Places
URL: https://exa.ai/library/places?q=abc
Published: 2026-10-13
Author: N/A
Highlights:
# Mandarin speaking handyman San Jose - Exa Places

Ten places are listed here.
...
## Torres handyman services

Torres handyman services is a home service at 2085 McLaughlin Ave, San Jose. It is rated 5.0 from 24 ratings.
...
- Phone: +16506427332
- Rating: 5.0 stars (24 ratings)
...
## Foxtrot Handyman

Foxtrot Handyman is a home service at 1684 Miami Dr, San Jose.
`;
const PAGES = `Title: Send a photo or video
URL: https://support.apple.com/a
Published: 2026-01-01
Author: Apple
Highlights:
Tap the camera button, then choose a photo.
...
Title: Share content in Messages
URL: https://support.apple.com/b
Highlights:
Tap the plus button.
`;

describe("Exa search", () => {
  test("a places answer becomes one result per business with the phone in the snippet", () => {
    const r = parseExa(PLACES);
    expect(r.map((x) => x.title)).toEqual(["Torres handyman services", "Foxtrot Handyman"]);
    expect(r[0]!.snippet).toContain("+16506427332");
    expect(r[0]!.snippet).not.toContain("...");
  });

  test("ordinary web results keep one result per page", () => {
    const r = parseExa(PAGES);
    expect(r).toHaveLength(2);
    expect(r[1]).toEqual({ title: "Share content in Messages", url: "https://support.apple.com/b", snippet: "Tap the plus button." });
  });

  test("the MCP reply is read whether it comes as JSON or as a server-sent event", () => {
    const payload = JSON.stringify({ result: { content: [{ type: "text", text: PAGES }] } });
    expect(mcpText(payload)).toBe(PAGES);
    expect(mcpText(`event: message\ndata: ${payload}\n\n`)).toBe(PAGES);
  });

  test("the provider posts a tools/call with near appended and never throws on failure", async () => {
    const calls: { url: string; body: string }[] = [];
    const good = new ExaSearch(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response(JSON.stringify({ result: { content: [{ type: "text", text: PLACES }] } }), { status: 200 });
    });
    const r = await good.search("Mandarin speaking handyman", { near: "San Jose", limit: 1 });
    expect(JSON.parse(calls[0]!.body).params.arguments.query).toBe("Mandarin speaking handyman San Jose");
    expect(r.results).toHaveLength(1);
    expect(r.evidence).toMatch(/^exa:[0-9a-f]{12}$/);
    const down = new ExaSearch(async () => new Response("nope", { status: 503 }));
    expect((await down.search("x")).results).toEqual([]);
    expect((await down.search("x")).evidence).toMatch(/:http-503$/);
    const broken = new ExaSearch(async () => {
      throw new Error("net");
    });
    expect((await broken.search("x")).evidence).toMatch(/:failed$/);
  });
});

describe("Jina reader", () => {
  test("turns a page into title, text and links, and says it cannot click", async () => {
    const md = `Title: Foxtrot Handyman\nURL Source: http://x\n\nMarkdown Content:\nCall us [here](tel:1) or see [our area](https://www.foxtrothandyman.com/san-jose-ca).`;
    const j = new JinaReader(async (url: string | URL | Request) => new Response(String(url).startsWith("https://r.jina.ai/http://x") ? md : "", { status: 200 }));
    const p = await j.readPage({ url: "http://x", action: { click: "a" } });
    expect(p.title).toBe("Foxtrot Handyman");
    expect(p.links).toEqual([{ text: "our area", href: "https://www.foxtrothandyman.com/san-jose-ca" }]);
    expect(p.text).toContain("cannot click");
    expect(p.evidence).toBe("jina:1");
  });
});
