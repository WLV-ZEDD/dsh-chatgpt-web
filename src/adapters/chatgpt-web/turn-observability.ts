import {
  ChatGptWebAdapterError,
  type ChatGptWebFailurePhase,
  type ChatGptWebRetryDisposition,
} from "./adapter-error";

/** Submission lifecycle recorded by the adapter runtime. */
export type ChatGptSubmissionPhase = "prepared" | "send_activated" | "accepted" | undefined;

export interface ChatGptTurnFailureInput {
  /** Submission phase captured by the adapter runtime, when one exists. */
  phase: ChatGptSubmissionPhase;
  /** Safe error message. Never pass prompt or tool content. */
  message: string;
  /** Optional error class name, used only to distinguish cancellation. */
  name?: string;
}

export interface ChatGptTurnFailureClassification {
  message: string;
  code: string;
  phase: ChatGptWebFailurePhase;
  status: number;
  errorType: string;
  retryable: boolean;
  retryDisposition: ChatGptWebRetryDisposition;
  /** False when the message is not a known browser-transport failure. */
  recognized: boolean;
}

const CONTEXT_LIMIT =
  /exceeds the .*context window|rejected the submitted messages as too long|estimated at .*input tokens.*exceeds/i;
const SESSION_CHECK_UNAVAILABLE = /session check is temporarily unavailable/i;
const SESSION_EXPIRED = /session (?:has )?expired|signed out|log in again|login state is missing/i;
const EFFORT_CONTROL_UNAVAILABLE = /effort control did not expose/i;
const MODEL_CONTROL_UNAVAILABLE = /model\/effort control did not become ready|model control.*(?:unavailable|not.*ready)/i;
const CONNECTOR_UNAVAILABLE = /did not expose the .*connector|connector.*(?:missing|not.*available|unavailable)/i;
const RATE_LIMITED = /rate limit|too many requests|\b429\b/i;
const SETUP_STAGE_TIMEOUT =
  /browser stage timed out: (?:browser_page|temporary_chat_preparation|effort_selection|prompt_attachment|file_attachment|surface_stale_recovery)/i;

const RESPONSE_DETACHED =
  /opened another user turn while the bound assistant response was detached|bound assistant response was detached|assistant (?:response|turn).*detached/i;
const RESPONSE_DOM_LOST = /response DOM disappeared/i;
const OBSERVATION_TIMEOUT =
  /DOM observation did not respond|DOM remained unresponsive|locator\.evaluate: Timeout|observation failed \d+ times in a row/i;
const COMPLETION_MISSING_ANSWER = /completed without producing a final answer/i;
const ASSISTANT_TURN_MISSING = /did not expose its assistant turn/i;
const SERIALIZATION_FAILED =
  /could not be serialized as Markdown|Markdown consistency|Cannot read properties of undefined \(reading 'textContent'\)/i;
const UPSTREAM_GENERIC = /something went wrong|upstream (?:server )?(?:error|unavailable)/i;

function failurePhase(phase: ChatGptSubmissionPhase): ChatGptWebFailurePhase {
  if (phase === "send_activated") return "send_activated";
  if (phase === "accepted") return "observing";
  return "pre_send";
}

function preSend(
  message: string,
  code: string,
  status: number,
  errorType: string,
  retryable: boolean,
): ChatGptTurnFailureClassification {
  return {
    message,
    code,
    phase: "pre_send",
    status,
    errorType,
    retryable,
    retryDisposition: retryable ? "retry_fresh_surface" : "none",
    recognized: true,
  };
}

function postSend(
  message: string,
  code: string,
  status: number,
  retryable = false,
): ChatGptTurnFailureClassification {
  return {
    message,
    code,
    phase: "observing",
    status,
    errorType: "server_error",
    retryable,
    retryDisposition: retryable ? "reattach_same_generation" : "none",
    recognized: true,
  };
}

/**
 * Classify a browser-turn failure without replaying a delivered tool call.
 *
 * Known pre-Send setup failures are retryable on a fresh surface. Failures after Send keep
 * their original generation: the caller may reattach, but must not submit the prompt again.
 */
export function classifyChatGptTurnFailure(
  input: ChatGptTurnFailureInput,
): ChatGptTurnFailureClassification {
  const message = input.message;
  const phase = failurePhase(input.phase);

  if (CONTEXT_LIMIT.test(message)) {
    return preSend(message, "context_length_exceeded", 400, "invalid_request_error", false);
  }
  if (SESSION_CHECK_UNAVAILABLE.test(message)) {
    return preSend(message, "chatgpt_session_check_unavailable", 503, "server_error", true);
  }
  if (SESSION_EXPIRED.test(message)) {
    return preSend(message, "chatgpt_session_expired", 401, "authentication_error", false);
  }
  if (EFFORT_CONTROL_UNAVAILABLE.test(message)) {
    return preSend(message, "chatgpt_effort_control_unavailable", 502, "server_error", true);
  }
  if (MODEL_CONTROL_UNAVAILABLE.test(message)) {
    return preSend(message, "chatgpt_model_control_unavailable", 502, "server_error", true);
  }
  if (CONNECTOR_UNAVAILABLE.test(message)) {
    return preSend(message, "chatgpt_connector_unavailable", 503, "server_error", true);
  }
  if (RATE_LIMITED.test(message) && phase === "pre_send") {
    return preSend(message, "rate_limit_exceeded", 429, "rate_limit_error", true);
  }
  if (SETUP_STAGE_TIMEOUT.test(message) && phase === "pre_send") {
    return preSend(message, "chatgpt_browser_setup_timeout", 504, "server_error", true);
  }

  if (RESPONSE_DETACHED.test(message)) {
    return postSend(message, "chatgpt_response_detached", 502);
  }
  if (RESPONSE_DOM_LOST.test(message)) {
    return postSend(message, "chatgpt_response_dom_lost", 502);
  }
  if (OBSERVATION_TIMEOUT.test(message)) {
    return postSend(message, "chatgpt_dom_observation_timeout", 504);
  }
  if (ASSISTANT_TURN_MISSING.test(message)) {
    return postSend(message, "chatgpt_assistant_turn_missing", 504);
  }
  if (COMPLETION_MISSING_ANSWER.test(message)) {
    return postSend(message, "chatgpt_completion_missing_answer", 502);
  }
  if (SERIALIZATION_FAILED.test(message)) {
    return postSend(message, "chatgpt_response_serialization_failed", 502);
  }
  if (RATE_LIMITED.test(message)) {
    return postSend(message, "rate_limit_exceeded", 429, false);
  }
  if (UPSTREAM_GENERIC.test(message)) {
    return postSend(message, "upstream_server_error", 502, false);
  }

  if (phase === "send_activated") {
    return {
      message,
      code: "chatgpt_submission_ambiguous",
      phase: "send_activated",
      status: 502,
      errorType: "server_error",
      retryable: false,
      retryDisposition: "none",
      recognized: true,
    };
  }
  if (phase === "pre_send") {
    return {
      message,
      code: "chatgpt_pre_send_failed",
      phase: "pre_send",
      status: 502,
      errorType: "server_error",
      retryable: false,
      retryDisposition: "none",
      recognized: false,
    };
  }
  return postSend(message, "chatgpt_submitted_turn_failed", 502);
}

/** Build an adapter error from a classification while preserving the original cause. */
export function chatGptClassifiedError(
  classification: ChatGptTurnFailureClassification,
  cause: unknown,
): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(classification.message, {
    status: classification.status,
    errorType: classification.errorType,
    code: classification.code,
    retryable: classification.retryable,
    retryDisposition: classification.retryDisposition,
    phase: classification.phase,
    cause,
  });
}

export interface ChatGptTurnEvent {
  event: string;
  traceId?: string;
  roundKey?: string;
  purpose?: "response" | "compaction";
  modelId?: string;
  phase?: ChatGptWebFailurePhase;
  code?: string;
  status?: number;
  errorType?: string;
  retryable?: boolean;
  retryDisposition?: ChatGptWebRetryDisposition;
  outcome?: "completed" | "tool_batch" | "error" | "cancelled";
  durationMs?: number;
  toolResults?: number;
  [key: string]: unknown;
}

/**
 * A structured compaction handoff that lost its retained browser surface can be retried once
 * on a fresh surface. The caller must physically retire the old owner first; this helper only
 * decides whether a fresh attempt is safe and useful.
 */
export function compactionFailureNeedsFreshSurface(code: string | undefined): boolean {
  return code === "compaction_source_unavailable"
    || code === "chatgpt_response_detached"
    || code === "chatgpt_response_dom_lost"
    || code === "chatgpt_dom_observation_timeout"
    || code === "chatgpt_assistant_turn_missing";
}

/** Machine-readable browser-turn event. Kept on one JSON line so log rotation and
 * correlation do not depend on human-formatted text.
 */
export function chatGptTurnEvent(event: ChatGptTurnEvent): void {
  console.info(`[chatgpt-web] turn_event ${JSON.stringify({
    ts: new Date().toISOString(),
    ...event,
  })}`);
}
