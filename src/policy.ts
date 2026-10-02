// Deterministic policy engine (plan §19). Runs before every tool execution. The model is never asked whether it needs permission.

export type Risk = "read" | "write_internal" | "write_external" | "destructive" | "financial";
export type Mode = "auto" | "first_time" | "ask" | "always_ask" | "never";
export type Decision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL" | "REQUIRE_STRONG_CONFIRMATION";

export interface PolicyFacts {
  toolId: string;
  risk: Risk;
  defaultApproval: "none" | "first_time" | "always";
  agentMode?: Mode;                // agent's configured permission for this tool
  toolAllowed: boolean;            // tool is in the agent's skill set
  requiresConnection?: string;
  connection?: { ownerId: string; visibility: string; status: string; granted: boolean } | null;
  roomHumanIds: string[];          // humans in the room the run belongs to
  blockedSubjects: string[];       // tasks in the room where a human owns it and agent_action = blocked
  inputText: string;               // flattened tool input (for blocked-subject matching)
  priorApproval: boolean;          // this exact call (fingerprint) was approved
  standingGrant: boolean;          // first_time tool already approved once for this agent
  tainted: boolean;                // run has ingested untrusted content (web/email/tool output)
  externalWritesSoFar: number;
  maxAutonomousExternalWrites: number;
}

export function defaultMode(defaultApproval: PolicyFacts["defaultApproval"], risk: Risk): Mode {
  if (risk === "financial") return "always_ask";
  if (risk === "destructive") return "always_ask";
  return defaultApproval === "none" ? "auto" : defaultApproval === "first_time" ? "first_time" : "ask";
}

export function evaluatePolicy(f: PolicyFacts): { decision: Decision; reason: string } {
  const mode = f.agentMode ?? defaultMode(f.defaultApproval, f.risk);
  if (!f.toolAllowed) return { decision: "DENY", reason: `tool ${f.toolId} is not in this agent's skill set` };
  if (mode === "never") return { decision: "DENY", reason: `${f.toolId} is disabled for this agent` };

  if (f.requiresConnection) {
    const c = f.connection;
    if (!c) return { decision: "DENY", reason: `no ${f.requiresConnection} connection available to this agent` };
    if (!c.granted) return { decision: "DENY", reason: `agent has not been granted this ${f.requiresConnection} connection` };
    if (c.status !== "active") return { decision: "DENY", reason: `connection is ${c.status}; owner must reconnect` };
    // A private connection is only usable in rooms its owner participates in (plan §2.6: never one shared credential pool).
    if (c.visibility === "private" && !f.roomHumanIds.includes(c.ownerId))
      return { decision: "DENY", reason: "private connection owner is not a member of this room" };
  }

  const writes = f.risk !== "read" && f.risk !== "write_internal";
  if (writes) {
    const hay = f.inputText.toLowerCase();
    const hit = f.blockedSubjects.find((s) => s && hay.includes(s.toLowerCase()));
    if (hit) return { decision: "DENY", reason: `a human owns work involving "${hit}"; agent action is blocked` };
  }

  if (f.priorApproval) return { decision: "ALLOW", reason: "approved by a human for this exact action" };
  if (f.risk === "financial") return { decision: "REQUIRE_STRONG_CONFIRMATION", reason: "financial actions need explicit confirmation" };
  if (f.risk === "destructive") return { decision: "REQUIRE_APPROVAL", reason: "destructive actions always need approval" };
  if (mode === "always_ask") return { decision: "REQUIRE_APPROVAL", reason: `${f.toolId} always requires approval` };
  if (mode === "ask") return { decision: "REQUIRE_APPROVAL", reason: `${f.toolId} is set to ask first` };
  if (mode === "first_time" && !f.standingGrant) return { decision: "REQUIRE_APPROVAL", reason: `first use of ${f.toolId} needs approval` };

  if (f.risk === "write_external") {
    // Untrusted content can't elevate permissions (plan §21.2): auto external writes after reading untrusted input get a human check.
    if (f.tainted) return { decision: "REQUIRE_APPROVAL", reason: "run read untrusted content; external write needs confirmation" };
    if (f.externalWritesSoFar >= f.maxAutonomousExternalWrites)
      return { decision: "REQUIRE_APPROVAL", reason: "autonomous external write budget reached" };
  }
  return { decision: "ALLOW", reason: `${f.toolId} is automatic` };
}
