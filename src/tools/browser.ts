import { existsSync } from "node:fs";
import { redact } from "../ops/ops.ts";
import type { SpendLog } from "../runtime/spend.ts";
import { chromium, type Browser, type Page } from "playwright-core";

/**
 * The browsing hand: open a page in a real browser and read it. Browserbase
 * runs the browser in the cloud so the agent can use sites that need a
 * click (hours, booking widgets, listings), with no password ever passing
 * through the agent: site logins happen in a live session the owner drives.
 */
export interface PageRead {
  url: string;
  title: string;
  text: string;
  links: { text: string; href: string }[];
  evidence: string;
}

export interface SignInSession {
  sessionId: string;
  /** Embeddable live view the person signs in through. */
  liveViewUrl: string;
  /** The persistent browser context that keeps the signed-in cookies. */
  contextId: string;
}

/** One step of a browser_use run. Selectors are CSS or Playwright text= selectors. */
export type BrowserStep =
  | { goto: string }
  | { click: string }
  | { fill: { selector: string; value: string } }
  | { press: string }
  | { scroll: "down" | "up" }
  | { waitMs: number }
  | { extract?: true }
  | { screenshot?: true };

export interface BrowserRun {
  url: string;
  title: string;
  text: string;
  /** PNG, base64, when a step asked for one. */
  screenshots: string[];
  evidence: string;
}

export interface BrowserProvider {
  /** Open a URL, optionally run one simple action, and return the page as text. With `contextId`, browse as that signed-in person. */
  readPage(input: { url: string; contextId?: string; action?: { click?: string; fill?: { selector: string; value: string }; waitMs?: number } }): Promise<PageRead>;
  /** Several steps in one session (navigate, click, type, scroll, screenshot), ending with the page as text. */
  run(input: { url: string; contextId?: string; steps: BrowserStep[] }): Promise<BrowserRun>;
  /** Open a live browser on a site for a person to sign in; the agent never touches the password. */
  startSignIn?(input: { site: string }): Promise<SignInSession>;
  /** End the sign-in session; with `keep`, the context keeps the cookies for later reads. */
  finishSignIn?(sessionId: string, keep: boolean): Promise<void>;
}

export class FakeBrowser implements BrowserProvider {
  public visited: string[] = [];
  public runs: { url: string; steps: BrowserStep[] }[] = [];
  async run(input: { url: string; contextId?: string; steps: BrowserStep[] }): Promise<BrowserRun> {
    this.runs.push({ url: input.url, steps: input.steps });
    const page = await this.readPage({ url: input.url, contextId: input.contextId });
    const shots = input.steps.filter((st) => "screenshot" in st).length;
    return { url: page.url, title: page.title, text: page.text, screenshots: Array.from({ length: shots }, () => FAKE_PNG), evidence: `fake-browser-run:${this.runs.length}` };
  }
  public visitedWith: { url: string; contextId?: string }[] = [];
  public signIns: { site: string; sessionId: string; finished?: boolean; kept?: boolean }[] = [];
  constructor(private pages: (url: string) => Partial<PageRead> = () => ({})) {}
  async readPage(input: { url: string; contextId?: string }): Promise<PageRead> {
    this.visited.push(input.url);
    this.visitedWith.push({ url: input.url, contextId: input.contextId });
    const p = this.pages(input.url);
    return { url: input.url, title: p.title ?? "", text: p.text ?? "", links: p.links ?? [], evidence: `fake-browser:${this.visited.length}` };
  }
  async startSignIn(input: { site: string }): Promise<SignInSession> {
    const n = this.signIns.length + 1;
    this.signIns.push({ site: input.site, sessionId: `fake-signin:${n}` });
    return { sessionId: `fake-signin:${n}`, liveViewUrl: `https://live.example/session/${n}`, contextId: `ctx_${input.site}_${n}` };
  }
  async finishSignIn(sessionId: string, keep: boolean): Promise<void> {
    const s = this.signIns.find((x) => x.sessionId === sessionId);
    if (s) {
      s.finished = true;
      s.kept = keep;
    }
  }
}

const MAX_TEXT = 12_000;

/** A 1x1 transparent PNG, for fakes. */
export const FAKE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** The page as the model reads it: title, text and the first links. Shared by every real browser. */
async function readFrom(page: Page, evidence: string): Promise<PageRead> {
  const title = await page.title();
  const text = (await page.evaluate(() => document.body?.innerText ?? "")).replace(/\n{3,}/g, "\n\n").slice(0, MAX_TEXT);
  const links = (
    await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .slice(0, 60)
        .map((a) => ({ text: (a.textContent ?? "").trim().slice(0, 80), href: (a as HTMLAnchorElement).href })),
    )
  ).filter((l) => l.text);
  return { url: page.url(), title, text, links, evidence };
}

async function runSteps(page: Page, steps: BrowserStep[]): Promise<string[]> {
  const screenshots: string[] = [];
  for (const st of steps.slice(0, 20)) {
    if ("goto" in st) await page.goto(st.goto, { waitUntil: "domcontentloaded", timeout: 45_000 });
    else if ("click" in st) await page.click(st.click, { timeout: 10_000 });
    else if ("fill" in st) await page.fill(st.fill.selector, st.fill.value, { timeout: 10_000 });
    else if ("press" in st) await page.keyboard.press(st.press);
    else if ("scroll" in st) await page.mouse.wheel(0, st.scroll === "down" ? 800 : -800);
    else if ("waitMs" in st) await page.waitForTimeout(Math.min(st.waitMs, 10_000));
    else if ("screenshot" in st) screenshots.push((await page.screenshot({ type: "png" })).toString("base64"));
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
  }
  return screenshots;
}

async function act(page: Page, action?: { click?: string; fill?: { selector: string; value: string }; waitMs?: number }) {
  if (action?.fill) await page.fill(action.fill.selector, action.fill.value, { timeout: 10_000 });
  if (action?.click) await page.click(action.click, { timeout: 10_000 });
  if (action?.waitMs) await page.waitForTimeout(Math.min(action.waitMs, 10_000));
  else if (action?.click || action?.fill) await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
}

const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const BOT_WALL = /something has gone wrong|access denied|are you a (robot|human)|verify you are human|captcha|unusual traffic|enable javascript and cookies/i;
/** A short page that is only a bot wall is a failure for the chain, not a page for the model. */
function unblocked(r: PageRead): PageRead {
  if (r.text.length < 800 && BOT_WALL.test(r.text)) throw new Error(`blocked by the site: ${r.text.replace(/\s+/g, " ").slice(0, 80)}`);
  return r;
}

/** Where a Google Chrome lives on this machine, if anywhere; CHROME_PATH overrides. */
export function localChromePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [
    env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ];
  return candidates.find((c) => c && existsSync(c));
}

/**
 * The Chrome already installed on the machine, headless. One browser, a fresh
 * context per read. It cannot browse as a signed-in person (no persisted
 * contexts) and has no live view for sign-in cards, so those calls fail and the
 * chain below moves on to a provider that can.
 */
export class LocalBrowser implements BrowserProvider {
  private browser?: Promise<Browser>;
  private reads = 0;
  constructor(private executablePath = localChromePath()) {}
  private open(): Promise<Browser> {
    this.browser ??= chromium.launch({ executablePath: this.executablePath, headless: true, args: ["--disable-blink-features=AutomationControlled"] }).then((b) => {
      b.on("disconnected", () => {
        this.browser = undefined;
      });
      return b;
    });
    return this.browser;
  }
  private async withPage<T>(contextId: string | undefined, fn: (page: Page) => Promise<T>): Promise<T> {
    if (contextId) throw new Error("the local browser has no signed-in contexts");
    // Headless Chrome announces itself; shops answer with a bot wall. A plain desktop identity is enough for most.
    const ctx = await (await this.open()).newContext({ userAgent: DESKTOP_UA, locale: "en-US", viewport: { width: 1280, height: 900 } });
    try {
      return await fn(await ctx.newPage());
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
  async readPage(input: { url: string; contextId?: string; action?: { click?: string; fill?: { selector: string; value: string }; waitMs?: number } }): Promise<PageRead> {
    return this.withPage(input.contextId, async (page) => {
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await act(page, input.action);
      return unblocked(await readFrom(page, `chrome:${++this.reads}`));
    });
  }
  async run(input: { url: string; contextId?: string; steps: BrowserStep[] }): Promise<BrowserRun> {
    return this.withPage(input.contextId, async (page) => {
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const screenshots = await runSteps(page, input.steps);
      const r = unblocked(await readFrom(page, `chrome:${++this.reads}`));
      return { ...r, screenshots };
    });
  }
}

/**
 * Try each browser in order; the first that answers wins. Sign-in goes to the
 * first provider that can host one, and stays there for the matching finish.
 */
export class FallbackBrowser implements BrowserProvider {
  startSignIn?: (input: { site: string }) => Promise<SignInSession>;
  finishSignIn?: (sessionId: string, keep: boolean) => Promise<void>;
  constructor(
    private chain: { name: string; browser: BrowserProvider }[],
    private warn: (line: string) => void = (l) => console.warn(l),
  ) {
    const signer = chain.find((c) => c.browser.startSignIn)?.browser;
    if (signer) {
      this.startSignIn = (input) => signer.startSignIn!(input);
      this.finishSignIn = (id, keep) => signer.finishSignIn!(id, keep);
    }
  }
  private async first<T>(what: string, fn: (b: BrowserProvider) => Promise<T>): Promise<T> {
    let last: unknown = new Error("no browser configured");
    for (const { name, browser } of this.chain) {
      try {
        return await fn(browser);
      } catch (e) {
        last = e;
        this.warn(
          `browser ${name} failed on ${what}: ${redact(String((e as Error).message))
            .split("\n")[0]
            ?.slice(0, 160)}`,
        );
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
  readPage(input: Parameters<BrowserProvider["readPage"]>[0]): Promise<PageRead> {
    return this.first(input.url, (b) => b.readPage(input));
  }
  run(input: Parameters<BrowserProvider["run"]>[0]): Promise<BrowserRun> {
    return this.first(input.url, (b) => b.run(input));
  }
}

export class BrowserbaseBrowser implements BrowserProvider {
  async run(input: { url: string; contextId?: string; steps: BrowserStep[] }): Promise<BrowserRun> {
    const projectId = await this.project();
    const session = await this.createSession(projectId, input.contextId ? { browserSettings: { context: { id: input.contextId, persist: true } } } : {});
    const startedAt = Date.now();
    let browser: Browser | undefined;
    try {
      browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 30_000 });
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const screenshots = await runSteps(page, input.steps);
      const r = await readFrom(page, `browserbase:${session.id}`);
      return { ...r, screenshots };
    } finally {
      await browser?.close().catch(() => undefined);
      await this.release(projectId, session.id);
      this.charge(session.id, startedAt, "run");
    }
  }

  private projectId?: string;
  /** Sign-in sessions stay open (CDP connection held) until the person presses Done or Cancel. */
  private live = new Map<string, { browser: Browser; projectId: string; startedAt: number }>();
  private spend?: SpendLog;
  constructor(
    private apiKey: string,
    opts: { projectId?: string; spend?: SpendLog } = {},
  ) {
    this.projectId = opts.projectId;
    this.spend = opts.spend;
  }

  /**
   * Browser time is billed by the hour of session life. Each session is timed from creation to the release
   * request; BROWSERBASE_USD_PER_HOUR prices it (default 0.10, the Startup plan's overage on browserbase.com/pricing,
   * read 22 Oct 2026; the Developer plan's is 0.12, and hours inside a plan's allowance are already paid for).
   * A session Browserbase keeps alive after release, or a minimum billed length, is not counted.
   */
  private charge(sessionId: string, startedAt: number, what: string) {
    if (!this.spend) return;
    const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const perHour = Number(process.env.BROWSERBASE_USD_PER_HOUR ?? 0.1);
    this.spend.record({
      provider: "browserbase",
      usd: (seconds / 3600) * (Number.isFinite(perHour) ? perHour : 0.1),
      units: `browserbase ${seconds} s`,
      note: `${what} ${sessionId}`,
    });
  }

  private headers() {
    return { "X-BB-API-Key": this.apiKey, "content-type": "application/json" };
  }

  // ponytail: the plan allows a few concurrent sessions; two runs browsing at once hit 429. Hold the rest in line and retry once.
  private inFlight = 0;
  private waiters: (() => void)[] = [];
  private async createSession(projectId: string, extra: Record<string, unknown> = {}): Promise<{ id: string; connectUrl: string }> {
    while (this.inFlight >= 2) await new Promise<void>((r) => this.waiters.push(r));
    this.inFlight++;
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch("https://api.browserbase.com/v1/sessions", { method: "POST", headers: this.headers(), body: JSON.stringify({ projectId, ...extra }) });
        if (res.ok) return (await res.json()) as { id: string; connectUrl: string };
        const text = await res.text();
        if (res.status === 429 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 8_000));
          continue;
        }
        throw new Error(`Browserbase session: ${res.status} ${text}`);
      }
    } catch (e) {
      this.inFlight--;
      this.waiters.shift()?.();
      throw e;
    }
  }
  /** Pairs with createSession: a slot opens when the session is released. */
  private async release(projectId: string, sessionId: string) {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.waiters.shift()?.();
    await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ projectId, status: "REQUEST_RELEASE" }),
    }).catch(() => undefined);
  }

  /**
   * A persistent context keeps the cookies the person sets while signing in; the live
   * view is the Browserbase debugger page, which embeds in an iframe. The CDP connection
   * is held open so the session does not end before the person is done.
   */
  async startSignIn(input: { site: string }): Promise<SignInSession> {
    const projectId = await this.project();
    const ctxRes = await fetch("https://api.browserbase.com/v1/contexts", { method: "POST", headers: this.headers(), body: JSON.stringify({ projectId }) });
    if (!ctxRes.ok) throw new Error(`Browserbase context: ${ctxRes.status} ${await ctxRes.text()}`);
    const context = (await ctxRes.json()) as { id: string };
    // A modest remote viewport: the live view scales the remote screen to the card's width, so a 1280-wide
    // page arrives in tiny type; at 1024 by 768 it is close to one-to-one in the chat and readable on a phone.
    const settings = { browserSettings: { context: { id: context.id, persist: true }, viewport: { width: 1024, height: 768 } } };
    // keepAlive: the session outlives this process's CDP connection, so a deploy or restart mid sign-in no longer
    // kills the live view ("Debugging connection was closed"); Done or Cancel still releases it. A longer session
    // when the plan allows it; otherwise the project default.
    const session = await this.createSession(projectId, { ...settings, keepAlive: true, timeout: 900 })
      .catch(() => this.createSession(projectId, { ...settings, keepAlive: true }))
      .catch(() => this.createSession(projectId, settings));
    let debug: { debuggerFullscreenUrl: string };
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
    try {
      const debugRes = await fetch(`https://api.browserbase.com/v1/sessions/${session.id}/debug`, { headers: this.headers() });
      if (!debugRes.ok) throw new Error(`Browserbase live view: ${debugRes.status}`);
      debug = (await debugRes.json()) as { debuggerFullscreenUrl: string };
      browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 30_000 });
    } catch (e) {
      // A keepAlive session that never reached the person would bill and hold a queue slot until the plan's limit.
      await this.release(projectId, session.id);
      throw e;
    }
    this.live.set(session.id, { browser, projectId, startedAt: Date.now() });
    try {
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(`https://${input.site}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch {
      /* the person can navigate in the live view themselves */
    }
    return { sessionId: session.id, liveViewUrl: debug.debuggerFullscreenUrl, contextId: context.id };
  }

  /** Ending the session is what writes the cookies into the context. */
  async finishSignIn(sessionId: string, _keep: boolean): Promise<void> {
    const l = this.live.get(sessionId);
    this.live.delete(sessionId);
    await l?.browser.close().catch(() => undefined);
    await this.release(l?.projectId ?? (await this.project()), sessionId);
    if (l) this.charge(sessionId, l.startedAt, "sign-in");
  }

  private async project(): Promise<string> {
    if (this.projectId) return this.projectId;
    const res = await fetch("https://api.browserbase.com/v1/projects", { headers: { "X-BB-API-Key": this.apiKey } });
    if (!res.ok) throw new Error(`Browserbase projects: ${res.status}`);
    const projects = (await res.json()) as { id: string }[];
    const id = projects[0]?.id;
    if (!id) throw new Error("Browserbase: no project");
    this.projectId = id;
    return id;
  }

  async readPage(input: { url: string; contextId?: string; action?: { click?: string; fill?: { selector: string; value: string }; waitMs?: number } }): Promise<PageRead> {
    const projectId = await this.project();
    // With a context, the page loads with the person's signed-in cookies and keeps any it sets.
    const session = await this.createSession(projectId, input.contextId ? { browserSettings: { context: { id: input.contextId, persist: true } } } : {});
    const startedAt = Date.now();
    let browser: Browser | undefined;
    try {
      browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 30_000 });
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await act(page, input.action);
      return await readFrom(page, `browserbase:${session.id}`);
    } finally {
      await browser?.close().catch(() => undefined);
      await this.release(projectId, session.id);
      this.charge(session.id, startedAt, "read");
    }
  }
}
