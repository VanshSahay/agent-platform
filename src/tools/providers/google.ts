import type { GoogleProvider } from "../hands.ts";

/**
 * Google Workspace through REST with a per-person refresh token (the credential blob the OAuth
 * callback stored: {refresh_token, email}). Access tokens are exchanged on demand and cached in
 * memory; the refresh token never leaves the vault except into this call.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function googleAuthUrl(cfg: { clientId: string; redirectUri: string }, state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  return u.toString();
}

export async function googleExchange(
  cfg: { clientId: string; clientSecret: string; redirectUri: string },
  code: string,
): Promise<{ refresh_token: string; access_token: string; email?: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: "authorization_code" }),
  });
  if (!res.ok) throw new Error(`Google token: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const tok = (await res.json()) as { refresh_token?: string; access_token: string };
  if (!tok.refresh_token) throw new Error("Google did not return a refresh token; remove the app's access at myaccount.google.com and connect again");
  const who = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { authorization: `Bearer ${tok.access_token}` } });
  const info = who.ok ? ((await who.json()) as { email?: string }) : {};
  return { refresh_token: tok.refresh_token, access_token: tok.access_token, email: info.email };
}

export class GoogleApi implements GoogleProvider {
  private cache = new Map<string, { token: string; until: number }>();
  constructor(private cfg: { clientId: string; clientSecret: string }) {}

  private async access(credential: string): Promise<string> {
    const c = JSON.parse(credential) as { refresh_token: string };
    const hit = this.cache.get(c.refresh_token);
    if (hit && hit.until > Date.now()) return hit.token;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ refresh_token: c.refresh_token, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: "refresh_token" }),
    });
    if (!res.ok) throw new Error(`Google refresh failed (${res.status}); reconnect Google in Settings`);
    const tok = (await res.json()) as { access_token: string; expires_in?: number };
    this.cache.set(c.refresh_token, { token: tok.access_token, until: Date.now() + ((tok.expires_in ?? 3600) - 60) * 1000 });
    return tok.access_token;
  }

  async request(
    credential: string,
    req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; body?: unknown; query?: Record<string, string | undefined>; raw?: boolean },
  ): Promise<unknown> {
    const token = await this.access(credential);
    const url = new URL(req.url);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method: req.method,
      headers: { authorization: `Bearer ${token}`, ...(req.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
    if (req.raw || !text) return text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
