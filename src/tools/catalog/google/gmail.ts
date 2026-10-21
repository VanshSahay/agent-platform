import { askFirst, n, num, obj, s, str, type ToolDef } from "../../kit.ts";
import { clip } from "../shared.ts";
import { GMAIL, g, gmailText, guard, header, labelId, list, gtool } from "./shared.ts";

const defs: ToolDef[] = [
  {
    spec: {
      name: "search_emails",
      description: "Search the person's Gmail (Gmail query syntax: from:, subject:, newer_than:7d…).",
      input_schema: obj({ query: str("Gmail search."), limit: num("Default 10.") }, ["query"]),
    },
    family: "google",
    labels: { running: "Searching your inbox…", done: "Searched your inbox" },
    sideEffect: false,
    async run(input, ctx) {
      const r = await g<{ messages?: { id: string; threadId: string }[] }>(ctx, {
        method: "GET",
        url: `${GMAIL}/messages`,
        query: { q: s(input.query), maxResults: String(Math.min(50, Math.max(1, n(input.limit) ?? 10))) },
      });
      const out = [];
      for (const m of (r.messages ?? []).slice(0, 20)) {
        const full = await g<{ id: string; threadId: string; snippet?: string; payload?: { headers?: { name: string; value: string }[] } }>(ctx, {
          method: "GET",
          url: `${GMAIL}/messages/${m.id}`,
          query: { format: "metadata", metadataHeaders: "From" },
        });
        const meta = await g<{ payload?: { headers?: { name: string; value: string }[] } }>(ctx, {
          method: "GET",
          url: `${GMAIL}/messages/${m.id}`,
          query: { format: "metadata" },
        }).catch(() => full);
        out.push({
          id: m.id,
          threadId: m.threadId,
          from: header(meta, "From") ?? header(full, "From"),
          subject: header(meta, "Subject"),
          date: header(meta, "Date"),
          snippet: full.snippet,
        });
      }
      return { ok: true, content: out, evidence: "google:gmail:search", label: `Searched inbox: ${s(input.query).slice(0, 40)}` };
    },
  },
  {
    spec: { name: "get_email_content", description: "Read one email in full.", input_schema: obj({ messageId: str("Message id.") }, ["messageId"]) },
    family: "google",
    labels: { running: "Reading email…", done: "Read email" },
    sideEffect: false,
    async run(input, ctx) {
      const m = await g<{
        id: string;
        threadId: string;
        payload?: { headers?: { name: string; value: string }[]; mimeType?: string; body?: { data?: string }; parts?: unknown[] };
      }>(ctx, { method: "GET", url: `${GMAIL}/messages/${encodeURIComponent(s(input.messageId))}`, query: { format: "full" } });
      return {
        ok: true,
        content: {
          id: m.id,
          threadId: m.threadId,
          from: header(m, "From"),
          to: header(m, "To"),
          subject: header(m, "Subject"),
          date: header(m, "Date"),
          text: clip(gmailText(m), 12_000),
        },
        evidence: `google:gmail:${m.id}`,
      };
    },
  },
  {
    spec: {
      name: "label_email",
      description: "Add a label to an email (created if it does not exist).",
      input_schema: obj({ messageId: str("Message id."), label: str("Label name.") }, ["messageId", "label"]),
    },
    family: "google",
    labels: { running: "Labelling email…", done: "Labelled email" },
    sideEffect: true,
    async run(input, ctx) {
      const held = guard(ctx, `OK to label an email "${s(input.label)}"?`, `Message ${s(input.messageId)}.`, ["label_email", s(input.messageId), s(input.label)]);
      if (held) return held;
      const id = await labelId(ctx, s(input.label), true);
      await g(ctx, { method: "POST", url: `${GMAIL}/messages/${encodeURIComponent(s(input.messageId))}/modify`, body: { addLabelIds: [id] } });
      return { ok: true, content: `Labelled "${s(input.label)}".`, evidence: `google:gmail:label:${id}` };
    },
  },
  {
    spec: { name: "archive_email", description: "Archive an email (remove it from the inbox).", input_schema: obj({ messageId: str("Message id.") }, ["messageId"]) },
    family: "google",
    labels: { running: "Archiving email…", done: "Archived email" },
    sideEffect: false,
    async run(input, ctx) {
      const held = guard(ctx, "OK to archive an email?", `Message ${s(input.messageId)}.`, ["archive_email", s(input.messageId)]);
      if (held) return held;
      await g(ctx, { method: "POST", url: `${GMAIL}/messages/${encodeURIComponent(s(input.messageId))}/modify`, body: { removeLabelIds: ["INBOX"] } });
      return { ok: true, content: "Archived.", evidence: `google:gmail:archived:${s(input.messageId)}` };
    },
  },
  {
    spec: {
      name: "remove_email_label",
      description: "Remove a label from an email.",
      input_schema: obj({ messageId: str("Message id."), label: str("Label name or id.") }, ["messageId", "label"]),
    },
    family: "google",
    labels: { running: "Removing a label…", done: "Removed a label" },
    sideEffect: true,
    async run(input, ctx) {
      const held = guard(ctx, "OK to remove a label from an email?", `Message ${s(input.messageId)}, label ${s(input.label)}.`, [
        "remove_email_label",
        s(input.messageId),
        s(input.label),
      ]);
      if (held) return held;
      const id = await labelId(ctx, s(input.label), false);
      if (!id) return { ok: false, content: "No such label." };
      await g(ctx, { method: "POST", url: `${GMAIL}/messages/${encodeURIComponent(s(input.messageId))}/modify`, body: { removeLabelIds: [id] } });
      return { ok: true, content: "Label removed.", evidence: `google:gmail:unlabel:${id}` };
    },
  },
  {
    spec: {
      name: "send_email_as_user",
      description:
        "Send an email from the person's own Gmail, as them. Only when they have switched on \"send as me\" in Settings; otherwise use send_agent_email (from the assistant's address, cc them). Asks first every time.",
      input_schema: obj(
        { to: list("Recipients."), subject: str("Subject."), text: str("Plain-text body."), cc: list("Cc, optional."), threadId: str("Reply in this Gmail thread, optional.") },
        ["to", "subject", "text"],
      ),
    },
    family: "google",
    labels: { running: "Sending from your Gmail…", done: "Sent from your Gmail" },
    sideEffect: true,
    async run(input, ctx) {
      const person = ctx.store.getPerson(ctx.accountOwnerId);
      if (!person?.sendAsMe)
        return {
          ok: false,
          content: `${person?.displayName ?? "The account owner"} has not allowed sending as them (Settings → Connections → "Send email as me"). Use send_agent_email instead, with them in cc.`,
        };
      const to = (Array.isArray(input.to) ? input.to : []).map((x) => s(x).trim()).filter((x) => /^[^@\s]+@[^@\s]+$/.test(x));
      if (!to.length) return { ok: false, content: "Give at least one valid email address." };
      const cc = (Array.isArray(input.cc) ? input.cc : []).map((x) => s(x).trim()).filter((x) => /^[^@\s]+@[^@\s]+$/.test(x));
      const everyone = [...to, ...cc];
      const gate = ctx.gate({
        kind: "outreach_approval",
        title: `OK to email ${everyone.join(", ")} as you?`,
        detail: `From your Gmail\nSubject: ${s(input.subject)}\n\n${s(input.text).slice(0, 1500)}`,
        outreach: { who: everyone.join(", "), how: "email", contact: everyone.join(",") },
        key: ["send_email_as_user", to, cc, s(input.subject), s(input.text)],
      });
      const held = askFirst(gate, "Waiting for the go-ahead. Nothing was sent.");
      if (held) return held;
      // Headers, one blank line, then the body as given: a body that starts with "Bcc:" stays body.
      const headers = [
        `To: ${to.join(", ")}`,
        cc.length ? `Cc: ${cc.join(", ")}` : "",
        `Subject: ${s(input.subject).replace(/[\r\n]/g, " ")}`,
        "Content-Type: text/plain; charset=utf-8",
      ].filter(Boolean);
      const mime = [...headers, "", s(input.text)].join("\r\n");
      const r = await g<{ id: string }>(ctx, {
        method: "POST",
        url: `${GMAIL}/messages/send`,
        body: { raw: Buffer.from(mime).toString("base64url"), threadId: s(input.threadId) || undefined },
      });
      return { ok: true, content: `Sent as ${person.displayName}.`, evidence: `google:gmail:sent:${r.id}`, label: `Emailed ${to[0]} as ${person.displayName}` };
    },
  },
  // ---------------------------------------------------------------- Drive
];
export const GOOGLE_GMAIL_TOOLS = defs.map(gtool);
