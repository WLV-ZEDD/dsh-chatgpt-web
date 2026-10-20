import { expect, test } from "bun:test";
import {
  assertChatGptWebInputWithinLimits,
  assertChatGptWebMultipartInputWithinLimits,
} from "../src/adapters/chatgpt-web/browser-worker";

const plusCapabilities = {
  localToolsEnabled: true,
  solAvailable: true,
  proAvailable: false,
  experimentalBiggerContext: false,
};

test("GPT-6 turns are not rejected by the Plus transport limit gate", () => {
  expect(() => assertChatGptWebInputWithinLimits(100, 100, "gpt-6", "low", plusCapabilities, 10)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(100, 100, "gpt-6", "medium", plusCapabilities, 10)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(100, 100, "gpt-6", "high", plusCapabilities, 10)).not.toThrow();
});

test("GPT-6 still enforces the Sol-class context window", () => {
  expect(() => assertChatGptWebInputWithinLimits(10_000_000, 100, "gpt-6", "low", plusCapabilities, 10))
    .toThrow(/exceeds the/);
});

test("unknown models are still rejected", () => {
  expect(() => assertChatGptWebInputWithinLimits(100, 100, "gpt-9", "low", plusCapabilities, 10))
    .toThrow(/context limit is not defined for model: gpt-9/);
});

test("GPT-6 reaches Bigger Context instead of the model gate", () => {
  let message = "";
  try {
    assertChatGptWebMultipartInputWithinLimits(100, 100, "gpt-6", "low", plusCapabilities, 1_000, 2);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).not.toMatch(/not defined for model/);
});

test("Luna is still refused by Bigger Context", () => {
  expect(() => assertChatGptWebMultipartInputWithinLimits(100, 100, "gpt-5.6-luna", "low", plusCapabilities, 1_000, 2))
    .toThrow(/Bigger Context is unavailable for Luna/);
});
