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

/** A wholesale marketplace (Faire) reached through one shop account held by the deployment, used for every chat's group orders. */
export interface WholesaleBrand {
  id: string;
  name: string;
  category: string;
  /** First order and reorder minimums in USD; 0 when the brand has none. */
  minimumUsd: number;
  reorderMinimumUsd: number;
  rating?: number;
  topShop?: boolean;
  url?: string;
}
export interface WholesaleProduct {
  id: string;
  brandId: string;
  name: string;
  wholesaleUsd: number;
  retailUsd?: number;
  /** Units per wholesale case, when sold by the case. */
  caseSize?: number;
  inStock: boolean;
}
export interface WholesaleProvider {
  findBrands(query: string, opts?: { category?: string; limit?: number }): Promise<WholesaleBrand[]>;
  brand(brandId: string): Promise<{ brand: WholesaleBrand; products: WholesaleProduct[] } | undefined>;
  placeOrder(input: { brandId: string; lines: { productId: string; quantity: number }[]; note?: string }): Promise<{ orderId: string; totalUsd: number; evidence: string }>;
}

export interface Hands {
  search: SearchProvider;
  wholesale: WholesaleProvider;
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

export class FakeWholesale implements WholesaleProvider {
  public orders: { brandId: string; lines: { productId: string; quantity: number }[]; totalUsd: number }[] = [];
  constructor(
    public brands: WholesaleBrand[] = [
      { id: "b_candyclub", name: "Candy Club", category: "food", minimumUsd: 150, reorderMinimumUsd: 100, rating: 4.8, topShop: true },
      { id: "b_frenchsquirrel", name: "French Squirrel", category: "food", minimumUsd: 200, reorderMinimumUsd: 100, rating: 4.9, topShop: true },
      { id: "b_kimono", name: "KIM+ONO", category: "apparel", minimumUsd: 300, reorderMinimumUsd: 150, rating: 4.7, topShop: true },
    ],
    public products: WholesaleProduct[] = [
      { id: "p_holiday", brandId: "b_candyclub", name: "Holiday Candy Bundle", wholesaleUsd: 24, retailUsd: 48, inStock: true },
      { id: "p_sour", brandId: "b_candyclub", name: "Sour Belts (12 pack)", wholesaleUsd: 12, retailUsd: 24, caseSize: 12, inStock: true },
      { id: "p_gummy", brandId: "b_candyclub", name: "Gummy Bears Jar", wholesaleUsd: 9, retailUsd: 18, inStock: true },
      { id: "p_choc", brandId: "b_frenchsquirrel", name: "Hazelnut Chocolate Bites", wholesaleUsd: 18, retailUsd: 36, inStock: true },
      { id: "p_robe", brandId: "b_kimono", name: "Silk Kimono Robe", wholesaleUsd: 60, retailUsd: 120, inStock: true },
    ],
  ) {}
  async findBrands(query: string, opts: { category?: string; limit?: number } = {}) {
    const q = query.toLowerCase();
    return this.brands
      .filter((b) => (!opts.category || b.category === opts.category) && (!q || b.name.toLowerCase().includes(q) || b.category.includes(q)))
      .slice(0, opts.limit ?? 10);
  }
  async brand(brandId: string) {
    const brand = this.brands.find((b) => b.id === brandId);
    return brand ? { brand, products: this.products.filter((p) => p.brandId === brandId) } : undefined;
  }
  async placeOrder(input: { brandId: string; lines: { productId: string; quantity: number }[]; note?: string }) {
    const totalUsd = input.lines.reduce((t, l) => t + (this.products.find((p) => p.id === l.productId)?.wholesaleUsd ?? 0) * l.quantity, 0);
    this.orders.push({ brandId: input.brandId, lines: input.lines, totalUsd });
    const orderId = `fo_${this.orders.length}`;
    return { orderId, totalUsd, evidence: `fake-wholesale:${orderId}` };
  }
}

export interface FakeHands extends Hands {
  search: FakeSearch;
  wholesale: FakeWholesale;
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
    wholesale: opts.wholesale ?? new FakeWholesale(),
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
