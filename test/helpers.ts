import { evalWorld } from "../src/eval/world.ts";
import { type Script, ScriptedModel } from "../src/model/scripted.ts";
import type { Delivery } from "../src/runtime/runtime.ts";
import type { FakeHands } from "../src/tools/hands.ts";

/** A group: Alex (owner), Sam (member, consented), Jo (member, low tech comfort), Riley (guest). The eval world with a scripted model. */
export function groupWorld(script: Script, opts: { completer?: (system: string, prompt: string) => string } & Partial<FakeHands> = {}) {
  const { completer, ...fakes } = opts;
  const model = new ScriptedModel(script, completer);
  const w = evalWorld({ model, hands: fakes });
  const { app, clock, hands, deliveries, agent, room, ownerDm, samDm, alex, sam, jo, riley } = w;
  return { app, clock, model, hands, deliveries, agent, room, ownerDm, samDm, alex, sam, jo, riley };
}

export const repliesTo = (deliveries: Delivery[], roomId: string) => deliveries.filter((d) => d.roomId === roomId && d.kind === "reply").map((d) => d.text);
export const noticesTo = (deliveries: Delivery[], roomId: string) => deliveries.filter((d) => d.roomId === roomId && d.kind !== "reply").map((d) => d.text);
