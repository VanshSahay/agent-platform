import { describe, expect, test } from "bun:test";
import { BraveSearch, BrowserbaseSearch, createSearch, DuckDuckGoSearch, parseDuckDuckGo, SearchChain } from "../src/tools/search.ts";
import { ExaSearch } from "../src/tools/reach.ts";

const fakeFetch = (status: number, body: string, calls: { url: string; init?: RequestInit }[] = []) => {
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { "content-type": "text/html" } });
  };
  return Object.assign(f, { calls });
};

const DDG_PAGE = `<!DOCTYPE html><html><body>
<div class="result results_links results_links_deep result--ad">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_provider=bing&amp;u3=https%3A%2F%2Fads.example">Sponsored handyman</a></h2>
  <a class="result__snippet" href="https://duckduckgo.com/y.js?x">An ad.</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.yelp.com%2Fsearch%3Ffind_desc%3Dhandyman%26find_loc%3DSan%2BJose%2C%2BCA&amp;rut=abc123">Handyman San Jose, CA - Last Updated October 2026 - <b>Yelp</b></a>
    </h2>
    <div class="result__extras"><div class="result__extras__url"><a class="result__url" href="//duckduckgo.com/l/?uddg=x">www.yelp.com/search</a></div></div>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">What are people saying about <b>handyman</b> services in <b>San Jose</b>, CA? &quot;We had a great experience&quot; &amp; more.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flin-repair.example%2F&amp;rut=def">Lin Home Repair &#x2014; Mandarin speaking</a></h2>
    <div class="result__snippet">Small repairs in San Jose. 普通话.</div>
  </div>
</div>
<div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?rut=nouddg">No target</a></h2></div>
</body></html>`;

const DDG_ANOMALY = `<!DOCTYPE html><html><body><div class="anomaly-modal__modal"><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></div></body></html>`;

describe("DuckDuckGo search", () => {
  test("parses result anchors, decodes the uddg redirect, skips ads and links without a target", () => {
    const results = parseDuckDuckGo(DDG_PAGE);
    expect(results).toEqual([
      {
        title: "Handyman San Jose, CA - Last Updated October 2026 - Yelp",
        url: "https://www.yelp.com/search?find_desc=handyman&find_loc=San+Jose,+CA",
        snippet: 'What are people saying about handyman services in San Jose, CA? "We had a great experience" & more.',
      },
      { title: "Lin Home Repair — Mandarin speaking", url: "https://lin-repair.example/", snippet: "Small repairs in San Jose. 普通话." },
    ]);
  });

  test("honours the limit and appends `near` to the query", async () => {
    const f = fakeFetch(200, DDG_PAGE);
    const ddg = new DuckDuckGoSearch({ fetchImpl: f });
    const r = await ddg.search("handyman", { near: "San Jose", limit: 1 });
    expect(r.results).toHaveLength(1);
    expect(r.evidence).toBe("ddg:1");
    expect(f.calls[0]!.url).toContain(encodeURIComponent("handyman San Jose"));
    expect(((f.calls[0]!.init?.headers ?? {}) as Record<string, string>)["User-Agent"]).toContain("Mozilla");
  });

  test("the bot-check page, a non-200 status and a network error all give no results, never a throw", async () => {
    expect(await new DuckDuckGoSearch({ fetchImpl: fakeFetch(202, DDG_ANOMALY) }).search("x")).toEqual({ results: [], evidence: "ddg:1" });
    expect(await new DuckDuckGoSearch({ fetchImpl: fakeFetch(503, "down") }).search("x")).toEqual({ results: [], evidence: "ddg:1:http-503" });
    const boom = async () => {
      throw new Error("ECONNRESET");
    };
    expect(await new DuckDuckGoSearch({ fetchImpl: boom }).search("x")).toEqual({ results: [], evidence: "ddg:1:failed" });
  });
});

describe("Brave search", () => {
  const BODY = JSON.stringify({
    web: {
      results: [
        { title: "<strong>Lin</strong> Home Repair", url: "https://lin-repair.example/", description: "Mandarin-speaking <strong>handyman</strong> in San Jose &amp; Sunnyvale." },
        { title: "No url here", description: "dropped" },
        { title: "Great Wall Handyman", url: "https://greatwall.example/", description: "Cantonese and Mandarin." },
      ],
    },
  });

  test("maps web.results to title, url and snippet with the markup stripped, sends the token, and biases by `near`", async () => {
    const f = fakeFetch(200, BODY);
    const brave = new BraveSearch("secret-token", { fetchImpl: f });
    const r = await brave.search("Mandarin handyman", { near: "San Jose", limit: 5 });
    expect(r.results).toEqual([
      { title: "Lin Home Repair", url: "https://lin-repair.example/", snippet: "Mandarin-speaking handyman in San Jose & Sunnyvale." },
      { title: "Great Wall Handyman", url: "https://greatwall.example/", snippet: "Cantonese and Mandarin." },
    ]);
    expect(r.evidence).toMatch(/^brave:[0-9a-f]{12}$/);
    const call = f.calls[0]!;
    expect(call.url).toBe(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent("Mandarin handyman San Jose")}&count=5`);
    expect(((call.init?.headers ?? {}) as Record<string, string>)["X-Subscription-Token"]).toBe("secret-token");
  });

  test("the same query gives the same evidence; a bad status or bad JSON gives no results", async () => {
    const a = await new BraveSearch("k", { fetchImpl: fakeFetch(200, BODY) }).search("q");
    const b = await new BraveSearch("k", { fetchImpl: fakeFetch(200, BODY) }).search("q");
    expect(a.evidence).toBe(b.evidence);
    expect((await new BraveSearch("k", { fetchImpl: fakeFetch(429, "{}") }).search("q")).results).toEqual([]);
    expect((await new BraveSearch("k", { fetchImpl: fakeFetch(200, "not json") }).search("q")).results).toEqual([]);
  });
});

describe("createSearch", () => {
  test("picks Brave when BRAVE_API_KEY is set, Exa by default, DuckDuckGo on request", () => {
    expect(createSearch({ BRAVE_API_KEY: "k" })).toBeInstanceOf(BraveSearch);
    expect(createSearch({})).toBeInstanceOf(ExaSearch);
    expect(createSearch({ SEARCH: "duckduckgo" })).toBeInstanceOf(DuckDuckGoSearch);
  });
});

describe("Browserbase search", () => {
  test("posts the query to /v1/search with the key and the Parallel provider, and maps results to title, url and a date snippet", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const bb = new BrowserbaseSearch("bb_test", {
      mode: "fast",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            requestId: "req_1",
            results: [
              { id: "r1", url: "https://shop.example/zalto", title: "Zalto Gravitas", publishedDate: "2026-09-01T00:00:00Z" },
              { id: "r2", title: "no url" },
            ],
          }),
          { status: 200 },
        );
      },
    });
    const r = await bb.search("Zalto Gravitas Omega", { near: "San Jose", limit: 3 });
    expect(calls[0]!.url).toBe("https://api.browserbase.com/v1/search");
    expect((calls[0]!.init!.headers as Record<string, string>)["x-bb-api-key"]).toBe("bb_test");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ query: "Zalto Gravitas Omega San Jose", numResults: 3, provider: "parallel", mode: "fast" });
    expect(r.results).toEqual([{ title: "Zalto Gravitas", url: "https://shop.example/zalto", snippet: "2026-09-01" }]);
    expect(r.evidence).toBe("bb-search:req_1");
  });

  test("a 403 or a network error gives no results and no throw, and the chain falls through to the next engine", async () => {
    const denied = new BrowserbaseSearch("k", { fetchImpl: async () => new Response("{}", { status: 403 }) });
    expect((await denied.search("x")).results).toEqual([]);
    const broken = new BrowserbaseSearch("k", {
      fetchImpl: async () => {
        throw new Error("down");
      },
    });
    expect((await broken.search("x")).evidence).toContain(":failed");
    const chain = new SearchChain([denied, { search: async () => ({ results: [{ title: "t", url: "https://u", snippet: "" }], evidence: "second" }) }]);
    expect((await chain.search("x")).evidence).toBe("second");
    expect(chain.name).toBe("browserbase+search");
  });

  test("createSearch picks Browserbase with Exa behind it when the browser key is set, and Exa alone when SEARCH=exa", () => {
    expect(createSearch({ BROWSERBASE_API_KEY: "k" }).name).toBe("browserbase+exa");
    expect(createSearch({ BROWSERBASE_API_KEY: "k", SEARCH: "exa" }).name).toBe("exa");
    expect(createSearch({}).name).toBe("exa");
  });
});
