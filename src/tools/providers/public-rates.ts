import type { BrowserProvider } from "../browser.ts";
import type { PublicOffer, PublicRatesProvider, PublicRatesQuery } from "../hands.ts";

const ymdOk = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/**
 * Booking.com's results page for a city and dates, read through the browser hand: one page, every hotel's total
 * for the stay. Booking serves headless Chrome an empty list with default dates, so this only works through a
 * browser the site does not detect (a visible Chrome, Browserbase); SerpApi is the dependable source.
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

/** Google Hotels through SerpApi: the cheapest seller per hotel across Booking, Agoda, Expedia and the rest. SERPAPI_KEY. */
export class SerpApiHotels implements PublicRatesProvider {
  constructor(private apiKey: string) {}
  async search(q: PublicRatesQuery) {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_hotels");
    url.searchParams.set("q", `${q.city} hotels`);
    url.searchParams.set("check_in_date", q.checkIn);
    url.searchParams.set("check_out_date", q.checkOut);
    url.searchParams.set("adults", String(q.adults));
    url.searchParams.set("currency", "USD");
    url.searchParams.set("gl", "us");
    url.searchParams.set("hl", "en");
    if (q.stars) url.searchParams.set("hotel_class", String(q.stars));
    url.searchParams.set("api_key", this.apiKey);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SerpApi ${res.status}`);
    const body = (await res.json()) as {
      properties?: {
        name: string;
        link?: string;
        total_rate?: { extracted_lowest?: number };
        prices?: { source?: string; total_rate?: { extracted_lowest?: number }; rate_per_night?: { extracted_lowest?: number } }[];
        free_cancellation?: boolean;
      }[];
      search_metadata?: { id?: string };
    };
    const nights = Math.max(1, Math.round((Date.parse(q.checkOut) - Date.parse(q.checkIn)) / 86_400_000));
    const offers: PublicOffer[] = [];
    for (const p of body.properties ?? []) {
      const sellers = (p.prices ?? [])
        .map((x) => ({
          seller: x.source ?? "Google",
          total: x.total_rate?.extracted_lowest ?? (x.rate_per_night?.extracted_lowest ? x.rate_per_night.extracted_lowest * nights : undefined),
        }))
        .filter((x): x is { seller: string; total: number } => typeof x.total === "number")
        .sort((a, b) => a.total - b.total);
      const best = sellers[0] ?? (p.total_rate?.extracted_lowest ? { seller: "Google", total: p.total_rate.extracted_lowest } : undefined);
      if (!best) continue;
      offers.push({ name: p.name, totalUsd: best.total, seller: best.seller, refundable: !!p.free_cancellation, url: p.link ?? "https://www.google.com/travel/hotels" });
    }
    return { offers, source: "Google Hotels", evidence: `serpapi:${body.search_metadata?.id ?? "?"}` };
  }
}
