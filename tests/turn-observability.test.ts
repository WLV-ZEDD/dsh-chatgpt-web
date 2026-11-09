import { expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  chatGptClassifiedError,
  classifyChatGptTurnFailure,
  compactionFailureNeedsFreshSurface,
} from "../src/adapters/chatgpt-web/turn-observability";

test("pre-send browser setup failures are retryable on a fresh surface", () => {
  const effort = classifyChatGptTurnFailure({
    phase: "prepared",
    message:
      "ChatGPT effort control did not expose its owned menu or structural slider after three activation attempts",
  });
  expect(effort.phase).toBe("pre_send");
  expect(effort.code).toBe("chatgpt_effort_control_unavailable");
  expect(effort.retryable).toBe(true);
  expect(effort.retryDisposition).toBe("retry_fresh_surface");

  const connector = classifyChatGptTurnFailure({
    phase: undefined,
    message:
      'ChatGPT "Add files and more" menu did not expose the "ChatGPT Web Tools" connector; install it under ChatGPT Plugins first',
  });
  expect(connector.code).toBe("chatgpt_connector_unavailable");
  expect(connector.retryable).toBe(true);

  const sessionCheck = classifyChatGptTurnFailure({
    phase: "prepared",
    message:
      "ChatGPT session check is temporarily unavailable (network_error). Retry after the network and profile finish loading; your saved login has not been changed.",
  });
  expect(sessionCheck.code).toBe("chatgpt_session_check_unavailable");
  expect(sessionCheck.status).toBe(503);
  expect(sessionCheck.retryable).toBe(true);
});

test("context limits are not retried as browser-surface failures", () => {
  const preflight = classifyChatGptTurnFailure({
    phase: "prepared",
    message:
      "This task is estimated at 120,095 input tokens, which exceeds the 90,000-token context window for this ChatGPT Web model.",
  });
  expect(preflight.code).toBe("context_length_exceeded");
  expect(preflight.status).toBe(400);
  expect(preflight.retryable).toBe(false);

  const submitted = classifyChatGptTurnFailure({
    phase: "accepted",
    message:
      "ChatGPT rejected the submitted messages as too long. Compact the conversation before retrying.",
  });
  expect(submitted.code).toBe("context_length_exceeded");
  expect(submitted.retryable).toBe(false);
});

test("post-send observation failures keep specific codes and never replay", () => {
  const detached = classifyChatGptTurnFailure({
    phase: "accepted",
    message:
      "ChatGPT opened another user turn while the bound assistant response was detached",
  });
  expect(detached.phase).toBe("observing");
  expect(detached.code).toBe("chatgpt_response_detached");
  expect(detached.retryable).toBe(false);
  expect(detached.retryDisposition).toBe("none");

  const lost = classifyChatGptTurnFailure({
    phase: "accepted",
    message: "ChatGPT response DOM disappeared while the browser turn was active",
  });
  expect(lost.code).toBe("chatgpt_response_dom_lost");

  const timeout = classifyChatGptTurnFailure({
    phase: "accepted",
    message: "ChatGPT browser DOM observation did not respond within 15000ms",
  });
  expect(timeout.code).toBe("chatgpt_dom_observation_timeout");
  expect(timeout.status).toBe(504);

  const missingAnswer = classifyChatGptTurnFailure({
    phase: "accepted",
    message: "ChatGPT completed without producing a final answer after its last Codex tool call",
  });
  expect(missingAnswer.code).toBe("chatgpt_completion_missing_answer");
  expect(missingAnswer.retryable).toBe(false);
});

test("send activation without confirmation is ambiguous, not a generic failure", () => {
  const ambiguous = classifyChatGptTurnFailure({
    phase: "send_activated",
    message: "The ChatGPT tab closed after Send activation",
  });
  expect(ambiguous.phase).toBe("send_activated");
  expect(ambiguous.code).toBe("chatgpt_submission_ambiguous");
  expect(ambiguous.retryable).toBe(false);
});

test("unknown pre-send failures keep their original shape", () => {
  const unknown = classifyChatGptTurnFailure({
    phase: "prepared",
    message: "ChatGPT web requires native Codex turn_id metadata for browser ownership",
  });
  expect(unknown.recognized).toBe(false);
  expect(unknown.code).toBe("chatgpt_pre_send_failed");
});

test("classified adapter errors preserve cause and phase metadata", () => {
  const cause = new Error("locator.evaluate: Timeout 2000ms exceeded.");
  const classification = classifyChatGptTurnFailure({
    phase: "accepted",
    message: cause.message,
  });
  const error = chatGptClassifiedError(classification, cause);
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  expect(error.code).toBe("chatgpt_dom_observation_timeout");
  expect(error.phase).toBe("observing");
  expect(error.retryDisposition).toBe("none");
  expect(error.status).toBe(504);
  expect(error.cause).toBe(cause);
});

test("existing adapter errors default to a coherent retry disposition", () => {
  const retryable = new ChatGptWebAdapterError("temporarily unavailable", {
    status: 503,
    errorType: "server_error",
    code: "upstream_unavailable",
    retryable: true,
  });
  expect(retryable.phase).toBe("unknown");
  expect(retryable.retryDisposition).toBe("retry_fresh_surface");

  const terminal = new ChatGptWebAdapterError("bad request", {
    status: 400,
    errorType: "invalid_request_error",
    code: "invalid_input",
    retryable: false,
  });
  expect(terminal.retryDisposition).toBe("none");
});

test("a detached compaction handoff is retried on a fresh surface, not reported as terminal", () => {
  expect(compactionFailureNeedsFreshSurface("compaction_source_unavailable")).toBe(true);
  expect(compactionFailureNeedsFreshSurface("chatgpt_response_detached")).toBe(true);
  expect(compactionFailureNeedsFreshSurface("chatgpt_response_dom_lost")).toBe(true);
  expect(compactionFailureNeedsFreshSurface("chatgpt_dom_observation_timeout")).toBe(true);
  expect(compactionFailureNeedsFreshSurface("chatgpt_assistant_turn_missing")).toBe(true);
  expect(compactionFailureNeedsFreshSurface("context_length_exceeded")).toBe(false);
  expect(compactionFailureNeedsFreshSurface(undefined)).toBe(false);
});
