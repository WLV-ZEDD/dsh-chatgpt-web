/**
 * Where a browser failure happened. The phase determines whether replay is safe:
 * before Send nothing was delivered; after Send a retry must not repeat a tool call.
 */
export type ChatGptWebFailurePhase =
  | "pre_send"
  | "send_activated"
  | "observing"
  | "completing"
  | "unknown";

/** What the caller may do about a classified failure. */
export type ChatGptWebRetryDisposition =
  | "retry_fresh_surface"
  | "reattach_same_generation"
  | "none";

export interface ChatGptWebAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
  cause?: unknown;
  phase?: ChatGptWebFailurePhase;
  retryDisposition?: ChatGptWebRetryDisposition;
}

export class ChatGptWebAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly phase: ChatGptWebFailurePhase;
  readonly retryDisposition: ChatGptWebRetryDisposition;

  constructor(message: string, options: ChatGptWebAdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptWebAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
    this.phase = options.phase ?? "unknown";
    this.retryDisposition = options.retryDisposition
      ?? (options.retryable ? "retry_fresh_surface" : "none");
  }
}

export function chatGptBrowserTabClosedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

export function chatGptStoppedThinkingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT remained in 'Stopped thinking' for 5 seconds, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

export function chatGptRetainedConversationUnavailableError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT conversation is no longer available.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "compaction_source_unavailable",
      retryable: false,
    },
  );
}

/**
 * The Temporary Chat surface rehydrated the conversation mid-turn ("Loading chats" / "Loading
 * profile"), so the already-sent prompt and its in-flight generation were lost to a page reload.
 * Unlike a terminal adapter failure, this is recoverable: reloading a fresh Temporary Chat
 * document and resubmitting the same prompt starts a clean turn. The run loop treats this as a
 * bounded-retry signal rather than a user-facing error.
 */
export class ChatGptSurfaceStaleError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptSurfaceStaleError";
  }
}
