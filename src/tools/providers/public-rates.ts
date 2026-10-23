import type { SpendLog } from "../../runtime/spend.ts";
import type { BrowserProvider } from "../browser.ts";
import type { FlightQuery, PublicFlightOffer, PublicFlightsProvider, PublicOffer, PublicRatesProvider, PublicRatesQuery } from "../hands.ts";

/**
 * What the run just made cost. The run-sync endpoint answers with dataset items only (no run id in body or
 * headers), so this asks for the actor's last successful run and records its usageTotalUsd. Two runs of the
 * same actor finishing at once could swap figures; the run id in the units says which was charged.
 */
async function recordApifyRun(spend: SpendLog | undefined, token: string, actor: string, note: string) {
  if (!spend) return;
  try {
    const res = await fetch(`https://api.apify.com/v2/acts/${actor}/runs/last?status=SUCCEEDED`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return;
    const { data } = (await res.json()) as { data?: { id?: string; usageTotalUsd?: number; usage?: { ACTOR_COMPUTE_UNITS?: number } } };
    const cu = data?.usage?.ACTOR_COMPUTE_UNITS;
    const usd = data?.usageTotalUsd;
    spend.record({
      provider: "apify",
      usd: usd ?? 0,
      units: `apify run ${data?.id ?? "?"}${typeof cu === "number" ? ` ${cu.toFixed(3)} CU` : ""}`,
      note: usd === undefined ? `${note}; no usageTotalUsd in run` : note,
    });
  } catch {
    /* a missing figure is not a failed search */
  }
}

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
    private spend?: SpendLog,
  ) {}
  async search(q: PublicRatesQuery) {
    // One city query, filtered to the star classes we are about to show, thirty deep. A name query returns nothing
    // (Google reads it as a place) and the unfiltered list is the cheapest twenty, which misses the dearer rooms.
    const classes = [...new Set((q.classes ?? []).concat(q.stars ? [q.stars] : []).filter((c) => c >= 1 && c <= 5))].sort();
    const input = {
      queries: [`${classes.length === 1 ? `${classes[0]}-star ` : ""}hotels in ${q.city}`],
      checkIn: q.checkIn,
      checkOut: q.checkOut,
      adults: q.adults,
      currency: "USD",
      country: "us",
      language: "en",
      maxHotels: 25,
      ...(classes.length ? { hotelClass: classes.map(String) } : {}),
      includeOffers: true,
      offerLevel: "sources",
      // Offer rows are the cost ($0.002 each against $0.004 a hotel). Google sorts the ladder by price with the discounters
      // first, and four rows cut off the major sellers on two of nine Courchevel hotels; six reached them on every run.
      maxOffersPerHotel: 6,
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
    await recordApifyRun(this.spend, this.token, this.actor, `hotels ${q.city} ${q.checkIn}`);
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
 * Google's ladder lists most sellers before taxes. Measured on Courchevel, 22 Oct 2026: Expedia's ladder figure plus
 * Google's own tax-and-fee estimate for that hotel landed within $11 of Expedia's checkout; Booking.com's figure was
 * already the all-in total; a discount reseller's checkout ran 18% over its figure, more than taxes. So: Booking.com
 * is taken as listed, the big sellers get Google's estimate added, and discount resellers are shown but not counted.
 */
const INCLUSIVE_SELLERS = /booking\.com/i;
const TRUSTED_SELLERS = /expedia|hotels\.com|orbitz|travelocity|agoda|priceline/i;

/** Per hotel: the cheapest trusted seller as the public price, all-in, plus any discount reseller listing a lower before-tax figure. */
export function parseKestrel(rows: KestrelRow[]): PublicOffer[] {
  const hotels = new Map<string, KestrelRow>();
  for (const r of rows) if (r.type === "hotel" && r.hotel_id) hotels.set(r.hotel_id, r);
  const byHotel = new Map<string, { trusted: KestrelRow[]; other: KestrelRow[] }>();
  for (const o of rows) {
    if (o.type !== "offer" || !o.hotel_id || typeof o.total !== "number" || o.total <= 0) continue;
    const g = byHotel.get(o.hotel_id) ?? { trusted: [], other: [] };
    const src = o.source ?? "";
    (o.official || INCLUSIVE_SELLERS.test(src) || TRUSTED_SELLERS.test(src) ? g.trusted : g.other).push(o);
    byHotel.set(o.hotel_id, g);
  }
  const sellerOf = (o: KestrelRow) => (o.official ? "Official site" : (o.source ?? "Google Hotels"));
  const urlOf = (o: KestrelRow, h?: KestrelRow) => o.partner_url || o.link || h?.website || "https://www.google.com/travel/hotels";
  const offers: PublicOffer[] = [];
  for (const [id, g] of byHotel) {
    const h = hotels.get(id);
    const name = h?.name ?? g.trusted[0]?.name ?? g.other[0]?.name ?? "";
    if (!name) continue;
    // Google's tax estimate for the lead rate, as a rate, applied to every seller that lists before tax.
    const rate = h?.total_base && h.taxes ? h.taxes / h.total_base : 0;
    const fees = h?.fees ?? 0;
    const allIn = (o: KestrelRow) => (INCLUSIVE_SELLERS.test(o.source ?? "") ? o.total! : o.total! * (1 + rate) + fees);
    const best = g.trusted.slice().sort((a, b) => allIn(a) - allIn(b))[0];
    const low = g.other.slice().sort((a, b) => a.total! - b.total!)[0];
    if (best) {
      const estimated = !INCLUSIVE_SELLERS.test(best.source ?? "") && rate > 0;
      offers.push({
        name,
        totalUsd: Math.round(allIn(best)),
        seller: sellerOf(best),
        refundable: !!best.free_cancel,
        url: urlOf(best, h),
        allIn: true,
        ...(estimated ? { taxesEstimated: true } : {}),
        ...(low && low.total! < best.total! ? { listedBelow: { seller: sellerOf(low), totalUsd: Math.round(low.total!), url: urlOf(low, h) } } : {}),
      });
    } else if (low) {
      offers.push({ name, totalUsd: Math.round(low.total!), seller: sellerOf(low), refundable: !!low.free_cancel, url: urlOf(low, h), allIn: false });
    }
  }
  return offers;
}

/** One row of kestrel/booking-prices-scraper: a priced property, or a status row per name looked up. */
export interface BookingRow {
  type?: "hotel" | "status";
  name?: string;
  url?: string;
  room_name?: string;
  price_total?: number | null;
  /** Taxes and fees Booking lists as paid on top of price_total, in the run's currency. */
  taxes_fees_excluded?: number | null;
  free_cancellation?: boolean;
  sold_out?: boolean;
  error?: string | null;
  hotel_name?: string | null;
}

/** Booking's total for its cheapest room plus whatever Booking says is paid on top: the checkout figure (within $3 when measured). */
export function parseBookingRows(rows: BookingRow[]): PublicOffer[] {
  const out: PublicOffer[] = [];
  for (const r of rows) {
    if (r.type !== "hotel" || !r.name || typeof r.price_total !== "number" || r.price_total <= 0 || r.sold_out) continue;
    out.push({
      name: r.name,
      totalUsd: Math.round(r.price_total + (r.taxes_fees_excluded ?? 0)),
      seller: "Booking.com",
      refundable: !!r.free_cancellation,
      url: r.url || "https://www.booking.com",
      allIn: true,
      ...(r.room_name ? { room: r.room_name } : {}),
    });
  }
  return out;
}

/**
 * Booking.com by hotel name through Apify's kestrel/booking-prices-scraper: $0.004 a priced hotel, so a ten-hotel
 * comparison is about $0.04 (Google's ladder was $0.20). The only public source measured against a seller's own
 * checkout. APIFY_TOKEN. A hotel Booking's autocomplete does not know comes back as a status row with an error.
 */
export class ApifyBooking implements PublicRatesProvider {
  constructor(
    private token: string,
    private actor = "kestrel~booking-prices-scraper",
    private spend?: SpendLog,
  ) {}
  async search(q: PublicRatesQuery) {
    const names = (q.names ?? []).filter(Boolean).slice(0, 15);
    if (!names.length) return { offers: [], source: "Booking.com", evidence: `apify:${this.actor}:no-names` };
    const nights = Math.max(1, Math.round((Date.parse(q.checkOut) - Date.parse(q.checkIn)) / 86_400_000));
    const city = q.city.toLowerCase();
    const input = {
      hotelNames: names.map((n) => (n.toLowerCase().includes(city) ? n : `${n} ${q.city}`)),
      checkIn: q.checkIn,
      nights,
      adults: q.adults,
      rooms: 1,
      currency: "USD",
    };
    const res = await fetch(`https://api.apify.com/v2/acts/${this.actor}/run-sync-get-dataset-items?timeout=240&format=json`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(250_000),
    });
    if (!res.ok) throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const rows = (await res.json()) as BookingRow[];
    await recordApifyRun(this.spend, this.token, this.actor, `booking ${q.city} ${q.checkIn} ${names.length} names`);
    const offers = parseBookingRows(rows);
    return { offers, source: "Booking.com", evidence: `apify:${this.actor}:${q.checkIn}:${new Date().toISOString()}:${offers.length}/${names.length}` };
  }
}

/** The public-price hand for this deployment: Booking.com by name when Apify is keyed (PUBLIC_RATES=google for Google's ladder), else the browser read. */
export function publicRatesFrom(env: NodeJS.ProcessEnv, browser: import("../browser.ts").BrowserProvider, spend?: SpendLog): { hand: PublicRatesProvider; label: string } {
  if (!env.APIFY_TOKEN) return { hand: new BookingPublicRates(browser), label: "Booking.com via the browser, which Booking blocks for headless Chrome (set APIFY_TOKEN)" };
  if (env.PUBLIC_RATES === "google") return { hand: new ApifyHotels(env.APIFY_TOKEN, undefined, spend), label: "Google Hotels (Apify)" };
  return { hand: new ApifyBooking(env.APIFY_TOKEN, undefined, spend), label: "Booking.com by hotel name (Apify)" };
}

/** Google Flights through Apify's kaix/google-flights-scraper: every airline and the big OTAs, about $0.003 a search. APIFY_TOKEN. */
export class ApifyFlights implements PublicFlightsProvider {
  constructor(
    private token: string,
    private actor = "kaix~google-flights-scraper",
    private spend?: SpendLog,
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
    await recordApifyRun(this.spend, this.token, this.actor, `flights ${q.origin}-${q.destination} ${q.date}`);
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
