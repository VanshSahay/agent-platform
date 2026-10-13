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

export interface BrowserProvider {
  /** Open a URL, optionally run one simple action, and return the page as text. */
  readPage(input: { url: string; action?: { click?: string; fill?: { selector: string; value: string }; waitMs?: number } }): Promise<PageRead>;
}

export class FakeBrowser implements BrowserProvider {
  public visited: string[] = [];
  constructor(private pages: (url: string) => Partial<PageRead> = () => ({})) {}
  async readPage(input: { url: string }): Promise<PageRead> {
    this.visited.push(input.url);
    const p = this.pages(input.url);
    return { url: input.url, title: p.title ?? "", text: p.text ?? "", links: p.links ?? [], evidence: `fake-browser:${this.visited.length}` };
  }
}

const MAX_TEXT = 12_000;

export class BrowserbaseBrowser implements BrowserProvider {
  private projectId?: string;
  constructor(
    private apiKey: string,
    opts: { projectId?: string } = {},
  ) {
    this.projectId = opts.projectId;
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

  async readPage(input: { url: string; action?: { click?: string; fill?: { selector: string; value: string }; waitMs?: number } }): Promise<PageRead> {
    const projectId = await this.project();
    const create = await fetch("https://api.browserbase.com/v1/sessions", {
      method: "POST",
      headers: { "X-BB-API-Key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    if (!create.ok) throw new Error(`Browserbase session: ${create.status} ${await create.text()}`);
    const session = (await create.json()) as { id: string; connectUrl: string };
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
      const links = (await page.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]"))
          .slice(0, 60)
          .map((a) => ({ text: (a.textContent ?? "").trim().slice(0, 80), href: (a as HTMLAnchorElement).href })),
      )).filter((l) => l.text);
      return { url: page.url(), title, text, links, evidence: `browserbase:${session.id}` };
    } finally {
      await browser?.close().catch(() => undefined);
      await fetch(`https://api.browserbase.com/v1/sessions/${session.id}`, {
        method: "POST",
        headers: { "X-BB-API-Key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ projectId, status: "REQUEST_RELEASE" }),
      }).catch(() => undefined);
    }
  }
}
