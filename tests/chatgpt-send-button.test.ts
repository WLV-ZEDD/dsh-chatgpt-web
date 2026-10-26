import { expect, test } from "bun:test";
import type { Locator, Page } from "playwright-core";
import { resolveChatGptSendButton } from "../src/adapters/chatgpt-web/browser-worker";

interface MockNode {
  tag: string;
  attrs: Record<string, string>;
  parent: MockNode | null;
  children: MockNode[];
}

function createElement(tag: string, attrs: Record<string, string> = {}, children: MockNode[] = []): MockNode {
  const node: MockNode = { tag, attrs, parent: null, children: [] };
  for (const child of children) {
    child.parent = node;
    node.children.push(child);
  }
  return node;
}

function findDescendants(node: MockNode, predicate: (n: MockNode) => boolean): MockNode[] {
  const results: MockNode[] = [];
  for (const child of node.children) {
    if (predicate(child)) results.push(child);
    results.push(...findDescendants(child, predicate));
  }
  return results;
}

function matchesSelectorClause(node: MockNode, clause: string): boolean {
  clause = clause.trim();
  if (clause === '[data-testid="send-button"]') {
    return node.attrs["data-testid"] === "send-button";
  }
  if (clause === 'button[aria-label="Send"]') {
    return node.tag === "button" && node.attrs["aria-label"] === "Send";
  }
  if (clause === 'button[aria-label="发送"]') {
    return node.tag === "button" && node.attrs["aria-label"] === "发送";
  }
  if (clause === 'button[aria-label="发送消息"]') {
    return node.tag === "button" && node.attrs["aria-label"] === "发送消息";
  }
  if (clause.toLowerCase().includes('button[aria-label*="send" i]')) {
    return node.tag === "button" && (node.attrs["aria-label"] ?? "").toLowerCase().includes("send");
  }
  if (clause.includes('button[aria-label*="发送"]')) {
    return node.tag === "button" && (node.attrs["aria-label"] ?? "").includes("发送");
  }
  if (clause.startsWith('[data-testid="') && clause.endsWith('"]')) {
    const val = clause.slice(15, -2);
    return node.attrs["data-testid"] === val;
  }
  return false;
}

function matchesSelector(node: MockNode, selector: string): boolean {
  const clauses = selector.split(",").map(s => s.trim());
  return clauses.some(c => matchesSelectorClause(node, c));
}

class MockLocator {
  constructor(public nodes: MockNode[]) {}

  async count(): Promise<number> {
    return this.nodes.length;
  }

  first(): MockLocator {
    return new MockLocator(this.nodes.slice(0, 1));
  }

  locator(selector: string): MockLocator {
    if (selector.startsWith("xpath=ancestor::form[1]")) {
      const results: MockNode[] = [];
      for (const node of this.nodes) {
        let curr = node.parent;
        while (curr) {
          if (curr.tag === "form") {
            results.push(curr);
            break;
          }
          curr = curr.parent;
        }
      }
      return new MockLocator(results);
    }
    if (selector.startsWith("xpath=ancestor::*[self::form or self::div or @role='group' or @role='region'][1]")) {
      const results: MockNode[] = [];
      for (const node of this.nodes) {
        let curr = node.parent;
        while (curr) {
          if (
            curr.tag === "form"
            || curr.tag === "div"
            || curr.attrs["role"] === "group"
            || curr.attrs["role"] === "region"
          ) {
            results.push(curr);
            break;
          }
          curr = curr.parent;
        }
      }
      return new MockLocator(results);
    }

    const results: MockNode[] = [];
    for (const node of this.nodes) {
      results.push(...findDescendants(node, n => matchesSelector(n, selector)));
    }
    return new MockLocator(results);
  }
}

class MockPage {
  constructor(public root: MockNode) {}

  locator(selector: string): MockLocator {
    const results = findDescendants(this.root, n => matchesSelector(n, selector));
    return new MockLocator(results);
  }
}

test("Scenario A (baseline): locates send button within ancestor <form> using English label", async () => {
  const composer = createElement("div", { id: "prompt-textarea" });
  const sendButton = createElement("button", { "data-testid": "send-button", "aria-label": "Send" });
  const form = createElement("form", {}, [composer, sendButton]);
  const root = createElement("div", {}, [form]);

  const composerLoc = new MockLocator([composer]) as unknown as Locator;
  const pageLoc = new MockPage(root) as unknown as Page;

  const btn = await resolveChatGptSendButton(composerLoc, pageLoc);
  expect(await btn.count()).toBe(1);
});

test("Scenario B (Issue #7 repro): locates send button within ancestor <div> container without form", async () => {
  const composer = createElement("div", { id: "prompt-textarea" });
  const sendButton = createElement("button", { "data-testid": "send-button" });
  const container = createElement("div", { class: "chat-input-container" }, [composer, sendButton]);
  const root = createElement("div", { id: "app" }, [container]);

  const composerLoc = new MockLocator([composer]) as unknown as Locator;
  const pageLoc = new MockPage(root) as unknown as Page;

  const btn = await resolveChatGptSendButton(composerLoc, pageLoc);
  expect(await btn.count()).toBe(1);
});

test("Scenario C (multilingual): locates send button with Chinese aria-label (发送)", async () => {
  const composer = createElement("div", { id: "prompt-textarea" });
  const sendButton = createElement("button", { "aria-label": "发送" });
  const form = createElement("form", {}, [composer, sendButton]);
  const root = createElement("div", {}, [form]);

  const composerLoc = new MockLocator([composer]) as unknown as Locator;
  const pageLoc = new MockPage(root) as unknown as Page;

  const btn = await resolveChatGptSendButton(composerLoc, pageLoc);
  expect(await btn.count()).toBe(1);
});

test("Scenario D (multilingual): locates send button with Chinese aria-label (发送消息) in div container", async () => {
  const composer = createElement("div", { id: "prompt-textarea" });
  const sendButton = createElement("button", { "aria-label": "发送消息" });
  const container = createElement("div", { role: "region" }, [composer, sendButton]);
  const root = createElement("div", {}, [container]);

  const composerLoc = new MockLocator([composer]) as unknown as Locator;
  const pageLoc = new MockPage(root) as unknown as Page;

  const btn = await resolveChatGptSendButton(composerLoc, pageLoc);
  expect(await btn.count()).toBe(1);
});

test("Scenario E (fallback): locates send button via page fallback when composer container has no direct button", async () => {
  const composer = createElement("div", { id: "prompt-textarea" });
  const container = createElement("div", { class: "input-box" }, [composer]);
  const sendButton = createElement("button", { "data-testid": "send-button" });
  const root = createElement("div", {}, [container, sendButton]);

  const composerLoc = new MockLocator([composer]) as unknown as Locator;
  const pageLoc = new MockPage(root) as unknown as Page;

  const btn = await resolveChatGptSendButton(composerLoc, pageLoc);
  expect(await btn.count()).toBe(1);
});
