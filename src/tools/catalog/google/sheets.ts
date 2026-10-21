import { obj, s, str, type ToolDef } from "../../kit.ts";
import { DRIVE, SHEETS, g, guard, gtool } from "./shared.ts";

const defs: ToolDef[] = [
  {
    spec: {
      name: "get_spreadsheet",
      description: "Read cells from a Google Sheet.",
      input_schema: obj({ spreadsheetId: str("Spreadsheet id."), range: str("A1 range, e.g. Sheet1!A1:D50; default the first sheet.") }, ["spreadsheetId"]),
    },
    family: "google",
    labels: { running: "Reading spreadsheet…", done: "Read spreadsheet" },
    sideEffect: false,
    async run(input, ctx) {
      const range = s(input.range) || "A1:Z200";
      const r = await g<{ values?: unknown[][] }>(ctx, { method: "GET", url: `${SHEETS}/${encodeURIComponent(s(input.spreadsheetId))}/values/${encodeURIComponent(range)}` });
      return { ok: true, content: { range, values: (r.values ?? []).slice(0, 500) }, evidence: `google:sheet:${s(input.spreadsheetId)}` };
    },
  },
  {
    spec: {
      name: "update_spreadsheet",
      description: "Write cells into a Google Sheet (rows of values at an A1 range).",
      input_schema: obj(
        {
          spreadsheetId: str("Spreadsheet id."),
          range: str("A1 range to write at, e.g. Sheet1!A2."),
          values: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Rows of cells." },
        },
        ["spreadsheetId", "range", "values"],
      ),
    },
    family: "google",
    labels: { running: "Updating spreadsheet…", done: "Updated spreadsheet" },
    sideEffect: true,
    async run(input, ctx) {
      const held = guard(ctx, "OK to write to your spreadsheet?", `${s(input.spreadsheetId)} at ${s(input.range)}.`, [
        "update_spreadsheet",
        s(input.spreadsheetId),
        s(input.range),
        input.values,
      ]);
      if (held) return held;
      const r = await g<{ updatedCells?: number }>(ctx, {
        method: "PUT",
        url: `${SHEETS}/${encodeURIComponent(s(input.spreadsheetId))}/values/${encodeURIComponent(s(input.range))}`,
        query: { valueInputOption: "USER_ENTERED" },
        body: { values: Array.isArray(input.values) ? input.values : [] },
      });
      return { ok: true, content: { updatedCells: r.updatedCells }, evidence: `google:sheet:${s(input.spreadsheetId)}:updated` };
    },
  },
  {
    spec: { name: "search_user_spreadsheets", description: "Find the person's Google Sheets by name.", input_schema: obj({ query: str("Part of the name; empty for recent.") }) },
    family: "google",
    labels: { running: "Searching spreadsheets…", done: "Searched spreadsheets" },
    sideEffect: false,
    async run(input, ctx) {
      const q = s(input.query).replace(/'/g, "\\'");
      const r = await g<{ files?: unknown[] }>(ctx, {
        method: "GET",
        url: `${DRIVE}/files`,
        query: {
          q: `mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false${q ? ` and name contains '${q}'` : ""}`,
          orderBy: "modifiedTime desc",
          pageSize: "20",
          fields: "files(id,name,modifiedTime,webViewLink)",
        },
      });
      return { ok: true, content: r.files ?? [], evidence: "google:drive:sheets" };
    },
  },
  // ---------------------------------------------------------------- Slides
];
export const GOOGLE_SHEETS_TOOLS = defs.map(gtool);
