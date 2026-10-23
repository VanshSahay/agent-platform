import { plainText } from "../src/channels/handles.ts";
import { describe, expect, test } from "bun:test";
import {
  claimLinkCode,
  groupRoomName,
  HandleRateLimit,
  handleMatches,
  isDefaultRoomName,
  LINK_CODE_TTL_MS,
  LINK_GUESSES_PER_WINDOW,
  mintLinkCode,
  normaliseHandle,
  personIdForHandle,
  roleForNewcomer,
} from "../src/channels/handles.ts";
import { reply } from "../src/model/scripted.ts";
import { groupWorld } from "./helpers.ts";

describe("imessage handles", () => {
  test("a handle normalises to one spelling: phones lose punctuation, emails lose case", () => {
    expect(normaliseHandle(" +1 (408) 555-0100 ")).toBe("+14085550100");
    expect(normaliseHandle("Alex@Example.com")).toBe("alex@example.com");
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
    const alex = { phoneE164: "+1 408 555 0100", email: "Alex@Example.com" };
    expect(handleMatches(alex, "+14085550100")).toBe(true);
    expect(handleMatches(alex, "alex@example.com")).toBe(true);
    expect(handleMatches(alex, "+14085550101")).toBe(false);
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

describe("text channels get plain text", () => {
  test("markdown is flattened before it goes out to iMessage or WhatsApp", () => {
    expect(
      plainText(
        'Two decks:\n```cards\n[{"title":"Dalí set","price":"$60","note":"in stock","url":"https://m.example/d","tag":"pick"},{"title":"Hermès deck","price":"€165"}]\n```\nThe Dalí set is the real deck.',
      ),
    ).toBe("Two decks:\n1. Dalí set — $60 · in stock · my pick\n   https://m.example/d\n2. Hermès deck — €165\nThe Dalí set is the real deck.");
    expect(plainText("**Classics:**\n- **Loop** — 3.8 mi, *hard*.\n\n\n## Easy\nSee [the map](https://example.com/map.pdf) or `signage`.")).toBe(
      "Classics:\n- Loop — 3.8 mi, hard.\n\nEasy\nSee the map https://example.com/map.pdf or signage.",
    );
  });
});

describe("linking a phone by code", () => {
  test("a code from Settings, texted from a new number, writes that number onto the person; it works once and expires", () => {
    const w = groupWorld(() => reply("ok"));
    const code = mintLinkCode(w.app.store, "alex", w.clock.now());
    expect(code).toMatch(/^\d{8}$/);
    expect(claimLinkCode(w.app.store, "hello", "+14085550199", w.clock.now())).toBeUndefined();
    expect(claimLinkCode(w.app.store, "00000000", "+14085550199", w.clock.now())).toBeUndefined();
    const linked = claimLinkCode(w.app.store, ` ${code} `, "+1 (408) 555-0199", w.clock.now() + 1000)!;
    expect(linked.id).toBe("alex");
    expect(w.app.store.getPerson("alex")!.phoneE164).toBe("+14085550199");
    expect(handleMatches(w.app.store.getPerson("alex")!, "+14085550199")).toBe(true);
    expect(claimLinkCode(w.app.store, code, "+14085550199", w.clock.now())).toBeUndefined(); // consumed
    const stale = mintLinkCode(w.app.store, "sam", w.clock.now());
    expect(claimLinkCode(w.app.store, stale, "sam@example.com", w.clock.now() + LINK_CODE_TTL_MS + 1)).toBeUndefined();
  });
});

describe("where people are", () => {
  test("wrong code guesses are capped across every handle, so rotating numbers buys no extra tries", () => {
    const w = groupWorld(() => reply("ok"));
    const code = mintLinkCode(w.app.store, "alex", w.clock.now());
    const wrong = code === "11111111" ? "22222222" : "11111111";
    for (let i = 0; i < LINK_GUESSES_PER_WINDOW; i++) expect(claimLinkCode(w.app.store, wrong, `+1408555${String(i).padStart(4, "0")}`, w.clock.now())).toBeUndefined();
    // The real code no longer links in this window: guessing paused it for everyone.
    expect(claimLinkCode(w.app.store, code, "+14085559999", w.clock.now())).toBeUndefined();
    expect(w.app.store.getPerson("alex")!.phoneE164).not.toBe("+14085559999");
  });

  test("a group on a text channel is named by who is in it until the owner names it", () => {
    expect(groupRoomName("imessage", ["Sam"])).toBe("iMessage · Sam");
    expect(groupRoomName("imessage", ["Sam", "Riley", "Jo", "Mia", "Lee"])).toBe("iMessage · Sam, Riley, Jo & 2 more");
    expect(isDefaultRoomName("iMessage · Sam")).toBe(true);
    expect(isDefaultRoomName("imessage group ab12cd")).toBe(true);
    expect(isDefaultRoomName("Tahoe trip")).toBe(false);
  });

  test("cards for someone who texts the line go to their Messages thread, not a web-only chat", () => {
    const w = groupWorld(() => reply("ok"));
    const web = w.app.rooms.dmFor(w.agent, "sam"); // created on demand, web
    expect(web.channel).toBe("web");
    const im = w.app.rooms.createRoom({ agentId: w.agent.id, kind: "dm", channel: "imessage", externalId: "space-1", name: "Pip & Sam" });
    w.app.rooms.addMember(im.id, "sam", "member");
    expect(w.app.rooms.dmFor(w.agent, "sam").id).toBe(im.id);
  });
});
