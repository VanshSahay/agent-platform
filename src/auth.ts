// Web sign-in with Clerk. The browser sends its Clerk session token; we verify it per request (no sessions of our own)
// and map the Clerk user to our users row. The phone number stays the person's identity in iMessage; the web account
// links to it with a code the agent texts (web.ts).
import { sql, id, now, one } from "./db";

export const clerkOn = () => !!process.env.CLERK_SECRET_KEY;
export const clerkPublishableKey = () => process.env.CLERK_PUBLISHABLE_KEY ?? process.env.VITE_CLERK_PUBLISHABLE_KEY ?? null;
/** Tests swap the verifier for a fake. */
export const hooks: { verify: null | ((token: string) => Promise<{ clerkId: string; email: string; name: string }>) } = { verify: null };

async function verify(token: string) {
  if (hooks.verify) return hooks.verify(token);
  const { verifyToken, createClerkClient } = await import("@clerk/backend");
  const parties = [new URL(process.env.PUBLIC_URL ?? "http://localhost:3000").origin, ...(process.env.CLERK_AUTHORIZED_PARTIES ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
  const claims = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY!, authorizedParties: parties });
  const cu = await createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! }).users.getUser(claims.sub);
  const primary = cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId);
  if (!primary || primary.verification?.status !== "verified") throw new Error("verify your email with Clerk first");
  return { clerkId: cu.id, email: primary.emailAddress.toLowerCase(), name: [cu.firstName, cu.lastName].filter(Boolean).join(" ") || cu.username || primary.emailAddress.split("@")[0] };
}

export class AuthError extends Error { status = 401; }

/** The signed-in person, created on first sign-in. */
export async function userOf(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (!token) throw new AuthError("sign in required");
  if (!clerkOn() && !hooks.verify) throw new AuthError("sign-in isn't set up on this server (CLERK_SECRET_KEY)");
  const c = await verify(token).catch((e) => { throw new AuthError(e.message ?? "Clerk session is invalid or expired"); });
  let u = await one(sql`select * from users where clerk_id=${c.clerkId}`) ?? await one(sql`select * from users where email=${c.email} and clerk_id is null`);
  if (u) { if (!u.clerk_id) { await sql`update users set clerk_id=${c.clerkId} where id=${u.id}`; u.clerk_id = c.clerkId; } return u; }
  const uid = id("usr");
  await sql`insert into users (id, email, name, clerk_id, created_at) values (${uid}, ${c.email}, ${c.name}, ${c.clerkId}, ${now()})`;
  return one(sql`select * from users where id=${uid}`);
}
