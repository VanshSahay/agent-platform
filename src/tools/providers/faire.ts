/**
 * Faire (wholesale marketplace) through its External API v2, authorised per person with OAuth.
 * Authorise: https://www.faire.com/oauth2/authorize?applicationId&scope&state&redirectUrl
 * Token:     POST https://www.faire.com/api/external-api-oauth2/token (snake_case body)
 * Calls:     https://www.faire.com/external-api/v2 with X-FAIRE-APP-CREDENTIALS (base64 id:secret)
 *            and X-FAIRE-OAUTH-ACCESS-TOKEN. The app secret stays on the server; the token in the vault.
 */
import type { WholesaleBrand, WholesaleProduct, WholesaleProvider } from "../hands.ts";

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

/**
 * The deployment's one Faire shop, used for every chat's group orders. Paths follow Faire's retailer
 * endpoints as far as they are known; each is marked with how sure it is, and an unknown path fails
 * closed with Faire's own error text so the agent says what it could not read.
 */
export class FaireRetailer implements WholesaleProvider {
  constructor(
    private app: FaireApp,
    private token: () => string | undefined,
  ) {}
  private call<T>(req: { method?: string; path: string; query?: Record<string, string>; body?: unknown }): Promise<T> {
    const t = this.token();
    if (!t) throw new Error("Faire is not authorised yet: the shop owner connects it once under Settings → Connections");
    return faireRequest<T>(this.app, t, req);
  }
  async findBrands(query: string, opts: { category?: string; limit?: number } = {}): Promise<WholesaleBrand[]> {
    // Guess: retailer brand search. Verified against Faire's error once a token exists.
    const r = await this.call<{ brands?: Record<string, unknown>[] }>({
      path: "/brands/search",
      query: { query, ...(opts.category ? { category: opts.category } : {}), limit: String(opts.limit ?? 10) },
    });
    return (r.brands ?? []).map((b) => this.toBrand(b));
  }
  async brand(brandId: string) {
    const b = await this.call<Record<string, unknown>>({ path: `/brands/${encodeURIComponent(brandId)}` });
    const p = await this.call<{ products?: Record<string, unknown>[] }>({ path: "/products", query: { brand_id: brandId, limit: "50" } });
    return { brand: this.toBrand(b), products: (p.products ?? []).map((x) => this.toProduct(x, brandId)) };
  }
  async placeOrder(input: { brandId: string; lines: { productId: string; quantity: number }[]; note?: string }) {
    const r = await this.call<Record<string, unknown>>({
      method: "POST",
      path: "/orders",
      body: { brand_id: input.brandId, items: input.lines.map((l) => ({ product_id: l.productId, quantity: l.quantity })), note: input.note },
    });
    const orderId = String(r.id ?? r.order_id ?? "");
    if (!orderId) throw new Error("Faire returned no order id");
    const cents = Number((r.total as { amount_minor?: number } | undefined)?.amount_minor ?? r.total_minor ?? 0);
    return { orderId, totalUsd: cents / 100, evidence: `faire:order:${orderId}` };
  }
  private toBrand(b: Record<string, unknown>): WholesaleBrand {
    const minor = (v: unknown) => Number((v as { amount_minor?: number } | undefined)?.amount_minor ?? (typeof v === "number" ? v : 0)) / 100;
    return {
      id: String(b.id ?? b.token ?? ""),
      name: String(b.name ?? ""),
      category: String(b.category ?? b.categories ?? ""),
      minimumUsd: minor(b.first_order_minimum ?? b.minimum_order_amount),
      reorderMinimumUsd: minor(b.reorder_minimum ?? b.first_order_minimum ?? 0),
      rating: typeof b.rating === "number" ? b.rating : undefined,
      topShop: Boolean(b.top_shop ?? b.is_top_shop),
      url: typeof b.url === "string" ? b.url : undefined,
    };
  }
  private toProduct(x: Record<string, unknown>, brandId: string): WholesaleProduct {
    const minor = (v: unknown) => Number((v as { amount_minor?: number } | undefined)?.amount_minor ?? 0) / 100;
    const variant = (Array.isArray(x.variants) ? (x.variants[0] as Record<string, unknown> | undefined) : undefined) ?? {};
    return {
      id: String(variant.id ?? x.id ?? ""),
      brandId,
      name: String(x.name ?? ""),
      wholesaleUsd: minor(variant.wholesale_price ?? x.wholesale_price),
      retailUsd: minor(variant.retail_price ?? x.retail_price) || undefined,
      caseSize: typeof x.unit_multiplier === "number" ? x.unit_multiplier : undefined,
      inStock: String(variant.available_quantity ?? "1") !== "0",
    };
  }
}

export function faireApp(env: Record<string, string | undefined> = process.env): FaireApp | undefined {
  return env.FAIRE_APP_ID && env.FAIRE_APP_SECRET ? { applicationId: env.FAIRE_APP_ID, applicationSecret: env.FAIRE_APP_SECRET } : undefined;
}
