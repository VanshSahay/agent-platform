/**
 * Real search hands. Brave when a key is configured; DuckDuckGo's HTML
 * endpoint otherwise (no key, scraped, rate-limited by them). Both are
 * defensive: a bad status or an unparseable page returns no results rather
 * than throwing, because the tool treats "no results" as a stall the planner
 * can act on, while a thrown error just fails the step.
 */

import { sha256 } from "../core/ids.ts";
import { ExaSearch } from "./reach.ts";
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
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
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

/** Brave when a key is configured, otherwise the keyless DuckDuckGo scrape. */
export function createSearch(env: Record<string, string | undefined> = process.env): BraveSearch | DuckDuckGoSearch | ExaSearch {
  if (env.BRAVE_API_KEY) return new BraveSearch(env.BRAVE_API_KEY);
  // Exa's public endpoint needs no key and answers local-business queries with names and phone numbers.
  if (env.SEARCH === "duckduckgo") return new DuckDuckGoSearch();
  return new ExaSearch();
}
