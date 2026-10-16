import { sha256 } from "../core/ids.ts";
import type { SearchProvider, SearchResult } from "./hands.ts";
import type { BrowserProvider, PageRead } from "./browser.ts";

/**
 * Two keyless channels borrowed from Agent Reach (github.com/Panniantong/agent-reach):
 * Exa's public MCP endpoint for search, which answers "Mandarin-speaking handyman
 * San Jose" with named places, ratings and phone numbers, and Jina Reader for
 * turning any page into text. Both are plain HTTP; neither needs an account.
 */
const EXA_MCP = "https://mcp.exa.ai/mcp";
const JINA = "https://r.jina.ai/";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class ExaSearch implements SearchProvider {
  readonly name = "exa";
  constructor(
    private fetchImpl: Fetch = fetch,
    private timeoutMs = 45_000,
  ) {}

  async search(query: string, opts: { near?: string; limit?: number } = {}): Promise<{ results: SearchResult[]; evidence: string }> {
    const q = opts.near ? `${query} ${opts.near}` : query;
    const evidence = `exa:${sha256([q]).slice(0, 12)}`;
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_exa", arguments: { query: q, numResults: Math.min(opts.limit ?? 5, 10) } } };
    let text = "";
    try {
      const res = await this.fetchImpl(EXA_MCP, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return { results: [], evidence: `${evidence}:http-${res.status}` };
      text = mcpText(await res.text());
    } catch {
      return { results: [], evidence: `${evidence}:failed` };
    }
    return { results: parseExa(text).slice(0, opts.limit ?? 5), evidence };
  }
}

/** The endpoint answers as JSON or as one SSE "message" event; both carry the MCP result. */
export function mcpText(raw: string): string {
  const payloads =
    raw.startsWith("event:") || raw.startsWith("data:")
      ? raw
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
      : [raw];
  const out: string[] = [];
  for (const p of payloads) {
    try {
      const j = JSON.parse(p) as { result?: { content?: { type: string; text?: string }[] } };
      for (const c of j.result?.content ?? []) if (c.type === "text" && c.text) out.push(c.text);
    } catch {
      /* not a payload line */
    }
  }
  return out.join("\n");
}

/**
 * Exa's text is a list of "Title: … / URL: … / Highlights: …" blocks. A places answer
 * is one block whose highlights hold "## Name" sections with address, rating and phone;
 * each of those becomes its own result so the agent can compare and call them.
 */
export function parseExa(text: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const block of text.split(/\n(?=Title: )/)) {
    const title = block.match(/^Title: (.*)$/m)?.[1]?.trim() ?? "";
    const url = block.match(/^URL: (.*)$/m)?.[1]?.trim() ?? "";
    if (!title || !url) continue;
    const hl = block.split(/^Highlights:\s*$/m)[1] ?? block.split(/^Text:\s*$/m)[1] ?? "";
    const places = hl.split(/^## /m).slice(1);
    if (places.length) {
      for (const p of places) {
        const [name, ...rest] = p.split("\n");
        const detail = rest
          .map((l) => l.replace(/^\s*-\s*/, "").trim())
          .filter((l) => l && l !== "...")
          .join(" ");
        if (name?.trim()) results.push({ title: name.trim(), url, snippet: detail.slice(0, 400) });
      }
    } else {
      const snippet = hl
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && l !== "...")
        .join(" ")
        .slice(0, 400);
      results.push({ title, url, snippet });
    }
  }
  return results;
}

/** Any public page as text, through Jina Reader. No scripts run, so no clicks or forms. */
export class JinaReader implements BrowserProvider {
  /** Jina reads pages as text; there is nothing to click, so a run is a read of the final URL (the last goto, or the start). */
  async run(input: { url: string; steps: import("./browser.ts").BrowserStep[] }): Promise<import("./browser.ts").BrowserRun> {
    const last = [...input.steps].reverse().find((st) => "goto" in st) as { goto: string } | undefined;
    const page = await this.readPage({ url: last?.goto ?? input.url });
    return { url: page.url, title: page.title, text: page.text, screenshots: [], evidence: page.evidence };
  }

  private calls = 0;
  constructor(
    private fetchImpl: Fetch = fetch,
    private timeoutMs = 45_000,
  ) {}

  async readPage(input: { url: string; contextId?: string; action?: unknown }): Promise<PageRead> {
    const evidence = `jina:${++this.calls}`;
    try {
      const res = await this.fetchImpl(JINA + input.url, { headers: { accept: "text/plain", "x-return-format": "markdown" }, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) return { url: input.url, title: "", text: `Could not read the page (HTTP ${res.status}).`, links: [], evidence: `${evidence}:http-${res.status}` };
      const md = await res.text();
      const title = md.match(/^Title: (.*)$/m)?.[1]?.trim() ?? "";
      const body = md.split(/^Markdown Content:\s*$/m)[1] ?? md;
      const links: PageRead["links"] = [];
      for (const m of body.matchAll(/\[([^\]]{1,80})\]\((https?:\/\/[^)\s]+)\)/g)) if (links.length < 40) links.push({ text: m[1]!, href: m[2]! });
      const note = input.action ? "\n\n(Jina Reader shows pages as text; it cannot click or fill forms. Say what you need and the owner can do it.)" : "";
      return { url: input.url, title, text: body.trim().slice(0, 12_000) + note, links, evidence };
    } catch {
      return { url: input.url, title: "", text: "Could not read the page (network).", links: [], evidence: `${evidence}:failed` };
    }
  }
}
