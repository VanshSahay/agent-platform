// The public web: search and read. Everything that comes back is untrusted content.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { def, obj, str, num, ToolError } from "./index";

function isPrivateIp(ip: string) {
  const v4 = ip.replace(/^::ffff:/i, "").match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) { const [a, b] = [Number(v4[1]), Number(v4[2])]; return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || a >= 224; }
  const x = ip.toLowerCase();
  return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80");
}
/** Public http(s) only: the literal host and every address it resolves to. */
export async function assertPublicUrl(raw: string) {
  let u: URL; try { u = new URL(raw); } catch { throw new ToolError("BUSINESS_RULE", "invalid URL"); }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!/^https?:$/.test(u.protocol) || /^(localhost|.*\.(internal|local|localhost))$/i.test(host)) throw new ToolError("PERMISSION", "only public http(s) URLs are allowed");
  const addrs = isIP(host) ? [{ address: host }] : await dnsLookup(host, { all: true }).catch(() => { throw new ToolError("BUSINESS_RULE", `can't resolve ${host}`); });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new ToolError("PERMISSION", "only public http(s) URLs are allowed");
  return u;
}

def({
  id: "web.search", kind: "read", description: "Search the web. Returns titles, URLs and snippets. Cite the URL when you use a result.",
  inputSchema: obj({ query: str(), max: num() }, ["query"]),
  async execute({ query, max = 6 }) {
    const n = Math.min(10, Math.max(1, max));
    let results: { title: string; url: string; snippet: string }[] = [];
    if (process.env.EXA_API_KEY) {
      const r = await fetch("https://api.exa.ai/search", { method: "POST", headers: { "x-api-key": process.env.EXA_API_KEY, "content-type": "application/json" }, body: JSON.stringify({ query, numResults: n, contents: { highlights: true } }), signal: AbortSignal.timeout(20_000) });
      results = ((await r.json()) as any).results?.map((x: any) => ({ title: x.title, url: x.url, snippet: (x.highlights ?? []).join(" ").slice(0, 300) })) ?? [];
    } else if (process.env.BRAVE_API_KEY) {
      const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`, { headers: { "x-subscription-token": process.env.BRAVE_API_KEY }, signal: AbortSignal.timeout(20_000) });
      results = ((await r.json()) as any).web?.results?.map((x: any) => ({ title: x.title, url: x.url, snippet: x.description })) ?? [];
    } else {
      // ponytail: keyless DuckDuckGo HTML; set EXA_API_KEY or BRAVE_API_KEY for a real search API.
      const html = await (await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) })).text();
      for (const m of html.matchAll(/<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)) {
        const href = decodeURIComponent(m[1].match(/uddg=([^&]+)/)?.[1] ?? m[1]);
        results.push({ title: m[2].replace(/<[^>]+>/g, ""), url: href, snippet: m[3].replace(/<[^>]+>/g, "").slice(0, 300) });
        if (results.length >= n) break;
      }
    }
    return { status: "SUCCEEDED", untrusted: true, output: { results } };
  },
});

def({
  id: "web.fetch", kind: "read", description: "Fetch a public web page and return its readable text.",
  inputSchema: obj({ url: str() }, ["url"]),
  async execute({ url }) {
    const u = await assertPublicUrl(url);
    const r = await fetch(u, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; agent-platform)" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new ToolError("BUSINESS_RULE", `fetch failed (${r.status})`);
    const text = (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 15_000);
    return { status: "SUCCEEDED", untrusted: true, output: { url: r.url, text } };
  },
});
