import type { ToolDef } from "../kit.ts";
import { GOOGLE_CALENDAR_TOOLS } from "./google/calendar.ts";
import { GOOGLE_DRIVE_TOOLS } from "./google/drive.ts";
import { GOOGLE_GMAIL_TOOLS } from "./google/gmail.ts";
import { GOOGLE_SHEETS_TOOLS } from "./google/sheets.ts";
import { GOOGLE_SLIDES_TOOLS } from "./google/slides.ts";

/**
 * Fo's "google" family, 26 tools over one connection per person: Calendar, Gmail, Drive, Forms,
 * Sheets and Slides through the REST APIs, one file each. The credential (a refresh token the OAuth
 * flow stored) never reaches the model: every call runs inside vault.use (see google/shared.ts).
 */
export const GOOGLE_TOOLS: ToolDef[] = [...GOOGLE_CALENDAR_TOOLS, ...GOOGLE_GMAIL_TOOLS, ...GOOGLE_DRIVE_TOOLS, ...GOOGLE_SHEETS_TOOLS, ...GOOGLE_SLIDES_TOOLS];
export { freeSlots } from "./google/shared.ts";
