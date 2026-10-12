// Magic links the agent texts: connect Google, add a device (MCP), see the trace. Personal, single purpose, short-lived.
import { sql, id, now, one } from "./db";

export const publicUrl = () => (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");

export async function makeLink(userId: string, purpose: "google" | "mcp" | "trace", state: any = {}, ttlMs = 24 * 36e5) {
  const token = id("lnk") + id("");
  await sql`delete from links where expires_at<${now()}`;
  await sql`insert into links (token, user_id, purpose, state, expires_at) values (${token}, ${userId}, ${purpose}, ${JSON.stringify(state)}::text::jsonb, ${now() + ttlMs})`;
  return `${publicUrl()}/${purpose === "trace" ? "t" : `connect/${purpose}`}?t=${token}`;
}
export const takeLink = (token: string, purpose: string) => one(sql`select * from links where token=${token} and purpose=${purpose} and expires_at>${now()}`);
