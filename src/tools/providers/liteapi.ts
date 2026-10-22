import type { SpendLog } from "../../runtime/spend.ts";
import type { FlightOffer, FlightProvider, FlightQuery, HotelOffer, HotelProvider } from "../hands.ts";

/**
 * LiteAPI (Nuitée Connect) hotel rates. One POST returns the rooms and the hotel names; retailRate.total
 * is the net price the account pays with taxes in, suggestedSellingPrice is what the public is seen paying.
 * LITEAPI_API_KEY; a sand_ key answers with live content but cannot book.
 */
export class LiteApi implements HotelProvider {
  constructor(
    private apiKey: string,
    private spend?: SpendLog,
  ) {}
  async rates(input: { city: string; countryCode: string; checkIn: string; checkOut: string; adults: number; limit?: number }) {
    // Free on the account in use: counted, not priced.
    this.spend?.record({ provider: "liteapi", usd: 0, units: "1 rates search", note: `${input.city} ${input.checkIn}` });
    const res = await fetch("https://api.liteapi.travel/v3.0/hotels/rates", {
      method: "POST",
      headers: { "X-API-Key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        cityName: input.city,
        countryCode: input.countryCode,
        checkin: input.checkIn,
        checkout: input.checkOut,
        occupancies: [{ adults: input.adults }],
        currency: "USD",
        guestNationality: "US",
        limit: input.limit ?? 10,
      }),
    });
    if (!res.ok) throw new Error(`LiteAPI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      data?: { hotelId: string; roomTypes?: { rates?: Rate[] }[] }[];
      hotels?: { id: string; name: string; stars?: number; rating?: number; address?: string; main_photo?: string; thumbnail?: string }[];
      sandbox?: boolean;
    };
    const names = new Map((body.hotels ?? []).map((h) => [h.id, h]));
    const offers: HotelOffer[] = [];
    for (const h of body.data ?? []) {
      // The cheapest room per hotel is the one worth comparing; the rest is noise in a chat.
      const rates = (h.roomTypes ?? []).flatMap((r) => r.rates ?? []);
      const best = rates
        .map(toOffer)
        .filter((o) => o !== undefined)
        .sort((a, b) => a.netUsd - b.netUsd)[0];
      const meta = names.get(h.hotelId);
      if (!best || !meta) continue;
      offers.push({
        id: h.hotelId,
        name: meta.name,
        stars: meta.stars,
        rating: meta.rating,
        address: meta.address,
        photo: meta.main_photo || meta.thumbnail || undefined,
        ...best,
      });
    }
    offers.sort((a, b) => a.netUsd - b.netUsd);
    return { offers, evidence: `liteapi:${body.sandbox ? "sandbox:" : ""}${input.city}:${input.checkIn}:${offers.length}` };
  }
}

interface Rate {
  name?: string;
  boardName?: string;
  retailRate?: { total?: { amount: number; currency: string }[]; suggestedSellingPrice?: { amount: number }[]; taxesAndFees?: { included: boolean; amount: number }[] | null };
  cancellationPolicies?: { refundableTag?: string };
}
function toOffer(r: Rate): Omit<HotelOffer, "id" | "name"> | undefined {
  const net = r.retailRate?.total?.[0]?.amount;
  if (typeof net !== "number") return undefined;
  const pub = r.retailRate?.suggestedSellingPrice?.[0]?.amount;
  return {
    room: r.name ?? "Room",
    board: r.boardName ?? "",
    refundable: r.cancellationPolicies?.refundableTag === "RFN",
    netUsd: net,
    // A public price under the net is content noise, not a saving.
    publicUsd: typeof pub === "number" && pub > net ? pub : undefined,
    excludedFeesUsd: (r.retailRate?.taxesAndFees ?? []).filter((t) => !t.included).reduce((s, t) => s + t.amount, 0),
  };
}

/**
 * LiteAPI flights (the same key once Nuitée enables Flights on the account). The cabin goes through
 * `filters` with "at_least": US carriers sell domestic business as "First", which a plain cabinClass misses.
 * `total` already carries the account's flight margin, set in the Nuitée dashboard, so nothing is added here.
 */
export class LiteApiFlights implements FlightProvider {
  constructor(private apiKey: string) {}
  async search(q: FlightQuery) {
    const legs = [{ origin: q.origin, destination: q.destination, date: q.date, ...(q.maxStops !== undefined ? { filters: { maxStops: q.maxStops } } : {}) }];
    if (q.returnDate) legs.push({ origin: q.destination, destination: q.origin, date: q.returnDate, ...(q.maxStops !== undefined ? { filters: { maxStops: q.maxStops } } : {}) });
    const res = await fetch("https://api.liteapi.travel/v3.0/flights/rates", {
      method: "POST",
      headers: { "X-API-Key": this.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        legs,
        adults: q.adults,
        currency: "USD",
        country: "US",
        filters: { cabinClass: q.cabin.toUpperCase(), cabinClassMatch: "at_least" },
        sort: { sortBy: "price", sortOrder: "asc" },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`LiteAPI flights ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: { journeys?: Journey[] }[] };
    const offers: FlightOffer[] = [];
    for (const j of (body.data ?? []).flatMap((b) => b.journeys ?? [])) {
      const o = j.cheapestOffer ?? j.offers?.[0];
      const segs = j.segments ?? [];
      const total = o?.pricing?.display?.total;
      if (!o || !segs.length || typeof total !== "number") continue;
      const out = segs.filter((s) => s.direction !== "INBOUND");
      const back = segs.filter((s) => s.direction === "INBOUND");
      const legMin = (dir: string) => j.legDurations?.find((l) => l.direction === dir)?.duration?.minutes;
      offers.push({
        flights: segs.map((s) => `${s.carrier?.marketingCode ?? ""}${s.flight?.marketingNumber ?? ""}`),
        airline: segs[0]!.carrier?.marketingName ?? segs[0]!.carrier?.marketingCode ?? "",
        departAt: out[0]?.departureTime ?? "",
        arriveAt: out[out.length - 1]?.arrivalTime ?? "",
        durationMin: legMin("OUTBOUND") ?? (back.length ? 0 : (j.totalDuration?.minutes ?? 0)),
        returnDurationMin: back.length ? legMin("INBOUND") : undefined,
        stops: Math.max(out.length - 1, back.length ? back.length - 1 : 0, 0),
        cabin: o.segmentFares?.[0]?.cabin ?? o.fare?.family ?? q.cabin,
        totalUsd: total,
        refundable: !!o.terms?.refundable,
        changeable: !!o.terms?.changeable,
        checkedBag: !!o.baggage?.hasCheckedBag,
        offerId: o.offerId,
      });
    }
    offers.sort((a, b) => a.totalUsd - b.totalUsd);
    return { offers, evidence: `liteapi-flights:${q.origin}-${q.destination}:${q.date}:${offers.length}` };
  }
}
interface Journey {
  cheapestOffer?: Offer;
  offers?: Offer[];
  segments?: {
    carrier?: { marketingCode?: string; marketingName?: string };
    flight?: { marketingNumber?: string };
    departureTime?: string;
    arrivalTime?: string;
    direction?: string;
  }[];
  totalDuration?: { minutes?: number };
  legDurations?: { direction?: string; duration?: { minutes?: number } }[];
}
interface Offer {
  offerId?: string;
  pricing?: { display?: { total?: number } };
  fare?: { family?: string };
  terms?: { refundable?: boolean; changeable?: boolean };
  baggage?: { hasCheckedBag?: boolean };
  segmentFares?: { cabin?: string }[];
}
