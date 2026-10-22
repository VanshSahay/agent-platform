import { n, num, obj, s, str, type ToolDef } from "../kit.ts";

const usd = (v: number) => `$${v.toFixed(0)}`;
const ymd = /^\d{4}-\d{2}-\d{2}$/;

export const HOTEL_TOOLS: ToolDef[] = [
  {
    spec: {
      name: "hotel_rates",
      description:
        "Hotel prices from the wholesale source for a city and dates: the net total for the stay next to the public price, with board and whether it is refundable. Use for any hotel question before web search. Read-only; it books nothing.",
      input_schema: obj(
        {
          city: str("City name, e.g. 'Barcelona'."),
          countryCode: str("Two-letter country code, e.g. 'ES'."),
          checkIn: str("YYYY-MM-DD."),
          checkOut: str("YYYY-MM-DD."),
          adults: num("Adults in one room; default 2."),
          limit: num("How many hotels; default 10."),
        },
        ["city", "countryCode", "checkIn", "checkOut"],
      ),
    },
    family: "search",
    labels: { running: "Checking hotel rates…", done: "Checked hotel rates", failed: "Couldn't get hotel rates" },
    sideEffect: false,
    async run(input, ctx) {
      const checkIn = s(input.checkIn);
      const checkOut = s(input.checkOut);
      if (!ymd.test(checkIn) || !ymd.test(checkOut) || checkOut <= checkIn) return { ok: false, content: "Dates must be YYYY-MM-DD with check-out after check-in." };
      try {
        const r = await ctx.hands.hotels.rates({
          city: s(input.city).trim(),
          countryCode: s(input.countryCode).trim().toUpperCase(),
          checkIn,
          checkOut,
          adults: Math.max(1, Math.floor(n(input.adults) ?? 2)),
          limit: Math.min(20, Math.max(1, Math.floor(n(input.limit) ?? 10))),
        });
        if (!r.offers.length) return { ok: true, content: "No rates for those dates.", evidence: r.evidence, stall: `no hotel rates for ${s(input.city)} ${checkIn}` };
        const lines = r.offers.map(
          (o) =>
            `${o.name}${o.stars ? ` ${o.stars}★` : ""}${o.rating ? ` (${o.rating})` : ""}: ${usd(o.netUsd)} net${o.publicUsd ? ` vs ${usd(o.publicUsd)} public` : ""}${o.excludedFeesUsd ? ` + ${usd(o.excludedFeesUsd)} paid at the hotel` : ""} · ${o.room}${o.board ? `, ${o.board}` : ""} · ${o.refundable ? "refundable" : "non-refundable"}`,
        );
        return { ok: true, content: lines.join("\n"), evidence: r.evidence, label: `Hotel rates: ${s(input.city)} ${checkIn}` };
      } catch (e) {
        return { ok: false, content: `The hotel source did not answer: ${String((e as Error).message).slice(0, 200)}` };
      }
    },
  },
];
