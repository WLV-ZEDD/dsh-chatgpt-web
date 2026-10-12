import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { Page } from "playwright-core";
import { assertAuthenticatedChatGptPage } from "../src/chatgpt-session";

function pageFor({
  visible = true,
  origin = "https://chatgpt.com",
  session = { user: { id: "test-user" } } as unknown,
  responseOk = true,
  failure = false,
  malformed = false,
} = {}): Page {
  return {
    url: () => `${origin}/?temporary-chat=true`,
    locator: () => ({ count: async () => 1, nth: () => ({ isVisible: async () => visible }) }),
    evaluate: async (callback: () => Promise<boolean>) => runInNewContext(`(${callback.toString()})()`, {
      AbortSignal,
      fetch: async (url: string, options: RequestInit) => {
        expect(url).toBe("/api/auth/session");
        expect(options.credentials).toBe("include");
        expect(options.signal).toBeDefined();
        if (failure) throw new Error("Network unavailable");
        return {
          ok: responseOk,
          json: async () => {
            if (malformed) throw new SyntaxError("Invalid JSON");
            return session;
          },
        };
      },
    }),
  } as unknown as Page;
}

test("a guest composer is not authenticated", async () => {
  await expect(assertAuthenticatedChatGptPage(pageFor({ session: {} }))).rejects.toThrow("sign in");
});

test("authentication requires a visible composer", async () => {
  await expect(assertAuthenticatedChatGptPage(pageFor({ visible: false }))).rejects.toThrow("no visible composer");
});

test("authentication rejects other origins", async () => {
  await expect(assertAuthenticatedChatGptPage(pageFor({ origin: "https://example.com" }))).rejects.toThrow("unexpected page origin");
});

test("an authenticated ChatGPT session with a composer is accepted", async () => {
  await assertAuthenticatedChatGptPage(pageFor());
});

test("authentication rejects failed session responses", async () => {
  await expect(assertAuthenticatedChatGptPage(pageFor({ responseOk: false }))).rejects.toThrow("sign in");
  await expect(assertAuthenticatedChatGptPage(pageFor({ failure: true }))).rejects.toThrow("sign in");
  await expect(assertAuthenticatedChatGptPage(pageFor({ malformed: true }))).rejects.toThrow("sign in");
});

test("authentication requires a nonempty string user id", async () => {
  for (const session of [null, { user: {} }, { user: { id: "" } }, { user: { id: 42 } }]) {
    await expect(assertAuthenticatedChatGptPage(pageFor({ session }))).rejects.toThrow("sign in");
  }
});
