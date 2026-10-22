/**
 * Faire (wholesale marketplace) through its External API v2, authorised per person with OAuth.
 * Authorise: https://www.faire.com/oauth2/authorize?applicationId&scope&state&redirectUrl
 * Token:     POST https://www.faire.com/api/external-api-oauth2/token (snake_case body)
 * Calls:     https://www.faire.com/external-api/v2 with X-FAIRE-APP-CREDENTIALS (base64 id:secret)
 *            and X-FAIRE-OAUTH-ACCESS-TOKEN. The app secret stays on the server; the token in the vault.
 */
const AUTHORIZE = "https://www.faire.com/oauth2/authorize";
const TOKEN = "https://www.faire.com/api/external-api-oauth2/token";
export const FAIRE_API = "https://www.faire.com/external-api/v2";

export interface FaireApp {
  applicationId: string;
  applicationSecret: string;
}

/** What the agent needs on a retailer's behalf: read the catalogue and orders, place orders only when asked. */
export const FAIRE_SCOPES = ["READ_PRODUCTS", "READ_ORDERS", "WRITE_ORDERS", "READ_RETAILER", "READ_BRAND"];

export function faireAuthUrl(app: FaireApp, redirectUrl: string, state: string, scopes = FAIRE_SCOPES): string {
  const u = new URL(AUTHORIZE);
  u.searchParams.set("applicationId", app.applicationId);
  u.searchParams.set("scope", scopes.join(","));
  u.searchParams.set("state", state);
  u.searchParams.set("redirectUrl", redirectUrl);
  return u.toString();
}

export async function faireExchange(
  app: FaireApp,
  redirectUrl: string,
  code: string,
  scopes = FAIRE_SCOPES,
): Promise<{ access_token: string; expires_in?: number; scope?: string[] }> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      application_token: app.applicationId,
      application_secret: app.applicationSecret,
      redirect_url: redirectUrl,
      scope: scopes,
      grant_type: "AUTHORIZATION_CODE",
      authorization_code: code,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Faire token exchange ${res.status}: ${String(body.message ?? "").slice(0, 200)}`);
  const token = String(body.access_token ?? body.accessToken ?? "");
  if (!token) throw new Error("Faire returned no access token");
  return {
    access_token: token,
    expires_in: typeof body.expires_in === "number" ? body.expires_in : undefined,
    scope: Array.isArray(body.scope) ? (body.scope as string[]) : undefined,
  };
}

/** One authenticated call; the caller runs it inside vault.use so the token never leaves that scope. */
export async function faireRequest<T = unknown>(app: FaireApp, token: string, req: { method?: string; path: string; query?: Record<string, string>; body?: unknown }): Promise<T> {
  const url = new URL(`${FAIRE_API}${req.path.startsWith("/") ? req.path : `/${req.path}`}`);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: req.method ?? "GET",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "X-FAIRE-APP-CREDENTIALS": Buffer.from(`${app.applicationId}:${app.applicationSecret}`).toString("base64"),
      "X-FAIRE-OAUTH-ACCESS-TOKEN": token,
    },
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Faire ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export function faireApp(env: Record<string, string | undefined> = process.env): FaireApp | undefined {
  return env.FAIRE_APP_ID && env.FAIRE_APP_SECRET ? { applicationId: env.FAIRE_APP_ID, applicationSecret: env.FAIRE_APP_SECRET } : undefined;
}
