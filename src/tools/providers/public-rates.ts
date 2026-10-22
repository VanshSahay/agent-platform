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
    });
    if (tail >= 0 && tail < lines.indexOf("Opens in new window", end)) break;
  }
  return offers;
}

/**
 * Google Hotels through Apify's factden/google-hotels-scraper: per hotel, every seller's total for the stay
 * (Booking.com, Agoda, Expedia, Hotels.com, the hotel's own site) with a booking link. APIFY_TOKEN; pay per
 * hotel priced (about half a cent each). The actor writes hotel rows to its run's dataset and to a named
 * `hotels` dataset; the run's dataset is read first.
 */
export class ApifyHotels implements PublicRatesProvider {
  constructor(
    private token: string,
    private actor = "factden~google-hotels-scraper",
  ) {}
  async search(q: PublicRatesQuery) {
    const input = {
      searchQueries: [`${q.stars ? `${q.stars} star ` : ""}hotels in ${q.city}`],
      checkInDate: q.checkIn,
      checkOutDate: q.checkOut,
      adults: q.adults,
      children: 0,
      rooms: 1,
      currency: "USD",
      countryCode: "us",
      languageCode: "en",
      includePrices: true,
      includeReviews: false,
      minStars: q.stars ?? 0,
      maxResults: 25,
    };
    const res = await fetch(`https://api.apify.com/v2/acts/${this.actor}/run-sync-get-dataset-items?timeout=240&format=json`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(250_000),
    });
    if (!res.ok) throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0, 200)}`);
    let rows = (await res.json()) as ApifyHotel[];
    if (!rows.some((r) => r?.name)) rows = await this.namedDataset(q);
    const scrapedAt = rows.find((r) => r?.scrapedAt)?.scrapedAt ?? new Date().toISOString();
    const offers: PublicOffer[] = [];
    for (const h of rows) {
      if (!h?.name) continue;
      const best = (h.offers ?? []).filter((o) => typeof o.total === "number" && o.total > 0).sort((a, b) => a.total! - b.total!)[0];
      const total = best?.total ?? h.leadPriceTotal;
      if (typeof total !== "number" || total <= 0) continue;
      offers.push({
        name: h.name,
        totalUsd: total,
        seller: best?.source ?? "Google Hotels",
        refundable: false, // the ladder carries no cancellation terms
        url: best?.bookingLink || h.hotelUrl || "https://www.google.com/travel/hotels",
      });
    }
    return { offers, source: "Google Hotels", evidence: `apify:${this.actor}:${q.checkIn}:${scrapedAt}:${offers.length}` };
  }
  /** The actor's named `hotels` dataset, newest first, kept to rows for these dates. */
  private async namedDataset(q: PublicRatesQuery): Promise<ApifyHotel[]> {
    const me = await fetch("https://api.apify.com/v2/users/me", { headers: { authorization: `Bearer ${this.token}` } });
    if (!me.ok) return [];
    const { data } = (await me.json()) as { data: { username: string } };
    const res = await fetch(`https://api.apify.com/v2/datasets/${data.username}~hotels/items?desc=true&limit=200&format=json`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as ApifyHotel[];
    return rows.filter((r) => r.checkInDate === q.checkIn && r.checkOutDate === q.checkOut);
  }
}
interface ApifyHotel {
  name?: string;
  starClass?: number;
  rating?: number;
  checkInDate?: string;
  checkOutDate?: string;
  leadPriceTotal?: number;
  hotelUrl?: string;
  scrapedAt?: string;
  offers?: { source?: string; total?: number; bookingLink?: string; official?: boolean }[];
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
      offers.push({
        flights: segs.map((s) => (s.flightNumber ?? "").replace(/\s+/g, "")),
        airline: r.airlines?.[0] ?? segs[0]!.airline ?? "",
        departAt: segs[0]!.departureTime ?? "",
        arriveAt: segs[segs.length - 1]!.arrivalTime ?? "",
        durationMin: r.totalDuration ?? 0,
        stops: r.stops ?? Math.max(0, segs.length - 1),
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
  outbound?: { segments?: KaixSeg[] };
  return?: { segments?: KaixSeg[] };
  bookingDetails?: { bookingOptions?: { provider?: string; price?: number }[] };
}
interface KaixSeg {
  airline?: string;
  flightNumber?: string;
  departureTime?: string;
  arrivalTime?: string;
}
