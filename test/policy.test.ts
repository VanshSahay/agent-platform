import { test, expect } from "bun:test";
import { evaluatePolicy, type PolicyFacts } from "../src/policy";

const base: PolicyFacts = {
  toolId: "email.send", risk: "write_external", defaultApproval: "always", toolAllowed: true, requiresConnection: "google",
  connection: { ownerId: "u1", visibility: "private", status: "active", granted: true }, roomHumanIds: ["u1"], blockedSubjects: [],
  inputText: "to bob@x.test", priorApproval: false, standingGrant: false, tainted: false, requesterId: "u1", requesterIsMember: true, externalWritesSoFar: 0, maxAutonomousExternalWrites: 3,
};
const d = (f: Partial<PolicyFacts>) => evaluatePolicy({ ...base, ...f }).decision;

test("AC-P1 risk classes map to deterministic decisions", () => {
  expect(d({ risk: "read", defaultApproval: "none", requiresConnection: undefined })).toBe("ALLOW");
  expect(d({ risk: "write_internal", defaultApproval: "none", requiresConnection: undefined })).toBe("ALLOW");
  expect(d({})).toBe("REQUIRE_APPROVAL"); // external write defaults to ask
  expect(d({ risk: "destructive", agentMode: "auto" })).toBe("REQUIRE_APPROVAL"); // destructive always asks, even if configured auto
  expect(d({ risk: "financial", agentMode: "auto" })).toBe("REQUIRE_STRONG_CONFIRMATION");
});

test("AC-P2 agent permission modes: never / first_time / ask / auto, and prior approval of the exact call", () => {
  expect(d({ agentMode: "never" })).toBe("DENY");
  expect(d({ agentMode: "first_time" })).toBe("REQUIRE_APPROVAL");
  expect(d({ agentMode: "first_time", standingGrant: true })).toBe("ALLOW");
  expect(d({ agentMode: "auto" })).toBe("ALLOW");
  expect(d({ priorApproval: true })).toBe("ALLOW");
  expect(d({ toolAllowed: false, agentMode: "auto" })).toBe("DENY");
});

test("AC-P3 connections: must exist, be granted, active, and private ones only where the owner is present", () => {
  expect(d({ connection: null, agentMode: "auto" })).toBe("DENY");
  expect(d({ connection: { ...base.connection!, granted: false }, agentMode: "auto" })).toBe("DENY");
  expect(d({ connection: { ...base.connection!, status: "needs_reauth" }, agentMode: "auto" })).toBe("DENY");
  expect(d({ roomHumanIds: ["u2"], agentMode: "auto" })).toBe("DENY"); // Ellie's Gmail can't be used in a room without Ellie
  expect(d({ roomHumanIds: ["u2"], connection: { ...base.connection!, visibility: "workspace" }, agentMode: "auto" })).toBe("ALLOW");
});

test("AC-P4 blocked subjects deny writes; untrusted input and write budget force approval", () => {
  expect(d({ agentMode: "auto", blockedSubjects: ["Amanda"], inputText: "to amanda@nurse.test Hi Amanda" })).toBe("DENY");
  expect(d({ risk: "read", defaultApproval: "none", blockedSubjects: ["Amanda"], inputText: "Amanda" })).toBe("ALLOW"); // reading is fine
  expect(d({ agentMode: "auto", tainted: true })).toBe("REQUIRE_APPROVAL");
  expect(d({ agentMode: "auto", externalWritesSoFar: 3 })).toBe("REQUIRE_APPROVAL");
  // Approval never overrides a hard deny
  expect(d({ priorApproval: true, blockedSubjects: ["Amanda"], inputText: "Amanda" })).toBe("DENY");
});
