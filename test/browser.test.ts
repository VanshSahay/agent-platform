import { describe, expect, test } from "bun:test";
import { type BrowserProvider, FakeBrowser, FallbackBrowser } from "../src/tools/browser.ts";

const broken: BrowserProvider = {
  readPage: async () => {
    throw new Error("connectOverCDP: Timeout 30000ms exceeded");
  },
  run: async () => {
    throw new Error("connectOverCDP: Timeout 30000ms exceeded");
  },
  startSignIn: async () => ({ sessionId: "s1", liveViewUrl: "https://live.example/s1", contextId: "c1" }),
  finishSignIn: async () => undefined,
};

describe("browser chain", () => {
  test("a provider that cannot connect is skipped and the next one answers; sign-in stays with the one that hosts it", async () => {
    const fake = new FakeBrowser(() => ({ title: "Zalto", text: "Gravitas Omega €54.10" }));
    const warnings: string[] = [];
    const chain = new FallbackBrowser(
      [
        { name: "browserbase", browser: broken },
        { name: "chrome", browser: fake },
      ],
      (l) => warnings.push(l),
    );
    const page = await chain.readPage({ url: "https://shop.example/zalto" });
    expect(page.title).toBe("Zalto");
    expect(fake.visited).toEqual(["https://shop.example/zalto"]);
    expect(warnings[0]).toContain("browserbase failed");
    expect((await chain.startSignIn!({ site: "gym.example" })).liveViewUrl).toBe("https://live.example/s1");
  });

  test("when every provider fails the last error surfaces, and a chain with no sign-in host offers none", async () => {
    const chain = new FallbackBrowser([{ name: "a", browser: broken }], () => undefined);
    await expect(chain.run({ url: "https://x.example", steps: [] })).rejects.toThrow("Timeout");
    const readOnly = new FallbackBrowser([{ name: "fake", browser: new FakeBrowser() }], () => undefined);
    const noSignIn = new FallbackBrowser([{ name: "plain", browser: { readPage: readOnly.readPage.bind(readOnly), run: readOnly.run.bind(readOnly) } }], () => undefined);
    expect(noSignIn.startSignIn).toBeUndefined();
  });
});
