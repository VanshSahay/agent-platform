// Three plain pages and two webhooks. No sessions: every page is reached by a personal link the agent texted.
import { sql, seal, now, one, fmtLocal, spentToday } from "./db";
import { takeLink, publicUrl } from "./links";
import { addMcpConnection } from "./tools/mcp";
import { startLogin, openLogin, finishLogin, normSite } from "./tools/browser";
import * as im from "./imessage";
import * as agent from "./agent";
import { privateRoomOf } from "./rooms";
import { MODEL_CAP_USD } from "./model";
import { BROWSER_CAP } from "./tools/browser";
import { routes as webRoutes } from "./web";
import { clerkOn, clerkPublishableKey } from "./auth";
import app from "../web/index.html";

const esc = (s: any) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const page = (title: string, body: string) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;max-width:560px;margin:8vh auto;padding:0 20px;color:#111}input,button{font:inherit;padding:10px 14px;border-radius:10px;border:1px solid #bbb}button{background:#111;color:#fff;border-color:#111}pre{white-space:pre-wrap;background:#f4f4f4;padding:12px;border-radius:10px}small{color:#666}.ok{color:#1a7f37}.bad{color:#b42318}</style>
${body}`, { headers: { "content-type": "text/html; charset=utf-8" } });
const html = (status: number, title: string, body: string) => new Response(page(title, body).body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const SCOPES = "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/contacts.readonly";

export function serve() {
  return Bun.serve({
    port: Number(process.env.PORT ?? 3000),
    routes: {
      "/": app, "/app": app,
      "/v1/config": () => Response.json({ clerk: clerkOn() ? clerkPublishableKey() : null }),
      ...webRoutes,
      "/health": async () => Response.json({ ok: true, imessage: im.status, model_spent_today_usd: await spentToday("model"), model_cap_usd: MODEL_CAP_USD(), browser_sessions_today: await spentToday("browser"), browser_cap: BROWSER_CAP() }),
      "/webhooks/photon": { POST: (req) => im.webhook(req) },

      "/connect/google": { GET: async (req) => {
        const t = new URL(req.url).searchParams.get("t") ?? "", link = await takeLink(t, "google");
        if (!link) return html(404, "Link expired", `<p class="bad">This link has expired. Ask your assistant for a new one.</p>`);
        if (!process.env.GOOGLE_CLIENT_ID) return html(503, "Not set up", `<p class="bad">Google isn't configured on this server (GOOGLE_CLIENT_ID).</p>`);
        const p = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: `${publicUrl()}/connect/google/callback`, response_type: "code", access_type: "offline", prompt: "consent", state: t, scope: SCOPES });
        return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`, 302);
      } },
      "/connect/google/callback": { GET: async (req) => {
        const q = new URL(req.url).searchParams, link = await takeLink(q.get("state") ?? "", "google");
        if (!link) return html(400, "Link expired", `<p class="bad">This link has expired. Ask your assistant for a new one.</p>`);
        const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ code: q.get("code") ?? "", client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, redirect_uri: `${publicUrl()}/connect/google/callback`, grant_type: "authorization_code" }) });
        const t: any = await r.json();
        if (!r.ok || !t.access_token) return html(502, "Google said no", `<p class="bad">Google didn't complete the connection (${esc(t.error_description ?? t.error ?? r.status)}). Try the link again.</p>`);
        const email = (() => { try { return JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()).email ?? null; } catch { return null; } })();
        await sql`update connections set status='revoked' where user_id=${link.user_id} and provider='google'`;
        await sql`insert into connections (id, user_id, provider, label, account, cred_enc, config, status, created_at) values (${"con_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12)}, ${link.user_id}, 'google', 'Google', ${email}, ${seal({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: now() + t.expires_in * 1000, scope: t.scope })}, '{}'::jsonb, 'active', ${now()})`;
        await sql`delete from links where token=${link.token}`;
        const room = await privateRoomOf(link.user_id);
        if (room) await agent.say(room, `Google connected${email ? ` (${email})` : ""}. Carry on; ask me again and I'll use it.`);
        return page("Connected", `<h1 class="ok">Google connected${email ? ` as ${esc(email)}` : ""}.</h1><p>Go back to Messages and ask your assistant again.</p>`);
      } },

      "/connect/mcp": {
        GET: async (req) => {
          const t = new URL(req.url).searchParams.get("t") ?? "";
          if (!(await takeLink(t, "mcp"))) return html(404, "Link expired", `<p class="bad">This link has expired. Ask your assistant for a new one.</p>`);
          return page("Connect a device", `<h1>Connect a device</h1><p>An MCP server your assistant may use as its hands, such as <a href="https://github.com/leeguooooo/iphone-use">iphone-use</a> running on your Mac, reached through a tunnel. The token is stored encrypted and never shown to the assistant.</p>
<form method="post"><input type="hidden" name="t" value="${esc(t)}"><p><input name="label" placeholder="Name, e.g. My iPhone" required style="width:100%"></p><p><input name="url" type="url" placeholder="https://…/mcp (public https address)" required style="width:100%"></p><p><input name="token" type="password" placeholder="Bearer token (if any)" style="width:100%"></p><button>Connect</button></form>`);
        },
        POST: async (req) => {
          const f = await req.formData(), link = await takeLink(String(f.get("t") ?? ""), "mcp");
          if (!link) return html(404, "Link expired", `<p class="bad">This link has expired.</p>`);
          try {
            const r = await addMcpConnection(link.user_id, String(f.get("label") ?? "Device").slice(0, 40), String(f.get("url")), String(f.get("token") ?? ""));
            await sql`delete from links where token=${link.token}`;
            const room = await privateRoomOf(link.user_id);
            if (room) await agent.say(room, `Device connected: ${f.get("label")} (${r.tools} tools). I'll use it when a task needs your phone.`);
            return page("Connected", `<h1 class="ok">Connected.</h1><p>${r.tools} tools found. Go back to Messages.</p>`);
          } catch (e: any) { return html(502, "Couldn't connect", `<p class="bad">${esc(e.message)}</p><p><a href="javascript:history.back()">Back</a></p>`); }
        },
      },

      "/connect/browser": { GET: async (req) => {
        const q = new URL(req.url).searchParams, t = q.get("t") ?? "", link = await takeLink(t, "browser");
        if (!link) return html(404, "Link expired", `<p class="bad">This link has expired. Ask your agent for a new one.</p>`);
        const site = normSite(q.get("site") || (link.state?.site ?? ""));
        return page(`Sign in to ${site}`, `<style>body{max-width:none;margin:0;padding:16px}#live{width:100%;height:72vh;border:2px solid #111;border-radius:14px;background:#f4f4f4}</style>
<h2 style="margin:0 0 6px">Sign in to ${esc(site)}</h2><p id="hint"><small>A real browser opens below. Sign in as you normally would, then press Done. Your agent never sees your password, only the signed-in browser.</small></p>
<iframe id="live" allow="clipboard-read; clipboard-write" sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe>
<p><button id="done" disabled>Done, I'm signed in</button> <button id="cancel">Cancel</button> <span id="msg"></span></p>
<script>
const t=${JSON.stringify(t)}, site=${JSON.stringify(site)}; let id=null;
const post=(p,b)=>fetch(p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||r.status);return d});
(async()=>{try{const s=await post("/connect/browser/start",{t,site});id=s.id;document.getElementById("live").src=s.live_view_url;await new Promise(r=>setTimeout(r,2500));await post("/connect/browser/open",{t,id});document.getElementById("done").disabled=false;}catch(e){document.getElementById("msg").textContent="Couldn't open the browser: "+e.message;}})();
document.getElementById("done").onclick=async()=>{try{await post("/connect/browser/finish",{t,id});document.body.innerHTML="<h2>Signed in.</h2><p>Your agent can use "+site+" as you now. Go back to your chat.</p>";}catch(e){document.getElementById("msg").textContent=e.message;}};
document.getElementById("cancel").onclick=async()=>{await post("/connect/browser/cancel",{t,id}).catch(()=>{});document.body.innerHTML="<p>Cancelled.</p>";};
</script>`);
      } },
      "/connect/browser/start": { POST: async (req) => {
        const b = await req.json().catch(() => ({})), link = await takeLink(String(b.t ?? ""), "browser");
        if (!link) return Response.json({ error: "link expired" }, { status: 404 });
        try { return Response.json(await startLogin(link.user_id, String(b.site ?? link.state?.site ?? ""))); } catch (e: any) { return Response.json({ error: e.message }, { status: 502 }); }
      } },
      "/connect/browser/open": { POST: async (req) => {
        const b = await req.json().catch(() => ({})), link = await takeLink(String(b.t ?? ""), "browser");
        const c = link ? await one(sql`select * from connections where id=${String(b.id ?? "")} and user_id=${link.user_id} and status='pending'`) : null;
        if (!c) return Response.json({ error: "no such session" }, { status: 404 });
        try { await openLogin(c); return Response.json({ ok: true }); } catch (e: any) { return Response.json({ error: e.message }, { status: 502 }); }
      } },
      "/connect/browser/finish": { POST: async (req) => {
        const b = await req.json().catch(() => ({})), link = await takeLink(String(b.t ?? ""), "browser");
        const c = link ? await one(sql`select * from connections where id=${String(b.id ?? "")} and user_id=${link.user_id} and status='pending'`) : null;
        if (!c) return Response.json({ error: "no such session" }, { status: 404 });
        await finishLogin(c); await sql`delete from links where token=${link!.token}`;
        const room = await privateRoomOf(link!.user_id);
        if (room) await agent.say(room, `Signed in to ${c.account}. I can use it as you now.`);
        return Response.json({ ok: true });
      } },
      "/connect/browser/cancel": { POST: async (req) => {
        const b = await req.json().catch(() => ({})), link = await takeLink(String(b.t ?? ""), "browser");
        if (link) await sql`update connections set status='revoked' where id=${String(b.id ?? "")} and user_id=${link.user_id} and status='pending'`;
        return Response.json({ ok: true });
      } },
      "/t": { GET: async (req) => {
        const link = await takeLink(new URL(req.url).searchParams.get("t") ?? "", "trace");
        if (!link) return html(404, "Link expired", `<p class="bad">This link has expired. Ask your assistant for a new one.</p>`);
        const user = await one(sql`select * from users where id=${link.user_id}`);
        const runs = await sql`select r.*, ro.kind room_kind, ro.name room_name from runs r join rooms ro on ro.id=r.room_id where r.requester_id=${link.user_id} order by r.created_at desc limit 40`;
        const execs = await sql`select * from tool_executions where run_id in (select id from runs where requester_id=${link.user_id} order by created_at desc limit 40) order by created_at`;
        const body = runs.map((r: any) => `<h3>${esc(fmtLocal(Number(r.created_at), user.tz))} · ${esc(r.room_kind === "group" ? r.room_name ?? "group" : "your chat")} · ${esc(r.status)} · ${esc(r.tier)}${r.tier_reason ? ` (${esc(r.tier_reason)})` : ""} · $${Number(r.cost_usd).toFixed(4)}</h3>
<p><b>Asked:</b> ${esc(r.request).slice(0, 400)}</p>${execs.filter((e: any) => e.run_id === r.id).map((e: any) => `<p>${e.verified ? "✓" : e.status === "unknown" ? "?" : e.status === "failed" ? "✗" : "·"} <code>${esc(e.tool)}</code> ${esc(JSON.stringify(e.input)).slice(0, 200)}${e.provider_ref ? ` <small>proof: ${esc(e.provider_ref)}</small>` : ""}</p>`).join("")}${r.reply ? `<pre>${esc(r.reply).slice(0, 1500)}</pre>` : ""}`).join("\n");
        return page("What I did", `<h1>What I did, and why</h1><p><small>Every request, each tool call, and the proof behind each action.</small></p>${body || "<p>Nothing yet.</p>"}`);
      } },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
}
