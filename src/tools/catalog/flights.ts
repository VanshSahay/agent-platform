import type { Cabin, FlightOffer, PublicFlightOffer } from "../hands.ts";
import { n, num, obj, s, str, type ToolDef } from "../kit.ts";
import { publicLookupsPaused, saveArtifact } from "./shared.ts";

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const ymd = /^\d{4}-\d{2}-\d{2}$/;
const CABINS: Cabin[] = ["economy", "premium_economy", "business", "first"];
const key = (flights: string[]) => flights.map((f) => f.toUpperCase().replace(/\s+/g, "")).join("+");
const hhmm = (iso: string) => iso.slice(11, 16);
const dur = (m: number) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;

interface Row {
  ours?: FlightOffer;
  pub?: PublicFlightOffer;
}
const line = (r: Row) => {
  const f = r.ours ?? r.pub!;
  const legs = f.returnDurationMin !== undefined ? `${dur(f.durationMin)} out, ${dur(f.returnDurationMin)} back` : dur(f.durationMin);
  const stops = f.stops ? `${f.stops} stop${f.stops > 1 ? "s" : ""}${f.returnDurationMin !== undefined ? " each way at most" : ""}` : "nonstop";
  const head = `${f.airline} ${f.flights.join(" > ")} · ${hhmm(f.departAt)}–${hhmm(f.arriveAt)} · ${legs} · ${stops}`;
  const ours = r.ours
    ? `through us ${usd(r.ours.totalUsd)} (${r.ours.cabin}${r.ours.refundable ? ", refundable" : ""}${r.ours.checkedBag ? ", bag included" : ""})`
    : "not in our inventory";
  const pub = r.pub ? `public ${usd(r.pub.totalUsd)} on ${r.pub.seller}` : "no public price";
  const verdict =
    r.ours && r.pub
      ? r.pub.totalUsd > r.ours.totalUsd + 1
        ? ` · save ${usd(r.pub.totalUsd - r.ours.totalUsd)} with us`
        : r.ours.totalUsd > r.pub.totalUsd + 1
          ? ` · ${usd(r.ours.totalUsd - r.pub.totalUsd)} cheaper there`
          : " · same price"
      : "";
  return `${head} · ${ours} · ${pub}${verdict}`;
};

export const FLIGHT_TOOLS: ToolDef[] = [
  {
    spec: {
      name: "flight_compare",
      description:
        "Compare flights through us (our wholesale fares) with Google Flights for the same route, date and cabin, matched flight by flight: our total next to the public total and who sells it. Writes a shared page. Ask for origin, destination, date, return date if any, passengers and cabin first if any is missing. Read-only; it books nothing.",
      input_schema: obj(
        {
          origin: str("IATA airport code, e.g. LAX."),
          destination: str("IATA airport code, e.g. JFK."),
          date: str("Departure date YYYY-MM-DD."),
          returnDate: str("Return date YYYY-MM-DD for a round trip; omit for one way."),
          adults: num("Adults; default 1."),
          cabin: str("economy, premium_economy, business or first; default economy."),
          maxStops: num("Optional: 0 for nonstop only, 1 for at most one stop."),
          limit: num("How many itineraries; default 8, at most 15."),
        },
        ["origin", "destination", "date"],
      ),
    },
    family: "search",
    labels: { running: "Comparing flight prices…", done: "Compared flight prices", failed: "Couldn't compare flights" },
    sideEffect: false,
    async run(input, ctx) {
      const origin = s(input.origin).trim().toUpperCase();
      const destination = s(input.destination).trim().toUpperCase();
      const date = s(input.date);
      const returnDate = s(input.returnDate) || undefined;
      if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) return { ok: false, content: "Origin and destination must be three-letter airport codes." };
      if (!ymd.test(date) || (returnDate && (!ymd.test(returnDate) || returnDate < date))) return { ok: false, content: "Dates must be YYYY-MM-DD, return after departure." };
      const cabinIn =
        s(input.cabin)
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, "_") || "economy";
      const cabin = CABINS.find((c) => c === cabinIn) ?? (cabinIn.startsWith("prem") ? "premium_economy" : undefined);
      if (!cabin) return { ok: false, content: `Cabin must be one of ${CABINS.join(", ")}.` };
      const q = { origin, destination, date, returnDate, adults: Math.max(1, Math.floor(n(input.adults) ?? 1)), cabin, maxStops: n(input.maxStops) };
      const limit = Math.min(15, Math.max(1, Math.floor(n(input.limit) ?? 8)));
      try {
        const [ours, pub] = await Promise.all([
          ctx.hands.flights.search(q).catch((e: Error) => ({ offers: [] as FlightOffer[], evidence: "", error: e.message })),
          (() => {
            const paused = publicLookupsPaused(ctx);
            return paused
              ? Promise.resolve({ offers: [] as PublicFlightOffer[], source: "none", evidence: "", error: paused })
              : ctx.hands.publicFlights.search(q).catch((e: Error) => ({ offers: [] as PublicFlightOffer[], source: "none", evidence: "", error: e.message }));
          })(),
        ]);
        if (!ours.offers.length && !pub.offers.length)
          return {
            ok: true,
            content: "No flights found for that route and date.",
            evidence: [ours.evidence, pub.evidence].filter(Boolean).join("+"),
            stall: `no flights ${origin}-${destination} ${date}`,
          };
        // One row per itinerary (same flight numbers), from either source; ours first when both have it.
        const byKey = new Map<string, Row>();
        for (const o of ours.offers) if (!byKey.has(key(o.flights))) byKey.set(key(o.flights), { ours: o });
        for (const p of pub.offers) {
          const k = key(p.flights);
          const r = byKey.get(k);
          if (r) r.pub ??= p;
          else byKey.set(k, { pub: p });
        }
        const price = (r: Row) => Math.min(r.ours?.totalUsd ?? 1e9, r.pub?.totalUsd ?? 1e9);
        const all = [...byKey.values()].sort((a, b) => price(a) - price(b));
        // The cap must not hide what only the public market has: matched rows first, then a few from each side.
        const matched = all.filter((r) => r.ours && r.pub);
        const oursOnly = all.filter((r) => r.ours && !r.pub);
        const pubOnly = all.filter((r) => !r.ours && r.pub);
        const rest = Math.max(0, limit - matched.length);
        const rows = [...matched.slice(0, limit), ...oursOnly.slice(0, Math.ceil(rest / 2)), ...pubOnly.slice(0, Math.max(Math.floor(rest / 2), rest ? 1 : 0))].sort(
          (a, b) => price(a) - price(b),
        );
        const page = saveArtifact(ctx, {
          kind: "flights",
          title: `Flights: ${origin} to ${destination}, ${date}${returnDate ? ` to ${returnDate}` : ""}`,
          data: {
            origin,
            destination,
            date,
            returnDate,
            adults: q.adults,
            cabin,
            publicSource: pub.source,
            rows: rows.map((r) => {
              const f = r.ours ?? r.pub!;
              return {
                airline: f.airline,
                flights: f.flights,
                departAt: f.departAt,
                arriveAt: f.arriveAt,
                durationMin: f.durationMin,
                returnDurationMin: f.returnDurationMin,
                stops: f.stops,
                ours: r.ours
                  ? { totalUsd: r.ours.totalUsd, cabin: r.ours.cabin, refundable: r.ours.refundable, changeable: r.ours.changeable, checkedBag: r.ours.checkedBag }
                  : undefined,
                pub: r.pub ? { totalUsd: r.pub.totalUsd, seller: r.pub.seller, url: r.pub.url } : undefined,
              };
            }),
          },
        });
        const both = rows.filter((r) => r.ours && r.pub).length;
        return {
          ok: true,
          content: {
            page: page.url,
            publicSource: pub.source,
            matched: both,
            oursOnly: rows.filter((r) => r.ours && !r.pub).length,
            publicOnly: rows.filter((r) => !r.ours && r.pub).length,
            rows: rows.map(line),
            ...("error" in ours ? { oursError: ours.error } : {}),
            ...("error" in pub ? { publicError: pub.error } : {}),
            booking: "Booking through us is not wired yet; the public link books on the seller's site.",
          },
          evidence: [ours.evidence, pub.evidence].filter(Boolean).join("+"),
          label: `Compared ${rows.length} flights ${origin}-${destination}, ${both} priced on both sides`,
        };
      } catch (e) {
        return { ok: false, content: `The flight sources did not answer: ${String((e as Error).message).slice(0, 200)}` };
      }
    },
  },
];
