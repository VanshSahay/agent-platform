import { withNeeds, type ToolDef } from "../kit.ts";
import { GOOGLE_TOOLS } from "./google.ts";
import { KNOWLEDGE_TOOLS } from "./knowledge.ts";
import { MCP_TOOLS } from "./mcp.ts";
import { OPERATOR_TOOLS } from "./operator.ts";
import { PEOPLE_TOOLS } from "./people.ts";
import { SHOPPING_TOOLS } from "./shopping.ts";
import { GROUP_ORDER_TOOLS } from "./group-order.ts";
import { FLIGHT_TOOLS } from "./flights.ts";
import { HOTEL_TOOLS } from "./hotels.ts";

/**
 * Everything beyond the core set, grouped as Fo groups them. Families that
 * need a boot-level provider carry `needs`; the rest work on their own (or
 * report a per-person notConnected).
 */
export const CATALOG_TOOLS: ToolDef[] = [
  ...OPERATOR_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...PEOPLE_TOOLS,
  ...withNeeds(GOOGLE_TOOLS, "google"),
  ...withNeeds(SHOPPING_TOOLS, "payments"),
  ...GROUP_ORDER_TOOLS,
  ...withNeeds(HOTEL_TOOLS, "hotels"),
  ...withNeeds(FLIGHT_TOOLS, "flights"),
  ...MCP_TOOLS,
];
