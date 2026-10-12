// Tool registry and gateway. One file per provider registers its tools here; the gateway validates, applies the one
// permission rule (reads for anyone; a person's accounts only for that person, with consent in groups; writes approved
// by that person), persists every execution with a fingerprint, and marks it verified from provider evidence.
import { sql, id, now, sha, one } from "../db";
import { hasConsent, userById } from "../rooms";
import { makeLink } from "../links";
import { agentOf } from "../agents";

export type ErrKind = "TRANSIENT" | "AUTH" | "RATE_LIMIT" | "BUSINESS_RULE" | "PERMISSION" | "UNKNOWN_SIDE_EFFECT";
export class ToolError extends Error { constructor(public kind: ErrKind, msg: string) { super(msg); } }

export interface Ctx { run: any; room: any; requester: any; connection?: any; idempotencyKey: string }
export interface Outcome { status: "SUCCEEDED" | "FAILED" | "UNKNOWN"; output: any; untrusted?: boolean }
export interface ToolDef {
  id: string; description: string; inputSchema: any;
  kind: "read" | "write";                       // writes are approved by the requester first
  kindOf?: (input: any) => "read" | "write";    // when it depends on the input (browser.task with complete=true)
  connection?: "google" | "mcp";                // uses the requester's own account (or device)
  accountFor?: (input: any, requesterId: string) => Promise<any | null>; // another kind of account (a site login) this call would use
  summarize?: (input: any) => string;           // one line for the approval card and the status footer
  preview?: (input: any) => string;             // the exact content being approved (an email body)
  verify?: (output: any) => string | null;      // provider evidence that proves a write happened
  execute: (input: any, ctx: Ctx) => Promise<Outcome>;
}

export const TOOLS: Record<string, ToolDef> = {};
export const def = (t: ToolDef) => { TOOLS[t.id] = t; };
export const obj = (props: Record<string, any>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
export const str = (description?: string) => ({ type: "string", description });
export const num = (description?: string) => ({ type: "number", description });
export const bool = (description?: string) => ({ type: "boolean", description });
export const kindOf = (d: ToolDef, input: any) => d.kindOf?.(input ?? {}) ?? d.kind;

export function validate(schema: any, v: any, path = "input"): string | null {
  if (schema.type === "object") {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return `${path} must be an object`;
    for (const k of schema.required ?? []) if (v[k] === undefined) return `${path}.${k} is required`;
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      if (!schema.properties?.[k]) { if (schema.additionalProperties === false) return `${path}.${k} is not allowed`; continue; }
      const e = validate(schema.properties[k], val, `${path}.${k}`); if (e) return e;
    }
    return null;
  }
  if (schema.type === "array") return Array.isArray(v) ? v.map((x, i) => validate(schema.items ?? {}, x, `${path}[${i}]`)).find(Boolean) ?? null : `${path} must be an array`;
  if (schema.type === "string") return typeof v !== "string" ? `${path} must be a string` : schema.enum && !schema.enum.includes(v) ? `${path} must be one of ${schema.enum}` : null;
  if (schema.type === "number" || schema.type === "integer") return typeof v === "number" ? null : `${path} must be a number`;
  if (schema.type === "boolean") return typeof v === "boolean" ? null : `${path} must be true or false`;
  return null;
}
export const prune = (input: any) => Object.fromEntries(Object.entries(input).filter(([, v]) => v !== "" && v !== null && !(Array.isArray(v) && v.length === 0)));
const canon = (v: any): string => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${k}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v);
export const fingerprint = (runId: string, tool: string, input: any) => sha(`${runId}|${tool}|${canon(input ?? {})}`);

/** Specs for the model: built-ins plus the requester's MCP tools (devices). */
export async function toolsFor(requesterId: string | null): Promise<ToolDef[]> {
  const { mcpToolsFor } = await import("./mcp");
  return [...Object.values(TOOLS), ...(requesterId ? await mcpToolsFor(requesterId) : [])];
}
export const specsOf = (tools: ToolDef[]) => tools.map((t) => ({ name: t.id, description: t.description, input_schema: t.inputSchema }));
export const summarize = (d: ToolDef, input: any) => d.summarize?.(input ?? {}) ?? `${d.id} ${JSON.stringify(input ?? {}).slice(0, 100)}`;

export type GatewayResult =
  | { kind: "result"; content: string; status: string }
  | { kind: "approval"; summary: string; preview?: string; approver: any }   // this person must say yes first (the requester, or the owner for a guest)
  | { kind: "consent" };                                                     // the requester must allow their accounts in this group

/** Whose accounts and whose yes: a signed-up member acts as themselves; a guest in a group (someone who never signed up)
 *  is served through the owner's accounts, and the owner is the one who says yes. */
export async function principalFor(room: any, requester: any) {
  if (room.kind === "group" && room.owner_id && room.owner_id !== requester.id && !requester.clerk_id) {
    const owner = await userById(room.owner_id);
    if (owner) return { principal: owner, viaOwner: true };
  }
  return { principal: requester, viaOwner: false };
}

export async function execute(run: any, room: any, requester: any, call: { id: string; name: string; input: any }, tools: ToolDef[], opts: { approved?: boolean } = {}): Promise<GatewayResult> {
  const d = tools.find((t) => t.id === call.name);
  if (!d) return { kind: "result", status: "FAILED", content: `DENIED: unknown tool ${call.name}` };
  call = { ...call, input: prune(call.input ?? {}) }; // some models fill every optional field with "" or []; those mean "not given"
  const bad = validate(d.inputSchema, call.input);
  if (bad) return { kind: "result", status: "FAILED", content: `FAILED: invalid input — ${bad}` };

  // The one permission rule. A person's accounts are theirs; in a group they say once that the group may use them.
  // A guest (never signed up) is served through the owner's accounts, and the owner says yes.
  const { principal, viaOwner } = await principalFor(room, requester);
  let connection: any = null;
  if (d.connection) {
    connection = d.connection === "mcp"
      ? await one(sql`select * from connections where user_id=${principal.id} and id=${call.name.split(".")[1]} and status!='revoked'`)
      : await one(sql`select * from connections where user_id=${principal.id} and provider='google' and status!='revoked' order by created_at desc limit 1`);
    if (!connection || connection.status === "needs_reauth") {
      if (viaOwner) return { kind: "result", status: "FAILED", content: `DENIED: this needs ${principal.name ?? "the owner"}'s ${d.connection === "google" ? "Google account" : "device"}, which isn't connected. Tell ${requester.name ?? "them"} plainly that ${principal.name ?? "the owner"} would need to set that up; don't send links to guests.` };
      const link = await makeLink(requester.id, d.connection);
      return { kind: "result", status: "FAILED", content: `DENIED: ${requester.name ?? "they"} ${connection ? "need to reconnect" : "haven't connected"} ${d.connection === "google" ? "Google" : "that device"} yet. Give them this link (personal to them): ${link}` };
    }
  }
  if (!connection && d.accountFor) connection = await d.accountFor(call.input, principal.id);
  if (connection && viaOwner && !room.guest_accounts) return { kind: "result", status: "FAILED", content: `DENIED: ${principal.name ?? "the owner"} hasn't allowed people in this group to use their accounts. Say so plainly.` };
  if (connection && !viaOwner && room.kind === "group" && !(await hasConsent(room.id, requester.id))) return { kind: "consent" };
  const fp = fingerprint(run.id, d.id, call.input);
  // The trust dial: actions the person said may run without asking (Settings). Off by default; the warm-up period.
  const agent = await agentOf(room), trusted = (Array.isArray(agent?.auto_tools) ? agent.auto_tools : []).includes(d.id);
  if (kindOf(d, call.input) === "write" && !opts.approved && !trusted && !(await one(sql`select 1 from approvals where run_id=${run.id} and status='approved' and call->>'fingerprint'=${fp}`)))
    return { kind: "approval", summary: summarize(d, call.input), preview: d.preview?.(call.input ?? {}), approver: principal };

  // Idempotency: the same call in the same run runs once. An interrupted write is never silently retried.
  const prev = await one(sql`select * from tool_executions where fingerprint=${fp}`);
  if (prev?.status === "succeeded") return { kind: "result", status: "SUCCEEDED", content: `[you already ran this; same result]\n${wrap(d, prev.output)}` };
  if (prev && prev.status !== "failed") return { kind: "result", status: "UNKNOWN", content: `UNKNOWN: ${summarize(d, call.input)} was attempted before and never confirmed. Do not retry; tell the person to check.` };
  const exId = prev?.id ?? id("tex");
  await sql`insert into tool_executions (id, run_id, tool, input, status, fingerprint, created_at) values (${exId}, ${run.id}, ${d.id}, ${JSON.stringify(call.input ?? {})}::text::jsonb, 'started', ${fp}, ${now()}) on conflict (fingerprint) do update set status='started'`;
  try {
    const out = await d.execute(call.input ?? {}, { run, room, requester: viaOwner ? principal : requester, connection, idempotencyKey: fp });
    const ref = out.status === "SUCCEEDED" ? d.verify?.(out.output) ?? null : null;
    const verified = kindOf(d, call.input) === "write" ? !!ref : out.status === "SUCCEEDED";
    await sql`update tool_executions set status=${out.status === "UNKNOWN" ? "unknown" : out.status === "FAILED" ? "failed" : "succeeded"}, output=${JSON.stringify(out.output ?? null)}::text::jsonb, provider_ref=${ref}, verified=${verified} where id=${exId}`;
    if (connection) await sql`update connections set last_used_at=${now()} where id=${connection.id}`;
    if (out.status === "UNKNOWN") return { kind: "result", status: "UNKNOWN", content: `UNKNOWN: ${summarize(d, call.input)} got no clear answer from the provider. It may or may not have happened. Do not retry; ask the person to check.` };
    return { kind: "result", status: out.status, content: out.status === "FAILED" ? `FAILED: ${JSON.stringify(out.output).slice(0, 500)}` : wrap(d, out.output, out.untrusted) };
  } catch (e: any) {
    const k: ErrKind = e instanceof ToolError ? e.kind : "UNKNOWN_SIDE_EFFECT";
    if (k === "AUTH" && connection) {
      await sql`update connections set status='needs_reauth' where id=${connection.id}`;
      await sql`update tool_executions set status='failed', output=${JSON.stringify({ error: e.message })}::text::jsonb where id=${exId}`;
      return { kind: "result", status: "FAILED", content: `FAILED: access to ${connection.provider} expired. Reconnect link (personal): ${await makeLink(requester.id, connection.provider)}` };
    }
    if (k === "UNKNOWN_SIDE_EFFECT" && kindOf(d, call.input) === "write") {
      await sql`update tool_executions set status='unknown', output=${JSON.stringify({ error: e.message })}::text::jsonb where id=${exId}`;
      return { kind: "result", status: "UNKNOWN", content: `UNKNOWN: ${summarize(d, call.input)} failed mid-flight (${e.message}). It may have gone through. Do not retry; ask the person to check.` };
    }
    await sql`update tool_executions set status='failed', output=${JSON.stringify({ error: e.message })}::text::jsonb where id=${exId}`;
    return { kind: "result", status: "FAILED", content: `FAILED: ${e.message}` };
  }
}

/** Tool output the model reads. Content from the outside world is fenced so instructions in it are data, not orders. */
function wrap(d: ToolDef, output: any, untrusted = false) {
  const s = JSON.stringify(output ?? null).slice(0, 20_000);
  return untrusted ? `<untrusted tool="${d.id}">\n${s}\n</untrusted>` : s;
}
