import { createClerkClient, verifyToken } from "@clerk/backend";
import type { App } from "../app.ts";
import { findPersonByEmail } from "../store/queries.ts";
import type { Person } from "../core/types.ts";

/**
 * Who is calling the web API. With Clerk configured, every /api request must
 * carry `Authorization: Bearer <session token>`; the Clerk user is mapped to
 * a Person on first sight (created from their Clerk name and email) and the
 * caller may only act as that person. Without Clerk (local dev), the
 * `personId` in the request body is trusted.
 */
export interface AuthConfig {
  secretKey: string;
  publishableKey: string;
  authorizedParties: string[];
}

export function authConfig(env: Record<string, string | undefined> = process.env): AuthConfig | undefined {
  if (!env.CLERK_SECRET_KEY || !env.CLERK_PUBLISHABLE_KEY) return undefined;
  return {
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    authorizedParties: (env.CLERK_AUTHORIZED_PARTIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** The Clerk frontend API host is encoded in the publishable key. */
export function frontendApiFromKey(publishableKey: string): string | undefined {
  const b64 = publishableKey.replace(/^pk_(test|live)_/, "");
  try {
    return Buffer.from(b64, "base64").toString("utf8").replace(/\$$/, "");
  } catch {
    return undefined;
  }
}

export type Verifier = (token: string) => Promise<{ sub: string } | undefined>;
export type UserLookup = (sub: string) => Promise<{ displayName: string; email?: string } | undefined>;

export class Auth {
  private verifier: Verifier;
  private lookup: UserLookup;
  constructor(
    private app: App,
    cfg: AuthConfig,
    deps: { verifier?: Verifier; lookup?: UserLookup } = {},
  ) {
    this.verifier =
      deps.verifier ??
      (async (token) => {
        try {
          const payload = await verifyToken(token, { secretKey: cfg.secretKey, authorizedParties: cfg.authorizedParties.length ? cfg.authorizedParties : undefined });
          return payload.sub ? { sub: payload.sub } : undefined;
        } catch {
          return undefined;
        }
      });
    this.lookup =
      deps.lookup ??
      (async (sub) => {
        try {
          const client = createClerkClient({ secretKey: cfg.secretKey, publishableKey: cfg.publishableKey });
          const u = await client.users.getUser(sub);
          const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || u.primaryEmailAddress?.emailAddress || sub;
          return { displayName: name, email: u.primaryEmailAddress?.emailAddress ?? undefined };
        } catch {
          return undefined;
        }
      });
  }

  /** Resolve the bearer token to a Person, creating one on first sign-in. */
  async personFor(req: Request): Promise<Person | undefined> {
    const h = req.headers.get("authorization") ?? "";
    let token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    // <img src="/d/…"> and "Open →" links cannot send a header; Clerk keeps the same JWT in a
    // same-origin cookie, accepted for reads, and for writes only with a custom header: a cross-site
    // form cannot set one, and a cross-site fetch that tries gets a preflight this server never answers.
    if (!token && (req.method === "GET" || req.headers.get("x-requested-with") === "circle"))
      token = /(?:^|;\s*)__session=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1]?.trim() ?? "";
    if (!token) return undefined;
    const v = await this.verifier(token);
    if (!v) return undefined;
    const key = `clerk:${v.sub}`;
    const existingId = this.app.store.getKv(key);
    if (existingId) {
      const p = this.app.store.getPerson(existingId);
      if (p) return p;
    }
    const info = (await this.lookup(v.sub)) ?? { displayName: v.sub };
    // A fresh install has an owner's seat nobody has signed in as yet: the first sign-in claims it.
    const claimable = this.app.store.getKv("claim-owner");
    const owner = claimable ? this.app.store.getPerson(claimable) : undefined;
    // With OWNER_EMAIL set, only that address may take the seat; otherwise the first sign-in does.
    const wanted = (process.env.OWNER_EMAIL ?? "").trim().toLowerCase();
    if (owner && (!wanted || (info.email ?? "").toLowerCase() === wanted)) {
      owner.displayName = info.displayName;
      owner.email = info.email ?? owner.email;
      this.app.store.putPerson(owner);
      this.app.store.setKv(key, owner.id);
      this.app.store.deleteKv("claim-owner");
      console.log(`Sign-in: ${info.displayName} is now the owner of the seeded circle`);
      return owner;
    }
    // Someone added to a chat by email before they ever signed in: that record is theirs.
    const invited = info.email ? findPersonByEmail(this.app.store, info.email) : undefined;
    if (invited) {
      invited.displayName = info.displayName;
      this.app.store.putPerson(invited);
      this.app.store.setKv(key, invited.id);
      return invited;
    }
    const person = this.app.rooms.createPerson({ id: `per_${v.sub.replace(/^user_/, "")}`, displayName: info.displayName, email: info.email, timezone: "UTC" });
    this.app.store.setKv(key, person.id);
    return person;
  }
}
