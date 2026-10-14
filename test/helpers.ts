import { evalWorld } from "../src/eval/world.ts";
import { type Script, ScriptedModel } from "../src/model/scripted.ts";
import type { Delivery } from "../src/runtime/runtime.ts";
import type { FakeBrowser } from "../src/tools/browser.ts";
import type { FakeCommunity, FakePhone, FakeSearch } from "../src/tools/hands.ts";

/** A family circle: Ellie (owner), Ben (decider, sibling), Mum (cared for), Uncle Wei (guest). The eval world with a scripted model. */
export function familyWorld(
  script: Script,
  opts: { completer?: (system: string, prompt: string) => string; search?: FakeSearch; phone?: FakePhone; community?: FakeCommunity; browser?: FakeBrowser } = {},
) {
  const model = new ScriptedModel(script, opts.completer);
  const w = evalWorld({ model, hands: { search: opts.search, phone: opts.phone, community: opts.community, browser: opts.browser } });
  const { app, clock, hands, deliveries, agent, family, ellieDm, ellie, ben, mum, wei } = w;
  return { app, clock, model, hands, deliveries, agent, family, ellieDm, ellie, ben, mum, wei };
}

export const repliesTo = (deliveries: Delivery[], roomId: string) => deliveries.filter((d) => d.roomId === roomId && d.kind === "reply").map((d) => d.text);
export const noticesTo = (deliveries: Delivery[], roomId: string) => deliveries.filter((d) => d.roomId === roomId && d.kind !== "reply").map((d) => d.text);
