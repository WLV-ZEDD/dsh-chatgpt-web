import { expect, test } from "bun:test";
import {
  ChatGptNetworkStreamParser,
  appendText,
  parseChatGptNetworkStream,
} from "../src/adapters/chatgpt-web/network-stream";

function sse(events: string[]): string {
  return events.map(event => `${event}\n\n`).join("");
}

test("reassembles append deltas into the visible answer", () => {
  const body = sse([
    'event: delta_encoding\ndata: "v1"',
    'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"m1","author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress","channel":"final","recipient":"all"},"conversation_id":"c1"},"c":0}',
    'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"Hello"}',
    'event: delta\ndata: {"v":" world"}',
    'event: delta\ndata: {"v":"!"}',
    "data: [DONE]",
  ]);

  const state = parseChatGptNetworkStream(body);
  expect(state.status).toBe("complete");
  expect(state.conversationId).toBe("c1");
  expect(state.messageId).toBe("m1");
  expect(state.text).toBe("Hello world!");
});

test("normalizes cumulative parts instead of duplicating text", () => {
  const body = sse([
    'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":[""]},"channel":"final"},"conversation_id":"c1"}}',
    'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"Hel"}',
    'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"Hello"}',
    'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"Hello world"}',
    "data: [DONE]",
  ]);
  expect(parseChatGptNetworkStream(body).text).toBe("Hello world");
});

test("applies a root patch containing nested append operations", () => {
  const body = sse([
    'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":[""]},"channel":"final"}}}',
    'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"Patched text"},{"p":"/message/status","o":"replace","v":"finished_successfully"}]}',
    "data: [DONE]",
  ]);
  expect(parseChatGptNetworkStream(body).text).toBe("Patched text");
});

test("handles arbitrary chunk boundaries without losing partial lines", () => {
  const body = sse([
    'event: delta_encoding\ndata: "v1"',
    'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":[""]},"channel":"final"},"conversation_id":"c1"}}',
    'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"Boundary-safe"}',
    "data: [DONE]",
  ]);
  const parser = new ChatGptNetworkStreamParser();
  for (const char of body) parser.push(char);
  parser.finish();
  expect(parser.snapshot().text).toBe("Boundary-safe");
  expect(parser.snapshot().conversationId).toBe("c1");
});

test("separates analysis reasoning from the visible answer", () => {
  const body = sse([
    'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"r1","author":{"role":"assistant"},"content":{"parts":[""]},"channel":"analysis"},"conversation_id":"c1"}}',
    'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"Thinking"}',
    'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":[""]},"channel":"final"},"conversation_id":"c1"}}',
    'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"Answer"}',
    "data: [DONE]",
  ]);
  const state = parseChatGptNetworkStream(body);
  expect(state.reasoning).toContain("Thinking");
  expect(state.text).toBe("Answer");
});

test("extracts server-assigned IDs and handoff metadata", () => {
  const body = sse([
    'event: delta_encoding\ndata: "v1"',
    'data: {"type":"resume_conversation_token","kind":"topic","token":"jwt","conversation_id":"c1"}',
    'data: {"type":"stream_handoff","conversation_id":"c1","turn_exchange_id":"t1","options":[{"type":"subscribe_ws_topic","topic_id":"conversation-turn-t1"},{"type":"resume_sse_endpoint","topic_id":"conversation-turn-t1"}]}',
    "data: [DONE]",
  ]);
  const state = parseChatGptNetworkStream(body);
  expect(state.conversationId).toBe("c1");
  expect(state.turnExchangeId).toBe("t1");
  expect(state.handoff?.topicId).toBe("conversation-turn-t1");
  expect(state.handoff?.resumeSseEndpoint).toBe("conversation-turn-t1");
});

test("surfaces stream errors with their upstream code", () => {
  const body = sse([
    'data: {"type":"error","error":{"code":"too_long","message":"The messages you submitted were too long, please edit them and resubmit."}}',
  ]);
  const state = parseChatGptNetworkStream(body);
  expect(state.status).toBe("error");
  expect(state.error?.code).toBe("too_long");
  expect(state.error?.message).toContain("too long");
});

test("records tool messages separately from visible text", () => {
  const body = sse([
    'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"tool1","author":{"role":"tool","name":"web.run"},"content":{"parts":["search result"]},"recipient":"all"}}}',
    'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":[""]},"channel":"final"}}}',
    'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"Final answer"}',
    "data: [DONE]",
  ]);
  const state = parseChatGptNetworkStream(body);
  expect(state.text).toBe("Final answer");
  expect(state.toolMessages).toHaveLength(1);
  expect(state.toolMessages[0]?.name).toBe("web.run");
  expect(state.toolMessages[0]?.text).toBe("search result");
});

test("appendText recognizes cumulative and incremental fragments", () => {
  expect(appendText("", "abc")).toBe("abc");
  expect(appendText("abc", "def")).toBe("abcdef");
  expect(appendText("abc", "abcd")).toBe("abcd");
  expect(appendText("abcd", "cd")).toBe("abcd");
});
