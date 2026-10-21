import { askFirst, n, num, obj, s, str, type ToolDef } from "../../kit.ts";
import { DRIVE, FORMS, g, guard, list, gtool } from "./shared.ts";

const defs: ToolDef[] = [
  {
    spec: {
      name: "find_files",
      description: "Search the person's Google Drive by name or content.",
      input_schema: obj({ query: str("Words to search for."), limit: num("Default 10.") }, ["query"]),
    },
    family: "google",
    labels: { running: "Searching Drive…", done: "Searched Drive" },
    sideEffect: false,
    async run(input, ctx) {
      const q = s(input.query).replace(/'/g, "\\'");
      const r = await g<{ files?: { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string }[] }>(ctx, {
        method: "GET",
        url: `${DRIVE}/files`,
        query: {
          q: `(name contains '${q}' or fullText contains '${q}') and trashed = false`,
          pageSize: String(Math.min(100, Math.max(1, n(input.limit) ?? 10))),
          fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
        },
      });
      return { ok: true, content: r.files ?? [], evidence: "google:drive:search", label: `Searched Drive: ${s(input.query).slice(0, 40)}` };
    },
  },
  {
    spec: {
      name: "list_in_folder",
      description: "List what is in a Drive folder.",
      input_schema: obj({ folderId: str("Folder id, or 'root'."), limit: num("Default 50.") }, ["folderId"]),
    },
    family: "google",
    labels: { running: "Listing a folder…", done: "Listed a folder" },
    sideEffect: false,
    async run(input, ctx) {
      const r = await g<{ files?: unknown[] }>(ctx, {
        method: "GET",
        url: `${DRIVE}/files`,
        query: {
          q: `'${s(input.folderId).replace(/'/g, "")}' in parents and trashed = false`,
          pageSize: String(Math.min(200, Math.max(1, n(input.limit) ?? 50))),
          fields: "files(id,name,mimeType,modifiedTime,webViewLink,size)",
        },
      });
      return { ok: true, content: r.files ?? [], evidence: "google:drive:list" };
    },
  },
  {
    spec: {
      name: "get_metadata",
      description: "Details of a Drive file: owner, size, when changed, who it is shared with.",
      input_schema: obj({ fileId: str("File id.") }, ["fileId"]),
    },
    family: "google",
    labels: { running: "Reading file metadata…", done: "Read file metadata" },
    sideEffect: false,
    async run(input, ctx) {
      const r = await g(ctx, {
        method: "GET",
        url: `${DRIVE}/files/${encodeURIComponent(s(input.fileId))}`,
        query: { fields: "id,name,mimeType,size,createdTime,modifiedTime,owners,permissions,webViewLink,parents" },
      });
      return { ok: true, content: r, evidence: `google:drive:${s(input.fileId)}` };
    },
  },
  {
    spec: {
      name: "share",
      description: "Share a Drive file with someone (Google emails them). Asks first.",
      input_schema: obj(
        {
          fileId: str("File id."),
          email: str("Who to share with."),
          role: { type: "string", enum: ["reader", "commenter", "writer"], description: "Default reader." },
          message: str("Optional note in the email."),
        },
        ["fileId", "email"],
      ),
    },
    family: "google",
    labels: { running: "Sharing a file…", done: "Shared a file" },
    sideEffect: true,
    async run(input, ctx) {
      const gate = ctx.gate({
        kind: "outreach_approval",
        title: `OK to share a file with ${s(input.email)}?`,
        detail: `File ${s(input.fileId)} as ${s(input.role) || "reader"}. Google will email them.`,
        outreach: { who: s(input.email), how: "email", contact: s(input.email) },
        key: ["share", s(input.fileId), s(input.email), s(input.role)],
      });
      const held = askFirst(gate, "Waiting for the OK before sharing.");
      if (held) return held;
      await g(ctx, {
        method: "POST",
        url: `${DRIVE}/files/${encodeURIComponent(s(input.fileId))}/permissions`,
        query: { sendNotificationEmail: "true", emailMessage: s(input.message) || undefined },
        body: { type: "user", role: s(input.role) || "reader", emailAddress: s(input.email) },
      });
      return { ok: true, content: `Shared with ${s(input.email)}.`, evidence: `google:drive:shared:${s(input.fileId)}` };
    },
  },
  {
    spec: {
      name: "create_form",
      description: "Make a Google Form (a poll for the group, an RSVP, a sign-up) with questions. Returns the link to fill it in.",
      input_schema: obj(
        {
          title: str("Form title."),
          questions: {
            type: "array",
            items: obj({ text: str("The question."), options: list("Choices; empty for a text answer."), required: { type: "boolean" } }, ["text"]),
            description: "Questions in order.",
          },
        },
        ["title"],
      ),
    },
    family: "google",
    labels: { running: "Making a form…", done: "Made a form" },
    sideEffect: true,
    async run(input, ctx) {
      const held = guard(ctx, `OK to create a form "${s(input.title)}" on your Drive?`, "", ["create_form", s(input.title)]);
      if (held) return held;
      const form = await g<{ formId: string; responderUri?: string }>(ctx, { method: "POST", url: FORMS, body: { info: { title: s(input.title) } } });
      const qs = Array.isArray(input.questions) ? (input.questions as { text?: unknown; options?: unknown; required?: unknown }[]) : [];
      const requests = qs.slice(0, 30).map((q, i) => {
        const options = (Array.isArray(q.options) ? q.options : []).map((o) => s(o)).filter(Boolean);
        return {
          createItem: {
            location: { index: i },
            item: {
              title: s(q.text),
              questionItem: {
                question: {
                  required: !!q.required,
                  ...(options.length ? { choiceQuestion: { type: "RADIO", options: options.map((value) => ({ value })) } } : { textQuestion: {} }),
                },
              },
            },
          },
        };
      });
      if (requests.length) await g(ctx, { method: "POST", url: `${FORMS}/${form.formId}:batchUpdate`, body: { requests } });
      const again = await g<{ responderUri?: string }>(ctx, { method: "GET", url: `${FORMS}/${form.formId}` }).catch(() => form);
      return {
        ok: true,
        content: { formId: form.formId, fillInUrl: again.responderUri ?? form.responderUri },
        evidence: `google:form:${form.formId}`,
        label: `Made form "${s(input.title).slice(0, 40)}"`,
      };
    },
  },
  // ---------------------------------------------------------------- Sheets
];
export const GOOGLE_DRIVE_TOOLS = defs.map(gtool);
