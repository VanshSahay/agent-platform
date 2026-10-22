/**
 * "Hands" are the external capabilities the agent acts through. Each is an
 * interface with an in-memory fake, so the whole product runs and tests
 * without vendors. Real adapters (a search API, a telephony vendor, a
 * Reddit/Rednote client, a browser) implement the same interfaces.
 *
 * Every hand returns `evidence`: a provider identifier the run stores with
 * the tool call. The reply's status footer is built from stored evidence,
 * never from the model's own words.
 */

import { FakeBrowser, type BrowserProvider } from "./browser.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
export interface SearchProvider {
  search(query: string, opts?: { near?: string; limit?: number }): Promise<{ results: SearchResult[]; evidence: string }>;
}

export interface CallOutcome {
  callId: string;
  status: "completed" | "no_answer" | "busy" | "failed";
  durationSeconds: number;
  /** What the agent learned, as a short transcript summary. */
  summary: string;
  transcript?: { role: "agent" | "party"; text: string }[];
  evidence: string;
}
export interface PhoneProvider {
  /** Places a call and talks on the agent's behalf with the given objective; returns when the call ends. */
  call(input: { to: string; objective: string; callerName: string; language?: string }): Promise<CallOutcome>;
  sendSms(input: { to: string; text: string; from?: string }): Promise<{ messageId: string; evidence: string }>;
}

export interface CommunityPost {
  postId: string;
  url: string;
  evidence: string;
}
export interface CommunityReply {
  author: string;
  text: string;
  at: number;
}
export interface CommunityProvider {
  /** e.g. "reddit:r/sanfrancisco" or "rednote" */
  post(input: { community: string; title: string; body: string; language?: string }): Promise<CommunityPost>;
  replies(postId: string): Promise<CommunityReply[]>;
}

/** Google Workspace for one person: a REST passthrough; the credential blob is whatever the OAuth flow stored. */
export interface GoogleProvider {
  request(
    credential: string,
    req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; body?: unknown; query?: Record<string, string | undefined>; raw?: boolean },
  ): Promise<unknown>;
}
/** The agent's own mailbox (Fo's fo@wajo.ai): it sends from here, and inbound mail arrives here. */
export interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  at: number;
}
export interface EmailProvider {
  address(): string;
  send(input: { to: string[]; cc?: string[]; subject: string; text: string; replyToMessageId?: string }): Promise<{ messageId: string; evidence: string }>;
  /** Inbound messages not yet handed to the agent. */
  unprocessed(): Promise<EmailMessage[]>;
  thread(threadId: string): Promise<EmailMessage[]>;
  markProcessed(ids: string[]): Promise<void>;
}
/** Slack Web API passthrough with the workspace's bot token. */
export interface SlackProvider {
  call(token: string, method: string, params: Record<string, unknown>): Promise<unknown>;
}
export interface SpeechProvider {
  speak(input: { text: string; voiceId?: string; pronunciations?: Record<string, string> }): Promise<{ audioBase64: string; mimeType: string; evidence: string }>;
}
export interface ImageProvider {
  generate(input: { prompt: string; size?: string }): Promise<{ imageBase64: string; mimeType: string; evidence: string }>;
}
/** Money: a single-use card for one purchase (Fo mints one per checkout). The details go to the vault, never to the model. */
export interface PaymentProvider {
  issueCard(input: { amountUsd: number; merchant: string; personId: string }): Promise<{ cardId: string; last4: string; details: string; evidence: string }>;
  cancelCard(cardId: string): Promise<void>;
}

/** Hotel rates from a wholesale source (LiteAPI): what the room costs us, net, next to the public price. Read-only; booking is a person's click. */
export interface HotelOffer {
  id: string;
  name: string;
  stars?: number;
  rating?: number;
  address?: string;
  photo?: string;
  room: string;
  board: string;
  refundable: boolean;
  /** Net total for the stay in USD, taxes included; excluded fees (city tax) listed apart. */
  netUsd: number;
  /** What the public is seen paying for the same room, when the source says. */
  publicUsd?: number;
  excludedFeesUsd: number;
}
export interface HotelProvider {
  rates(input: { city: string; countryCode: string; checkIn: string; checkOut: string; adults: number; limit?: number }): Promise<{ offers: HotelOffer[]; evidence: string }>;
}

/** What the public pays for the same hotel and dates, from one public source, matched to our offers by name. */
export interface PublicOffer {
  name: string;
  totalUsd: number;
  seller: string;
  refundable: boolean;
  url: string;
  /** The figure is the stay with taxes and fees in; false means a before-tax figure from a seller nobody trusted. */
  allIn: boolean;
  /** The seller listed before tax and Google's tax-and-fee estimate for the hotel was added (within $11 of Expedia's checkout when measured). */
  taxesEstimated?: boolean;
  /** The seller's cheapest room for the dates, when it names one; ours may be a different room. */
  room?: string;
  /** A discount reseller listing a lower before-tax figure for the same room; its checkout adds taxes and fees. */
  listedBelow?: { seller: string; totalUsd: number; url: string };
}
export interface PublicRatesQuery {
  city: string;
  countryCode: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  stars?: number;
  /** Star classes of the hotels we are about to show, so Google's list covers them rather than its cheapest twenty. */
  classes?: number[];
  /** The hotels we are about to show, by name: Booking.com is asked about each one. */
  names?: string[];
}
export interface PublicRatesProvider {
  search(q: PublicRatesQuery): Promise<{ offers: PublicOffer[]; source: string; evidence: string }>;
}

/** Flights: our wholesale side (LiteAPI) and the public side (Google Flights), matched by flight numbers. */
export type Cabin = "economy" | "premium_economy" | "business" | "first";
export interface FlightQuery {
  origin: string;
  destination: string;
  date: string;
  returnDate?: string;
  adults: number;
  cabin: Cabin;
  maxStops?: number;
}
export interface FlightOffer {
  /** The flight numbers in order, e.g. ["AA3177", "AA1796"]; the match key across sources. */
  flights: string[];
  airline: string;
  departAt: string;
  arriveAt: string;
  /** Outbound leg; a round trip carries the return leg in returnDurationMin, and stops is the most on either leg. */
  durationMin: number;
  returnDurationMin?: number;
  stops: number;
  cabin: string;
  totalUsd: number;
  refundable: boolean;
  changeable: boolean;
  checkedBag: boolean;
  offerId?: string;
}
export interface FlightProvider {
  search(q: FlightQuery): Promise<{ offers: FlightOffer[]; evidence: string }>;
}
export interface PublicFlightOffer {
  flights: string[];
  airline: string;
  departAt: string;
  arriveAt: string;
  durationMin: number;
  returnDurationMin?: number;
  stops: number;
  totalUsd: number;
  seller: string;
  url: string;
}
export interface PublicFlightsProvider {
  search(q: FlightQuery): Promise<{ offers: PublicFlightOffer[]; source: string; evidence: string }>;
}

export interface Hands {
  search: SearchProvider;
  hotels: HotelProvider;
  publicRates: PublicRatesProvider;
  flights: FlightProvider;
  publicFlights: PublicFlightsProvider;
  phone: PhoneProvider;
  community: CommunityProvider;
  browser: BrowserProvider;
  google: GoogleProvider;
  email: EmailProvider;
  slack: SlackProvider;
  speech: SpeechProvider;
  images: ImageProvider;
  payments: PaymentProvider;
}

// ---------- Fakes ----------

export class FakeSearch implements SearchProvider {
  public queries: string[] = [];
  constructor(private canned: (q: string) => SearchResult[] = () => []) {}
  async search(query: string, opts: { limit?: number } = {}) {
    this.queries.push(query);
    const results = this.canned(query).slice(0, opts.limit ?? 8);
    return { results, evidence: `fake-search:${this.queries.length}` };
  }
}

export class FakePhone implements PhoneProvider {
  public calls: { to: string; objective: string }[] = [];
  public sms: { to: string; text: string }[] = [];
  constructor(private answer: (to: string, objective: string) => Partial<CallOutcome> = () => ({})) {}
  async call(input: { to: string; objective: string; callerName: string }) {
    this.calls.push({ to: input.to, objective: input.objective });
    const id = `call_${this.calls.length}`;
    const a = this.answer(input.to, input.objective);
    return {
      callId: id,
      status: a.status ?? "completed",
      durationSeconds: a.durationSeconds ?? 90,
      summary: a.summary ?? "They answered; details noted.",
      transcript: a.transcript,
      evidence: `fake-phone:${id}`,
    } satisfies CallOutcome;
  }
  async sendSms(input: { to: string; text: string }) {
    this.sms.push(input);
    const id = `sms_${this.sms.length}`;
    return { messageId: id, evidence: `fake-sms:${id}` };
  }
}

export class FakeCommunity implements CommunityProvider {
  public posts: { community: string; title: string; body: string }[] = [];
  constructor(private cannedReplies: (community: string) => CommunityReply[] = () => []) {}
  async post(input: { community: string; title: string; body: string }) {
    this.posts.push(input);
    const id = `post_${this.posts.length}`;
    return { postId: id, url: `https://example.invalid/${input.community}/${id}`, evidence: `fake-community:${id}` };
  }
  async replies(postId: string) {
    const idx = Number(postId.split("_")[1]) - 1;
    const p = this.posts[idx];
    return p ? this.cannedReplies(p.community) : [];
  }
}

export class FakeGoogle implements GoogleProvider {
  public requests: { method: string; url: string; body?: unknown; query?: Record<string, string | undefined> }[] = [];
  constructor(private answer: (req: { method: string; url: string; body?: unknown; query?: Record<string, string | undefined> }) => unknown = () => ({})) {}
  async request(_credential: string, req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; body?: unknown; query?: Record<string, string | undefined> }) {
    this.requests.push(req);
    return this.answer(req);
  }
}

export class FakeEmail implements EmailProvider {
  public sent: { to: string[]; cc?: string[]; subject: string; text: string; replyToMessageId?: string }[] = [];
  public inbox: EmailMessage[] = [];
  public processed = new Set<string>();
  address() {
    return "pip@example.test";
  }
  async send(input: { to: string[]; cc?: string[]; subject: string; text: string; replyToMessageId?: string }) {
    this.sent.push(input);
    const id = `mail_${this.sent.length}`;
    return { messageId: id, evidence: `fake-email:${id}` };
  }
  async unprocessed() {
    return this.inbox.filter((m) => !this.processed.has(m.id));
  }
  async thread(threadId: string) {
    return this.inbox.filter((m) => m.threadId === threadId);
  }
  async markProcessed(ids: string[]) {
    for (const id of ids) this.processed.add(id);
  }
}

export class FakeSlack implements SlackProvider {
  public calls: { method: string; params: Record<string, unknown> }[] = [];
  constructor(private answer: (method: string, params: Record<string, unknown>) => unknown = () => ({ ok: true, messages: [] })) {}
  async call(_token: string, method: string, params: Record<string, unknown>) {
    this.calls.push({ method, params });
    return this.answer(method, params);
  }
}

export class FakeSpeech implements SpeechProvider {
  public spoken: string[] = [];
  async speak(input: { text: string }) {
    this.spoken.push(input.text);
    return { audioBase64: Buffer.from(`audio:${input.text}`).toString("base64"), mimeType: "audio/mpeg", evidence: `fake-tts:${this.spoken.length}` };
  }
}

export class FakeImages implements ImageProvider {
  public prompts: string[] = [];
  async generate(input: { prompt: string }) {
    this.prompts.push(input.prompt);
    // A 1x1 transparent PNG.
    return {
      imageBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      mimeType: "image/png",
      evidence: `fake-image:${this.prompts.length}`,
    };
  }
}

export class FakePayments implements PaymentProvider {
  public cards: { amountUsd: number; merchant: string; personId: string }[] = [];
  public cancelled: string[] = [];
  async issueCard(input: { amountUsd: number; merchant: string; personId: string }) {
    this.cards.push(input);
    const id = `card_${this.cards.length}`;
    return { cardId: id, last4: "4242", details: JSON.stringify({ number: "4242424242424242", exp: "12/30", cvc: "123" }), evidence: `fake-card:${id}` };
  }
  async cancelCard(cardId: string) {
    this.cancelled.push(cardId);
  }
}

export class FakeHotels implements HotelProvider {
  public searches: { city: string; checkIn: string; checkOut: string }[] = [];
  constructor(
    public offers: HotelOffer[] = [
      {
        id: "lp1",
        name: "Hotel Nouvel",
        stars: 3,
        rating: 8.9,
        address: "Carrer de Santa Anna 20",
        room: "Double",
        board: "Room Only",
        refundable: true,
        netUsd: 239.55,
        publicUsd: 275.48,
        excludedFeesUsd: 0,
      },
      {
        id: "lp2",
        name: "Catalonia Avinyó",
        stars: 4,
        rating: 9.1,
        address: "Carrer d'Avinyó 16",
        room: "Double",
        board: "Breakfast Included",
        refundable: false,
        netUsd: 265.62,
        publicUsd: 305.46,
        excludedFeesUsd: 34.48,
      },
      {
        id: "lp3",
        name: "Leonardo Las Ramblas",
        stars: 4,
        rating: 8.4,
        room: "Double",
        board: "Room Only",
        refundable: true,
        netUsd: 308.57,
        publicUsd: 354.86,
        excludedFeesUsd: 0,
      },
    ],
  ) {}
  async rates(input: { city: string; countryCode: string; checkIn: string; checkOut: string; adults: number; limit?: number }) {
    this.searches.push({ city: input.city, checkIn: input.checkIn, checkOut: input.checkOut });
    return { offers: this.offers.slice(0, input.limit ?? 10), evidence: `fake-hotels:${this.searches.length}` };
  }
}

export class FakeFlights implements FlightProvider {
  public queries: FlightQuery[] = [];
  constructor(
    public offers: FlightOffer[] = [
      {
        flights: ["AA3177", "AA1796"],
        airline: "American",
        departAt: "2026-12-06T23:55:00",
        arriveAt: "2026-12-07T10:09:00",
        durationMin: 434,
        stops: 1,
        cabin: "First",
        totalUsd: 787.2,
        refundable: false,
        changeable: true,
        checkedBag: true,
        offerId: "off_1",
      },
      {
        flights: ["AA4"],
        airline: "American",
        departAt: "2026-12-06T06:30:00",
        arriveAt: "2026-12-06T14:59:00",
        durationMin: 329,
        stops: 0,
        cabin: "First",
        totalUsd: 1950,
        refundable: false,
        changeable: true,
        checkedBag: true,
        offerId: "off_2",
      },
    ],
  ) {}
  async search(q: FlightQuery) {
    this.queries.push(q);
    return { offers: this.offers, evidence: `fake-flights:${this.queries.length}` };
  }
}

export class FakePublicFlights implements PublicFlightsProvider {
  public queries: FlightQuery[] = [];
  constructor(
    public offers: PublicFlightOffer[] = [
      {
        flights: ["AA3177", "AA1796"],
        airline: "American",
        departAt: "2026-12-06T23:55:00-08:00",
        arriveAt: "2026-12-07T10:09:00-05:00",
        durationMin: 434,
        stops: 1,
        totalUsd: 788,
        seller: "American",
        url: "https://www.google.com/travel/flights",
      },
      {
        flights: ["AA4"],
        airline: "American",
        departAt: "2026-12-06T06:30:00-08:00",
        arriveAt: "2026-12-06T14:59:00-05:00",
        durationMin: 329,
        stops: 0,
        totalUsd: 2099,
        seller: "American",
        url: "https://www.google.com/travel/flights",
      },
      {
        flights: ["DL1"],
        airline: "Delta",
        departAt: "2026-12-06T06:15:00-08:00",
        arriveAt: "2026-12-06T14:31:00-05:00",
        durationMin: 316,
        stops: 0,
        totalUsd: 3849,
        seller: "Delta",
        url: "https://www.google.com/travel/flights",
      },
    ],
  ) {}
  async search(q: FlightQuery) {
    this.queries.push(q);
    return { offers: this.offers, source: "Google Flights", evidence: `fake-public-flights:${this.queries.length}` };
  }
}

export class FakePublicRates implements PublicRatesProvider {
  public queries: PublicRatesQuery[] = [];
  constructor(
    public offers: PublicOffer[] = [
      {
        name: "Hotel Nouvel",
        totalUsd: 343,
        seller: "Booking.com",
        refundable: true,
        url: "https://www.booking.com",
        allIn: true,
        listedBelow: { seller: "Super.com", totalUsd: 290, url: "https://www.super.com" },
      },
      { name: "Catalonia Avinyo", totalUsd: 290, seller: "Agoda", refundable: false, url: "https://www.agoda.com", allIn: false },
    ],
  ) {}
  async search(q: PublicRatesQuery) {
    this.queries.push(q);
    return { offers: this.offers, source: "Booking.com", evidence: `fake-public-rates:${this.queries.length}` };
  }
}

export interface FakeHands extends Hands {
  search: FakeSearch;
  hotels: FakeHotels;
  publicRates: FakePublicRates;
  flights: FakeFlights;
  publicFlights: FakePublicFlights;
  phone: FakePhone;
  community: FakeCommunity;
  browser: FakeBrowser;
  google: FakeGoogle;
  email: FakeEmail;
  slack: FakeSlack;
  speech: FakeSpeech;
  images: FakeImages;
  payments: FakePayments;
}

export function fakeHands(opts: Partial<FakeHands> = {}): FakeHands {
  return {
    search: opts.search ?? new FakeSearch(),
    hotels: opts.hotels ?? new FakeHotels(),
    publicRates: opts.publicRates ?? new FakePublicRates(),
    flights: opts.flights ?? new FakeFlights(),
    publicFlights: opts.publicFlights ?? new FakePublicFlights(),
    phone: opts.phone ?? new FakePhone(),
    community: opts.community ?? new FakeCommunity(),
    browser: opts.browser ?? new FakeBrowser(),
    google: opts.google ?? new FakeGoogle(),
    email: opts.email ?? new FakeEmail(),
    slack: opts.slack ?? new FakeSlack(),
    speech: opts.speech ?? new FakeSpeech(),
    images: opts.images ?? new FakeImages(),
    payments: opts.payments ?? new FakePayments(),
  };
}
