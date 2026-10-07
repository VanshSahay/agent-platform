// The permanent public link. The app runs on the host Mac (Postgres, Temporal, its Messages app); a quick Cloudflare tunnel
// exposes it under a random address that changes on restart. This Worker sits at a fixed workers.dev address and forwards
// everything to whatever that address is now (ORIGIN, updated by scripts/tunnel.sh each time the tunnel starts).
const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Back soon</title>
<body style="font:16px system-ui;display:grid;place-items:center;min-height:90vh;margin:0;background:#f6f5f2;color:#222"><div style="max-width:420px;padding:24px;text-align:center">
<h1 style="font-size:22px">Back in a moment</h1><p>The app is restarting or its host is offline. Try again in a minute.</p></div>`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!env.ORIGIN) return new Response(OFFLINE, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
    const origin = env.ORIGIN.replace(/\/$/, "");
    const fwd = new Request(origin + url.pathname + url.search, req); // keeps method, body, upgrades (websockets)
    fwd.headers.set("x-forwarded-host", url.host);
    fwd.headers.set("x-forwarded-proto", "https");
    let res;
    try { res = await fetch(fwd, { redirect: "manual" }); }
    catch { res = null; }
    // 52x/530 = the tunnel behind ORIGIN is gone (host asleep, restarting): a friendly page, not Cloudflare's error.
    if (!res || (res.status >= 520 && res.status <= 530)) return new Response(OFFLINE, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "30" } });
    const loc = res.headers.get("location");
    if (loc?.startsWith(origin)) { const h = new Headers(res.headers); h.set("location", url.origin + loc.slice(origin.length)); return new Response(res.body, { status: res.status, headers: h }); }
    return res;
  },
};
