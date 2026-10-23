import type { HotelOffer, PublicOffer } from "../hands.ts";
import { n, num, obj, s, str, type ToolDef } from "../kit.ts";
import { publicLookupsPaused, saveArtifact } from "./shared.ts";

const usd = (v: number) => `$${v.toFixed(0)}`;
const ymd = /^\d{4}-\d{2}-\d{2}$/;

/** "Hôtel Le K2 Altitude" and "Hotel Le K2 Altitude" are one hotel: accents, "hotel" words and punctuation do not count. */
export const hotelKey = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(hotel|hôtel|residence|residences|and|the|le|la|les|spa)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
export const sameHotel = (a: string, b: string) => {
  const x = hotelKey(a);
  const y = hotelKey(b);
  return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x));
};

const PUBLIC_CACHE_MS = 12 * 60 * 60 * 1000;

interface Row {
  hotel: HotelOffer;
  oursUsd: number;
  pub?: PublicOffer;
}
// No upcharge unless the operator sets one: "through us" is the net rate.
const markup = () => Math.max(0, Number(process.env.HOTEL_MARKUP_PCT ?? 0)) / 100;
const siteLink = (q: { city: string; checkIn: string; checkOut: string; adults: number }) => {
  const base = process.env.HOTEL_SITE_URL;
  if (!base) return undefined;
  return `${base.replace(/\/$/, "")}/hotels?name=${encodeURIComponent(q.city)}&checkin=${q.checkIn}&checkout=${q.checkOut}&rooms=1&adults=${q.adults}&currency=USD`;
};
const rowLine = (r: Row) =>
  `${r.hotel.name}${r.hotel.stars ? ` ${r.hotel.stars}★` : ""}: through us ${usd(r.oursUsd)}${r.hotel.refundable ? " (refundable)" : ""}${
    r.pub
      ? ` · public ${usd(r.pub.totalUsd)} on ${r.pub.seller} (${r.pub.allIn ? (r.pub.taxesEstimated ? "all-in, taxes estimated" : "all-in") : "before taxes & fees"}${r.pub.refundable ? ", refundable" : ""}) · ${r.pub.totalUsd > r.oursUsd ? `save ${usd(r.pub.totalUsd - r.oursUsd)} (${Math.round(((r.pub.totalUsd - r.oursUsd) / r.pub.totalUsd) * 100)}%) with us` : `${usd(r.oursUsd - r.pub.totalUsd)} cheaper there`}${r.pub.listedBelow ? ` · ${r.pub.listedBelow.seller} lists ${usd(r.pub.listedBelow.totalUsd)} before taxes & fees` : ""}`
      : " · no public price found"
  } · ${r.hotel.room}${r.hotel.board ? `, ${r.hotel.board}` : ""}`;

export const HOTEL_TOOLS: ToolDef[] = [
  {
    spec: {
      name: "hotel_compare",
      description:
        "Compare booking through us with the cheapest public price for the same hotels and dates: our price (wholesale net plus our margin) next to the lowest public total found, per hotel, with the saving. Writes a shared page. Ask for dates, city, guests and what they want (stars, budget, area) first if any is missing. Read-only; it books nothing.",
      input_schema: obj(
        {
          city: str("City name, e.g. 'Courchevel'."),
          countryCode: str("Two-letter country code, e.g. 'FR'."),
          checkIn: str("YYYY-MM-DD."),
          checkOut: str("YYYY-MM-DD."),
          adults: num("Adults in one room; default 2."),
          stars: num("Optional: only hotels of this star rating, e.g. 5."),
          maxTotalUsd: num("Optional: drop hotels whose price through us is above this for the whole stay."),
          limit: num("How many hotels to compare; default 8, at most 15."),
        },
        ["city", "countryCode", "checkIn", "checkOut"],
      ),
    },
    family: "search",
    labels: { running: "Comparing hotel prices…", done: "Compared hotel prices", failed: "Couldn't compare hotel prices" },
    sideEffect: false,
    async run(input, ctx) {
      const checkIn = s(input.checkIn);
      const checkOut = s(input.checkOut);
      if (!ymd.test(checkIn) || !ymd.test(checkOut) || checkOut <= checkIn) return { ok: false, content: "Dates must be YYYY-MM-DD with check-out after check-in." };
      const q = {
        city: s(input.city).trim(),
        countryCode: s(input.countryCode).trim().toUpperCase(),
        checkIn,
        checkOut,
        adults: Math.max(1, Math.floor(n(input.adults) ?? 2)),
        stars: n(input.stars),
      };
      const limit = Math.min(15, Math.max(1, Math.floor(n(input.limit) ?? 8)));
      try {
        const ours = await ctx.hands.hotels.rates({ ...q, limit: 20 });
        const max = n(input.maxTotalUsd);
        const rows: Row[] = ours.offers
          .filter((h) => !q.stars || !h.stars || h.stars === q.stars)
          .map((hotel) => ({ hotel, oursUsd: Math.round(hotel.netUsd * (1 + markup())) }))
          .filter((r) => max === undefined || r.oursUsd <= max)
          .slice(0, limit);
        if (!rows.length) return { ok: true, content: "No hotels for those dates.", evidence: ours.evidence, stall: `no hotels for ${q.city} ${checkIn}` };
        // The public side is asked for the star classes we are about to show, so Google's list covers these hotels.
        // A public run costs money ($0.04 on Booking.com, $0.20 on Google), so the prices for the same hotels and stay are kept twelve hours:
        // a rerun, a second member asking, or a tweak to the shortlist does not pay again.
        const classes = [...new Set(rows.map((r) => r.hotel.stars).filter((x): x is number => !!x))].sort();
        const names = rows.map((r) => r.hotel.name);
        const cacheKey = `pubrates:${q.city.toLowerCase()}:${q.countryCode}:${checkIn}:${checkOut}:${q.adults}:${classes.join("")}:${names.slice().sort().join("|").toLowerCase()}`;
        const cached = JSON.parse(ctx.store.getKv(cacheKey) ?? "null") as { at: number; pub: Awaited<ReturnType<typeof ctx.hands.publicRates.search>> } | null;
        const paused = publicLookupsPaused(ctx);
        const pub =
          cached && ctx.clock.now() - cached.at < PUBLIC_CACHE_MS
            ? { ...cached.pub, evidence: `${cached.pub.evidence}:cached` }
            : paused
              ? { offers: [] as PublicOffer[], source: "none", evidence: "", error: paused }
              : await ctx.hands.publicRates.search({ ...q, classes, names }).catch((e: Error) => ({ offers: [] as PublicOffer[], source: "none", evidence: "", error: e.message }));
        if (pub.offers.length && !pub.evidence.endsWith(":cached")) ctx.store.setKv(cacheKey, JSON.stringify({ at: ctx.clock.now(), pub }));
        for (const r of rows) r.pub = pub.offers.find((p) => sameHotel(p.name, r.hotel.name));
        // Savings first, then price; hotels without a public match go last.
        rows.sort((a, b) => (b.pub ? b.pub.totalUsd - b.oursUsd : -1e9) - (a.pub ? a.pub.totalUsd - a.oursUsd : -1e9) || a.oursUsd - b.oursUsd);
        const link = siteLink(q);
        const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);
        const page = saveArtifact(ctx, {
          kind: "hotels",
          title: `Hotels: ${q.city}, ${checkIn} to ${checkOut}`,
          data: {
            city: q.city,
            checkIn,
            checkOut,
            nights,
            adults: q.adults,
            stars: q.stars,
            publicSource: pub.source,
            bookUrl: link,
            rows: rows.map((r) => ({
              name: r.hotel.name,
              stars: r.hotel.stars,
              rating: r.hotel.rating,
              address: r.hotel.address,
              photo: r.hotel.photo,
              room: r.hotel.room,
              board: r.hotel.board,
              refundable: r.hotel.refundable,
              feesAtHotelUsd: r.hotel.excludedFeesUsd,
              oursUsd: r.oursUsd,
              pub: r.pub
                ? {
                    totalUsd: r.pub.totalUsd,
                    seller: r.pub.seller,
                    refundable: r.pub.refundable,
                    url: r.pub.url,
                    allIn: r.pub.allIn,
                    taxesEstimated: r.pub.taxesEstimated,
                    room: r.pub.room,
                    listedBelow: r.pub.listedBelow,
                  }
                : undefined,
            })),
          },
        });
        const matched = rows.filter((r) => r.pub).length;
        return {
          ok: true,
          content: {
            page: page.url,
            publicSource: pub.source,
            matched,
            rows: rows.map(rowLine),
            ...("error" in pub ? { publicError: pub.error } : {}),
            bookThroughUs: link ?? "not configured: tell the owner to set HOTEL_SITE_URL",
          },
          evidence: [ours.evidence, pub.evidence].filter(Boolean).join("+"),
          label: `Compared ${rows.length} hotels in ${q.city}, ${matched} with a public price`,
        };
      } catch (e) {
        return { ok: false, content: `The hotel sources did not answer: ${String((e as Error).message).slice(0, 200)}` };
      }
    },
  },
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
