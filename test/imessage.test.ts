import { describe, expect, test } from "bun:test";
import { HandleRateLimit, handleMatches, normaliseHandle, personIdForHandle, roleForNewcomer } from "../src/channels/handles.ts";

describe("imessage handles", () => {
  test("a handle normalises to one spelling: phones lose punctuation, emails lose case", () => {
    expect(normaliseHandle(" +1 (408) 555-0100 ")).toBe("+14085550100");
    expect(normaliseHandle("Ellie@Example.com")).toBe("ellie@example.com");
  });

  test("distinct handles never share a person id, and the same handle always gets the same one", () => {
    const a = personIdForHandle("+14085550100");
    expect(a).toBe(personIdForHandle("+1 408 555 0100"));
    expect(a).toMatch(/^per_im_[0-9a-f]{20}$/);
    // The old scheme stripped everything but letters and digits, so these two collided.
    expect(personIdForHandle("+1408555010")).not.toBe(personIdForHandle("1408555010"));
    expect(personIdForHandle("a.b@x.com")).not.toBe(personIdForHandle("ab@x.com"));
  });

  test("the owner is recognised by phone or by email, however it is spaced or cased", () => {
    const ellie = { phoneE164: "+1 408 555 0100", email: "Ellie@Example.com" };
    expect(handleMatches(ellie, "+14085550100")).toBe(true);
    expect(handleMatches(ellie, "ellie@example.com")).toBe(true);
    expect(handleMatches(ellie, "+14085550101")).toBe(false);
    expect(handleMatches({}, "")).toBe(false);
  });

  test("a stranger is a guest in a DM as much as in a group; only the owner is an owner", () => {
    expect(roleForNewcomer({ isOwner: false, kind: "dm" })).toBe("guest");
    expect(roleForNewcomer({ isOwner: false, kind: "group" })).toBe("guest");
    expect(roleForNewcomer({ isOwner: true, kind: "dm" })).toBe("owner");
  });

  test("a handle gets twenty messages in ten minutes, then waits for the window to slide", () => {
    const limit = new HandleRateLimit(20, 10 * 60 * 1000);
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) expect(limit.allow("+14085550100", t0 + i)).toBe(true);
    expect(limit.allow("+14085550100", t0 + 21)).toBe(false);
    expect(limit.allow("+1 408 555 0100", t0 + 22)).toBe(false);
    expect(limit.allow("+14085550199", t0 + 22)).toBe(true);
    expect(limit.allow("+14085550100", t0 + 10 * 60 * 1000 + 1)).toBe(true);
  });
});
