/**
 * Real search hands. Brave when a key is configured; DuckDuckGo's HTML
 * endpoint otherwise (no key, scraped, rate-limited by them). Both are
 * defensive: a bad status or an unparseable page returns no results rather
 * than throwing, because the tool treats "no results" as a stall the planner
 * can act on, while a thrown error just fails the step.
 */

import { sha256 } from "../core/ids.ts";
import { ExaSearch } from "./reach.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
import type { SearchProvider, SearchResult } from "./hands.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 15_000;

export class BraveSearch implements SearchProvider {
  readonly name = "brave";
  private fetchImpl: FetchLike;
  private timeoutMs: number;
  constructor(
    private apiKey: string,
    opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(query: string, opts: { near?: string; limit?: number } = {}) {
    const q = opts.near ? `${query} ${opts.near}` : query;
    const limit = clampLimit(opts.limit);
    const evidence = `brave:${sha256([q]).slice(0, 12)}`;
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${limit}`;
    let body: unknown;
    try {
      const res = await this.fetchImpl(url, {
        headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return { results: [], evidence: `${evidence}:http-${res.status}` };
      body = await res.json();
    } catch {
      return { results: [], evidence: `${evidence}:failed` };
    }
    return { results: parseBrave(body).slice(0, limit), evidence };
  }
}

/** Map Brave's `web.results[]` to our shape; titles and descriptions carry <strong> markup. */
export function parseBrave(body: unknown): SearchResult[] {
  const web = (body as { web?: { results?: unknown } } | null)?.web;
  const rows = Array.isArray(web?.results) ? (web!.results as Record<string, unknown>[]) : [];
  const out: SearchResult[] = [];
  for (const r of rows) {
    const url = typeof r.url === "string" ? r.url : "";
    const title = stripTags(typeof r.title === "string" ? r.title : "");
    if (!url || !title) continue;
    out.push({ title, url, snippet: stripTags(typeof r.description === "string" ? r.description : "") });
  }
  return out;
}

export class DuckDuckGoSearch implements SearchProvider {
  readonly name = "duckduckgo";
  private fetchImpl: FetchLike;
  private timeoutMs: number;
  private userAgent: string;
  private calls = 0;
  constructor(opts: { fetchImpl?: FetchLike; timeoutMs?: number; userAgent?: string } = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = opts.userAgent ?? DEFAULT_UA;
  }

  async search(query: string, opts: { near?: string; limit?: number } = {}) {
    const q = opts.near ? `${query} ${opts.near}` : query;
    const limit = clampLimit(opts.limit);
    const evidence = `ddg:${++this.calls}`;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    let html: string;
    try {
      const res = await this.fetchImpl(url, {
        headers: { "User-Agent": this.userAgent, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return { results: [], evidence: `${evidence}:http-${res.status}` };
      html = await res.text();
    } catch {
      return { results: [], evidence: `${evidence}:failed` };
    }
    return { results: parseDuckDuckGo(html, limit), evidence };
  }
}

/**
 * Parse DuckDuckGo's HTML result page. Each organic result has an
 * `a.result__a` whose href is a redirect carrying the real URL in `uddg=`,
 * and a `.result__snippet` sibling. The anomaly (bot-check) page has neither,
 * so it parses to nothing, which is what we want.
 */
export function parseDuckDuckGo(html: string, limit = 8): SearchResult[] {
  const out: SearchResult[] = [];
  const anchor = /<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/g;
  const anchors: { index: number; end: number; href: string; title: string }[] = [];
  for (let m = anchor.exec(html); m; m = anchor.exec(html)) {
    const href = /\bhref="([^"]*)"/.exec(m[1] ?? "")?.[1] ?? "";
    anchors.push({ index: m.index, end: m.index + m[0].length, href: decodeEntities(href), title: cleanText(m[2] ?? "") });
  }
  for (let i = 0; i < anchors.length && out.length < limit; i++) {
    const a = anchors[i]!;
    const url = resolveRedirect(a.href);
    if (!url || !a.title) continue;
    const until = anchors[i + 1]?.index ?? html.length;
    const between = html.slice(a.end, until);
    const snip = /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/.exec(between);
    out.push({ title: a.title, url, snippet: cleanText(snip?.[1] ?? "") });
  }
  return out;
}

/** `//duckduckgo.com/l/?uddg=<encoded url>&rut=...` becomes the real URL; ads (y.js) and non-http links are dropped. */
function resolveRedirect(href: string): string | undefined {
  let h = href.trim();
  if (h.startsWith("//")) h = `https:${h}`;
  try {
    const u = new URL(h, "https://duckduckgo.com");
    if (u.hostname.endsWith("duckduckgo.com")) {
      const target = u.searchParams.get("uddg");
      if (!target) return undefined;
      h = target;
    }
    const final = new URL(h);
    return final.protocol === "http:" || final.protocol === "https:" ? final.toString() : undefined;
  } catch {
    return undefined;
  }
}

function clampLimit(n: number | undefined) {
  return Math.max(1, Math.min(20, Math.floor(n ?? 8)));
}

function stripTags(s: string) {
  return decodeEntities(s.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(s: string) {
  return stripTags(s);
}

function decodeEntities(s: string) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Browserbase Search (docs.browserbase.com/platform/search): POST /v1/search with the
 * same key as the browser. The "parallel" provider answers in well under a second with
 * titles and links; its results carry no snippet, so the page is what the agent reads.
 * Modes: fast ($1 per 1,000) or advanced ($5, the provider's default). 120 requests a minute.
 */
export class BrowserbaseSearch implements SearchProvider {
  readonly name = "browserbase";
  constructor(
    private apiKey: string,
    private opts: { mode?: "fast" | "advanced"; fetchImpl?: Fetch; timeoutMs?: number } = {},
  ) {}

  async search(query: string, opts: { near?: string; limit?: number } = {}): Promise<{ results: SearchResult[]; evidence: string }> {
    const q = (opts.near ? `${query} ${opts.near}` : query).slice(0, 200);
    const evidence = `bb-search:${sha256([q]).slice(0, 12)}`;
    try {
      const res = await (this.opts.fetchImpl ?? fetch)("https://api.browserbase.com/v1/search", {
        method: "POST",
        headers: { "x-bb-api-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ query: q, numResults: Math.min(Math.max(opts.limit ?? 8, 1), 25), provider: "parallel", mode: this.opts.mode ?? "advanced" }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
      if (!res.ok) return { results: [], evidence: `${evidence}:http-${res.status}` };
      const j = (await res.json()) as { requestId?: string; results?: { url?: string; title?: string; author?: string; publishedDate?: string }[] };
      const results = (j.results ?? [])
        .filter((r) => typeof r.url === "string" && r.url)
        .map((r) => ({ title: r.title?.trim() || r.url!, url: r.url!, snippet: [r.author, r.publishedDate?.slice(0, 10)].filter(Boolean).join(" · ") }));
      return { results, evidence: j.requestId ? `bb-search:${j.requestId}` : evidence };
    } catch {
      return { results: [], evidence: `${evidence}:failed` };
    }
  }
}

/** Providers in order; the first with results answers, so a quota or an outage never means "nothing found". */
export class SearchChain implements SearchProvider {
  readonly name: string;
  constructor(private chain: SearchProvider[]) {
    this.name = chain.map((c) => (c as { name?: string }).name ?? "search").join("+");
  }
  async search(query: string, opts: { near?: string; limit?: number } = {}): Promise<{ results: SearchResult[]; evidence: string }> {
    let last = { results: [] as SearchResult[], evidence: "search:none" };
    for (const p of this.chain) {
      last = await p.search(query, opts);
      if (last.results.length) return last;
    }
    return last;
  }
}

/**
 * Brave when keyed; else Browserbase Search (Parallel) when the browser key is there, with
 * Exa behind it; else Exa, which needs no key and answers local-business queries with names
 * and phone numbers. SEARCH=exa or SEARCH=duckduckgo forces one.
 */
export function createSearch(env: Record<string, string | undefined> = process.env): SearchProvider & { name: string } {
  if (env.BRAVE_API_KEY) return new BraveSearch(env.BRAVE_API_KEY);
  if (env.SEARCH === "duckduckgo") return new DuckDuckGoSearch();
  if (env.BROWSERBASE_API_KEY && env.SEARCH !== "exa") {
    const mode = env.BROWSERBASE_SEARCH_MODE === "fast" ? "fast" : "advanced";
    return new SearchChain([new BrowserbaseSearch(env.BROWSERBASE_API_KEY, { mode }), new ExaSearch()]);
  }
  return new ExaSearch();
}
