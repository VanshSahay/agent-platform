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

export interface Hands {
  search: SearchProvider;
  phone: PhoneProvider;
  community: CommunityProvider;
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

export function fakeHands(opts: { search?: FakeSearch; phone?: FakePhone; community?: FakeCommunity } = {}): Hands & {
  search: FakeSearch;
  phone: FakePhone;
  community: FakeCommunity;
} {
  return {
    search: opts.search ?? new FakeSearch(),
    phone: opts.phone ?? new FakePhone(),
    community: opts.community ?? new FakeCommunity(),
  };
}
