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

export class BrowserbaseBrowser implements BrowserProvider {
  async run(input: { url: string; contextId?: string; steps: BrowserStep[] }): Promise<BrowserRun> {
    const projectId = await this.project();
    const session = await this.createSession(projectId, input.contextId ? { browserSettings: { context: { id: input.contextId, persist: true } } } : {});
    let browser: Browser | undefined;
    const screenshots: string[] = [];
    try {
      browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 30_000 });
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      for (const st of input.steps.slice(0, 20)) {
        if ("goto" in st) await page.goto(st.goto, { waitUntil: "domcontentloaded", timeout: 45_000 });
        else if ("click" in st) await page.click(st.click, { timeout: 10_000 });
        else if ("fill" in st) await page.fill(st.fill.selector, st.fill.value, { timeout: 10_000 });
        else if ("press" in st) await page.keyboard.press(st.press);
        else if ("scroll" in st) await page.mouse.wheel(0, st.scroll === "down" ? 800 : -800);
        else if ("waitMs" in st) await page.waitForTimeout(Math.min(st.waitMs, 10_000));
        else if ("screenshot" in st) screenshots.push((await page.screenshot({ type: "png" })).toString("base64"));
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
      }
      const title = await page.title();
      const text = (await page.evaluate(() => document.body?.innerText ?? "")).replace(/\n{3,}/g, "\n\n").slice(0, MAX_TEXT);
      return { url: page.url(), title, text, screenshots, evidence: `browserbase:${session.id}` };
    } finally {
      await browser?.close().catch(() => undefined);
      await this.release(projectId, session.id);
    }
  }

  private projectId?: string;
  /** Sign-in sessions stay open (CDP connection held) until the person presses Done or Cancel. */
  private live = new Map<string, { browser: Browser; projectId: string }>();
  constructor(
    private apiKey: string,
    opts: { projectId?: string } = {},
  ) {
    this.projectId = opts.projectId;
  }

  private headers() {
    return { "X-BB-API-Key": this.apiKey, "content-type": "application/json" };
  }

  private async createSession(projectId: string, extra: Record<string, unknown> = {}): Promise<{ id: string; connectUrl: string }> {
    const res = await fetch("https://api.browserbase.com/v1/sessions", { method: "POST", headers: this.headers(), body: JSON.stringify({ projectId, ...extra }) });
    if (!res.ok) throw new Error(`Browserbase session: ${res.status} ${await res.text()}`);
    return (await res.json()) as { id: string; connectUrl: string };
  }

  private async release(projectId: string, sessionId: string) {
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
    const settings = { browserSettings: { context: { id: context.id, persist: true } } };
    // A longer session when the plan allows it; otherwise the project default.
    const session = await this.createSession(projectId, { ...settings, timeout: 900 }).catch(() => this.createSession(projectId, settings));
    const debugRes = await fetch(`https://api.browserbase.com/v1/sessions/${session.id}/debug`, { headers: this.headers() });
    if (!debugRes.ok) throw new Error(`Browserbase live view: ${debugRes.status}`);
    const debug = (await debugRes.json()) as { debuggerFullscreenUrl: string };
    const browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 30_000 });
    this.live.set(session.id, { browser, projectId });
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
    let browser: Browser | undefined;
    try {
      browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 30_000 });
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      if (input.action?.fill) await page.fill(input.action.fill.selector, input.action.fill.value, { timeout: 10_000 });
      if (input.action?.click) await page.click(input.action.click, { timeout: 10_000 });
      if (input.action?.waitMs) await page.waitForTimeout(Math.min(input.action.waitMs, 10_000));
      else if (input.action?.click || input.action?.fill) await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
      const title = await page.title();
      const text = (await page.evaluate(() => document.body?.innerText ?? "")).replace(/\n{3,}/g, "\n\n").slice(0, MAX_TEXT);
      const links = (
        await page.evaluate(() =>
          Array.from(document.querySelectorAll("a[href]"))
            .slice(0, 60)
            .map((a) => ({ text: (a.textContent ?? "").trim().slice(0, 80), href: (a as HTMLAnchorElement).href })),
        )
      ).filter((l) => l.text);
      return { url: page.url(), title, text, links, evidence: `browserbase:${session.id}` };
    } finally {
      await browser?.close().catch(() => undefined);
      await this.release(projectId, session.id);
    }
  }
}
