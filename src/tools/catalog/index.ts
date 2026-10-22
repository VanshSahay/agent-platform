import type { ToolDef } from "../kit.ts";
import { GOOGLE_TOOLS } from "./google.ts";
import { KNOWLEDGE_TOOLS } from "./knowledge.ts";
import { MCP_TOOLS } from "./mcp.ts";
import { OPERATOR_TOOLS } from "./operator.ts";
import { PEOPLE_TOOLS } from "./people.ts";
import { SHOPPING_TOOLS } from "./shopping.ts";
import { GROUP_ORDER_TOOLS } from "./group-order.ts";
import { HOTEL_TOOLS } from "./hotels.ts";

/** Everything beyond the core set, grouped as Fo groups them. */
export const CATALOG_TOOLS: ToolDef[] = [
  ...OPERATOR_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...PEOPLE_TOOLS,
  ...GOOGLE_TOOLS,
  ...SHOPPING_TOOLS,
  ...GROUP_ORDER_TOOLS,
  ...HOTEL_TOOLS,
  ...MCP_TOOLS,
];
