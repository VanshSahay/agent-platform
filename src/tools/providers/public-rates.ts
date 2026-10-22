import type { BrowserProvider } from "../browser.ts";
import type { FlightQuery, PublicFlightOffer, PublicFlightsProvider, PublicOffer, PublicRatesProvider, PublicRatesQuery } from "../hands.ts";

const ymdOk = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/**
 * Booking.com's results page for a city and dates, read through the browser hand: one page, every hotel's total
 * for the stay. Booking serves headless Chrome an empty list with default dates, so this only works through a
 * browser the site does not detect (a visible Chrome, Browserbase); Apify's Google Hotels actor is the dependable source.
 */
export class BookingPublicRates implements PublicRatesProvider {
  constructor(private browser: BrowserProvider) {}
  async search(q: PublicRatesQuery) {
    if (!ymdOk(q.checkIn) || !ymdOk(q.checkOut)) throw new Error("dates must be YYYY-MM-DD");
    const url = new URL("https://www.booking.com/searchresults.html");
    url.searchParams.set("ss", q.city);
    url.searchParams.set("checkin", q.checkIn);
    url.searchParams.set("checkout", q.checkOut);
    url.searchParams.set("group_adults", String(q.adults));
    url.searchParams.set("no_rooms", "1");
    url.searchParams.set("group_children", "0");
    url.searchParams.set("selected_currency", "USD");
    url.searchParams.set("order", "price");
    if (q.stars) url.searchParams.set("nflt", `class=${q.stars}`);
    const page = await this.browser.readPage({ url: url.toString() });
    return { offers: parseBooking(page.text, url.toString()), source: "Booking.com", evidence: page.evidence };
  }
}

/** Each result on Booking's page reads: name, "Opens in new window", details, "Price $6,678", "5 nights, 2 adults". */
export function parseBooking(text: string, url = "https://www.booking.com"): PublicOffer[] {
  const lines = text.split("\n").map((l) => l.trim());
  const offers: PublicOffer[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] !== "Opens in new window") continue;
    const name = lines[i - 1] ?? "";
    // The block ends at the next listing; "Looking for more options?" starts the out-of-area tail.
    let end = lines.indexOf("Opens in new window", i + 1);
    if (end < 0) end = lines.length;
    const tail = lines.indexOf("Looking for more options?", i);
    if (tail >= 0 && tail < end) end = tail;
    const block = lines.slice(i, end);
    const price = block.map((l) => /^Price \$([\d,]+)/.exec(l)).find(Boolean);
    if (!name || !price) continue;
    offers.push({
      name,
      totalUsd: Number(price[1]!.replace(/,/g, "")),
      seller: "Booking.com",
      refundable: block.includes("Free cancellation"),
      url,
      allIn: true,
    });
    if (tail >= 0 && tail < lines.indexOf("Opens in new window", end)) break;
  }
  return offers;
}

/**
 * Google Hotels through Apify's kestrel/google-hotels-prices: one hotel row with Google's taxes-and-fees
 * estimate for the lead rate, plus one offer row per seller (Booking.com, Agoda, Expedia, Super.com, the
 * hotel's own site) at the pre-tax total. Each seller's all-in total is its pre-tax total scaled by the
 * hotel's tax rate plus fees, which is what Google shows as the price with taxes. A seller's checkout can
 * still add its own fees on top (Super.com charged $7,008 where Google estimated $6,498). APIFY_TOKEN;
 * about $0.004 a hotel and $0.002 an offer row.
 */
export class ApifyHotels implements PublicRatesProvider {
  constructor(
    private token: string,
    private actor = "kestrel~google-hotels-prices",
  ) {}
  async search(q: PublicRatesQuery) {
    const input = {
      queries: [`${q.stars ? `${q.stars}-star ` : ""}hotels in ${q.city}`],
      checkIn: q.checkIn,
      checkOut: q.checkOut,
      adults: q.adults,
      currency: "USD",
      country: "us",
      language: "en",
      maxHotels: 20,
      ...(q.stars ? { hotelClass: [String(q.stars)] } : {}),
      includeOffers: true,
      offerLevel: "sources",
      maxOffersPerHotel: 8,
      sortBy: "lowest_price",
    };
    const res = await fetch(`https://api.apify.com/v2/acts/${this.actor}/run-sync-get-dataset-items?timeout=240&format=json`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(250_000),
    });
    if (!res.ok) throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const rows = (await res.json()) as KestrelRow[];
    const status = rows.find((r) => r.type === "status");
    if (status?.error) throw new Error(`Google Hotels: ${status.error}`);
    const offers = parseKestrel(rows);
    return { offers, source: "Google Hotels", evidence: `apify:${this.actor}:${q.checkIn}:${status?.fetched_at ?? new Date().toISOString()}:${offers.length}` };
  }
}
export interface KestrelRow {
  type?: "hotel" | "offer" | "status";
  hotel_id?: string;
  name?: string;
  source?: string;
  official?: boolean;
  total?: number;
  total_base?: number;
  taxes?: number;
  fees?: number;
  total_with_taxes?: number;
  free_cancel?: boolean | null;
  link?: string;
  partner_url?: string;
  website?: string;
  error?: string | null;
  fetched_at?: string;
}
/**
 * Sellers whose figure on Google's ladder is the stay with taxes and fees in. Measured on Courchevel: Booking.com's
 * ladder figure matched its own site within $3, while a discount reseller's was a before-tax figure its checkout
 * raised by 18%. Comparing against these keeps the saving honest without scraping any seller.
 */
const ALL_IN_SELLERS = /booking\.com|expedia|hotels\.com/i;
export const quotesAllIn = (seller: string, official = false) => official || ALL_IN_SELLERS.test(seller);

/** Per hotel: the cheapest all-in seller as the public price, plus any discount reseller listing a lower before-tax figure. */
export function parseKestrel(rows: KestrelRow[]): PublicOffer[] {
  const hotels = new Map<string, KestrelRow>();
  for (const r of rows) if (r.type === "hotel" && r.hotel_id) hotels.set(r.hotel_id, r);
  const byHotel = new Map<string, { allIn: KestrelRow[]; other: KestrelRow[] }>();
  for (const o of rows) {
    if (o.type !== "offer" || !o.hotel_id || typeof o.total !== "number" || o.total <= 0) continue;
    const g = byHotel.get(o.hotel_id) ?? { allIn: [], other: [] };
    (quotesAllIn(o.source ?? "", !!o.official) ? g.allIn : g.other).push(o);
    byHotel.set(o.hotel_id, g);
  }
  const cheapest = (xs: KestrelRow[]) => xs.slice().sort((a, b) => a.total! - b.total!)[0];
  const sellerOf = (o: KestrelRow) => (o.official ? "Official site" : (o.source ?? "Google Hotels"));
  const urlOf = (o: KestrelRow, h?: KestrelRow) => o.partner_url || o.link || h?.website || "https://www.google.com/travel/hotels";
  const offers: PublicOffer[] = [];
  for (const [id, g] of byHotel) {
    const h = hotels.get(id);
    const name = h?.name ?? g.allIn[0]?.name ?? g.other[0]?.name ?? "";
    if (!name) continue;
    const best = cheapest(g.allIn);
    const low = cheapest(g.other);
    if (best) {
      offers.push({
        name,
        totalUsd: Math.round(best.total!),
        seller: sellerOf(best),
        refundable: !!best.free_cancel,
        url: urlOf(best, h),
        allIn: true,
        ...(low && low.total! < best.total! ? { listedBelow: { seller: sellerOf(low), totalUsd: Math.round(low.total!), url: urlOf(low, h) } } : {}),
      });
    } else if (low) {
      offers.push({ name, totalUsd: Math.round(low.total!), seller: sellerOf(low), refundable: !!low.free_cancel, url: urlOf(low, h), allIn: false });
    }
  }
  return offers;
}

/** Google Flights through Apify's kaix/google-flights-scraper: every airline and the big OTAs, about $0.003 a search. APIFY_TOKEN. */
export class ApifyFlights implements PublicFlightsProvider {
  constructor(
    private token: string,
    private actor = "kaix~google-flights-scraper",
  ) {}
  async search(q: FlightQuery) {
    const input = {
      searches: [{ origin: q.origin, destination: q.destination, departureDate: q.date, ...(q.returnDate ? { returnDate: q.returnDate } : {}) }],
      cabinClass: q.cabin.replace("_", "-"),
      adults: q.adults,
      currency: "USD",
      country: "US",
      sortBy: "price",
      maxResults: 20,
      ...(q.maxStops !== undefined ? { maxStops: q.maxStops === 0 ? "nonstop" : String(q.maxStops) } : {}),
      includeBookingDetails: true,
      maxBookingDetails: 10,
    };
    const res = await fetch(`https://api.apify.com/v2/acts/${this.actor}/run-sync-get-dataset-items?timeout=240&format=json`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(250_000),
    });
    if (!res.ok) throw new Error(`Apify flights ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const rows = (await res.json()) as KaixRow[];
    const offers: PublicFlightOffer[] = [];
    for (const r of rows) {
      const segs = [...(r.outbound?.segments ?? []), ...(r.return?.segments ?? [])];
      if (!segs.length || typeof r.price !== "number") continue;
      // Google's list price is the fare for the cabin asked. Booking options also carry cheaper fare brands on
      // the same flight (economy next to Mint), so an option only names the seller when it matches the list price.
      const seller = (r.bookingDetails?.bookingOptions ?? []).find((o) => typeof o.price === "number" && Math.abs(o.price - r.price!) <= 1)?.provider;
      const out = r.outbound?.segments ?? [];
      offers.push({
        flights: segs.map((s) => (s.flightNumber ?? "").replace(/\s+/g, "")),
        airline: r.airlines?.[0] ?? segs[0]!.airline ?? "",
        departAt: out[0]?.departureTime ?? segs[0]!.departureTime ?? "",
        arriveAt: out[out.length - 1]?.arrivalTime ?? segs[segs.length - 1]!.arrivalTime ?? "",
        durationMin: r.outbound?.duration ?? r.totalDuration ?? 0,
        returnDurationMin: r.return?.duration,
        stops: Math.max(r.outbound?.stops ?? 0, r.return?.stops ?? 0),
        totalUsd: r.price,
        seller: seller ?? "Google Flights",
        url: `https://www.google.com/travel/flights?q=Flights%20from%20${q.origin}%20to%20${q.destination}%20on%20${q.date}`,
      });
    }
    return { offers, source: "Google Flights", evidence: `apify:${this.actor}:${q.origin}-${q.destination}:${q.date}:${offers.length}` };
  }
}
interface KaixRow {
  price?: number;
  totalDuration?: number;
  stops?: number;
  airlines?: string[];
  outbound?: { segments?: KaixSeg[]; duration?: number; stops?: number };
  return?: { segments?: KaixSeg[]; duration?: number; stops?: number };
  bookingDetails?: { bookingOptions?: { provider?: string; price?: number }[] };
}
interface KaixSeg {
  airline?: string;
  flightNumber?: string;
  departureTime?: string;
  arrivalTime?: string;
}

/**
 * A seller's own search for this hotel with the dates filled in. Google's hotel pages ignore date parameters,
 * so a Google link would open without the stay; the sellers below honour them in the URL.
 */
export function sellerSearchUrl(seller: string, hotel: string, q: PublicRatesQuery): string | undefined {
  const s = seller.toLowerCase();
  const name = encodeURIComponent(`${hotel}, ${q.city}`);
  if (s.includes("booking"))
    return `https://www.booking.com/searchresults.html?ss=${name}&checkin=${q.checkIn}&checkout=${q.checkOut}&group_adults=${q.adults}&no_rooms=1&group_children=0&selected_currency=USD`;
  if (s.includes("expedia")) return `https://www.expedia.com/Hotel-Search?destination=${name}&startDate=${q.checkIn}&endDate=${q.checkOut}&adults=${q.adults}&rooms=1`;
  if (s.includes("hotels.com")) return `https://www.hotels.com/Hotel-Search?destination=${name}&startDate=${q.checkIn}&endDate=${q.checkOut}&adults=${q.adults}&rooms=1`;
  if (s.includes("agoda")) return `https://www.agoda.com/search?textToSearch=${name}&checkIn=${q.checkIn}&checkOut=${q.checkOut}&adults=${q.adults}&rooms=1&currency=USD`;
  if (s.includes("priceline")) return `https://www.priceline.com/relax/in/${q.checkIn}/${q.checkOut}/rooms/1/adults/${q.adults}?search-text=${name}`;
  return undefined;
}
