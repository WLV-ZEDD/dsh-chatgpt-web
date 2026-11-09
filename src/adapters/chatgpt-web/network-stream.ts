/**
 * Parser for ChatGPT's `/backend-api/f/conversation` SSE stream.
 *
 * The web client receives `delta_encoding: v1`, where each `delta` event is a JSON-pointer
 * patch against a running conversation document. The stream is the authoritative source for
 * answer text, reasoning, tool messages, completion, errors, and server-assigned IDs; the DOM is
 * only a rendering of it.
 *
 * This parser is deliberately transport-agnostic: feed it raw bytes from a fetch/XHR tee or
 * from a captured fixture. It does not import Playwright or any browser API.
 *
 * Protocol notes:
 * - A `delta` without `p`/`o` inherits them from the previous delta.
 * - `append` fragments are sometimes cumulative (`parts[0]` grows) and sometimes incremental;
 *   both are normalized by `appendText`.
 * - Named events (`delta_encoding`, `delta`) and data-only events (`input_message`,
 *   `resume_conversation_token`, `stream_handoff`, `message_stream_complete`) share one stream.
 * - `data: [DONE]` terminates the stream.
 */

export interface ChatGptNetworkDelta {
  /** JSON pointer path. Empty string is the document root. */
  p?: string;
  /** JSON-patch operation. */
  o?: string;
  /** Operation value. */
  v?: unknown;
  /** Compressed channel id; inherited by subsequent deltas when absent. */
  c?: number;
}

export interface ChatGptNetworkStreamMessage {
  id: string;
  role: string;
  name?: string;
  channel?: string;
  recipient?: string;
  text: string;
  status?: string;
  endTurn?: boolean | null;
  /** True when the message should not contribute to the visible answer. */
  hidden: boolean;
}

export interface ChatGptNetworkToolMessage {
  id: string;
  name?: string;
  text: string;
  status?: string;
}

export interface ChatGptNetworkStreamState {
  conversationId?: string;
  messageId?: string;
  parentId?: string;
  turnExchangeId?: string;
  text: string;
  reasoning: string;
  toolMessages: ChatGptNetworkToolMessage[];
  status: "streaming" | "complete" | "error";
  error?: { code?: string; message: string };
  handoff?: {
    conversationId?: string;
    turnExchangeId?: string;
    topicId?: string;
    resumeSseEndpoint?: string;
  };
}

export type ChatGptNetworkStreamEvent =
  | { type: "ids"; conversationId?: string; messageId?: string; parentId?: string; turnExchangeId?: string }
  | { type: "text"; messageId: string; text: string }
  | { type: "reasoning"; messageId: string; text: string }
  | { type: "tool"; message: ChatGptNetworkToolMessage }
  | { type: "handoff"; handoff: NonNullable<ChatGptNetworkStreamState["handoff"]> }
  | { type: "complete"; messageId?: string }
  | { type: "error"; code?: string; message: string };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizedText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

/** Append either a cumulative snapshot or an incremental fragment without duplicating text. */
export function appendText(existing: string, next: string): string {
  if (!next) return existing;
  if (!existing) return next;
  if (existing.endsWith(next)) return existing;
  if (next.startsWith(existing)) return next;
  return existing + next;
}

function messageFromValue(value: unknown): ChatGptNetworkStreamMessage | undefined {
  if (!isObject(value)) return undefined;
  const message = isObject(value.message) ? value.message : value;
  const id = asString(message.id);
  if (!id) return undefined;
  const author = isObject(message.author) ? message.author : undefined;
  const role = asString(author?.role) ?? "assistant";
  const content = isObject(message.content) ? message.content : undefined;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const text = parts
    .map(part => typeof part === "string" ? part : "")
    .join("");
  const metadata = isObject(message.metadata) ? message.metadata : undefined;
  const channel = asString(message.channel) ?? asString(metadata?.channel);
  const recipient = asString(message.recipient);
  const hidden = role === "system"
    || role === "user"
    || role === "tool"
    || channel === "analysis"
    || metadata?.is_visually_hidden_from_conversation === true
    || recipient === "web.run";
  return {
    id,
    role,
    ...(asString(author?.name) ? { name: asString(author?.name)! } : {}),
    ...(channel ? { channel } : {}),
    ...(recipient ? { recipient } : {}),
    text: normalizedText(text),
    ...(asString(message.status) ? { status: asString(message.status)! } : {}),
    ...(message.end_turn !== undefined ? { endTurn: asBoolean(message.end_turn) ?? null } : {}),
    hidden,
  };
}

/**
 * Stateful SSE + delta-v1 reassembler. Call `push` with decoded text chunks in arrival order.
 */
export class ChatGptNetworkStreamParser {
  private lineBuffer = "";
  private currentEvent: string | undefined;
  private dataLines: string[] = [];
  private previousDelta: { p?: string; o?: string } = {};
  private readonly messages = new Map<string, ChatGptNetworkStreamMessage>();
  private activeMessageId: string | undefined;
  private state: ChatGptNetworkStreamState = {
    text: "",
    reasoning: "",
    toolMessages: [],
    status: "streaming",
  };

  push(chunk: string): ChatGptNetworkStreamEvent[] {
    if (!chunk) return [];
    this.lineBuffer += chunk;
    return this.drainLines();
  }

  /** Flush any final unterminated line and mark the stream complete unless it errored. */
  finish(): ChatGptNetworkStreamEvent[] {
    const events: ChatGptNetworkStreamEvent[] = [];
    if (this.lineBuffer.length > 0) {
      const line = this.lineBuffer.replace(/\r$/, "");
      this.lineBuffer = "";
      if (line.length > 0) this.consumeLine(line, events);
    }
    this.dispatchEvent(events);
    if (this.state.status === "streaming") {
      this.state.status = "complete";
      events.push({ type: "complete", ...(this.state.messageId ? { messageId: this.state.messageId } : {}) });
    }
    return events;
  }

  snapshot(): ChatGptNetworkStreamState {
    return {
      ...this.state,
      ...(this.state.error ? { error: { ...this.state.error } } : {}),
      ...(this.state.handoff ? { handoff: { ...this.state.handoff } } : {}),
      toolMessages: this.state.toolMessages.map(message => ({ ...message })),
    };
  }

  private drainLines(): ChatGptNetworkStreamEvent[] {
    const events: ChatGptNetworkStreamEvent[] = [];
    for (;;) {
      const newline = this.lineBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      this.consumeLine(line, events);
    }
    return events;
  }

  private consumeLine(line: string, events: ChatGptNetworkStreamEvent[]): void {
    if (line.length === 0) {
      this.dispatchEvent(events);
      return;
    }
    if (line.startsWith(":")) return;
    if (line.startsWith("event:")) {
      this.currentEvent = line.slice("event:".length).trim();
      return;
    }
    if (line.startsWith("data:")) {
      let data = line.slice("data:".length);
      if (data.startsWith(" ")) data = data.slice(1);
      this.dataLines.push(data);
      return;
    }
    // Unknown SSE fields (`id:`, `retry:`) are irrelevant to this stream.
  }

  private dispatchEvent(events: ChatGptNetworkStreamEvent[]): void {
    const dataLines = this.dataLines;
    const eventName = this.currentEvent;
    this.dataLines = [];
    this.currentEvent = undefined;
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      this.state.status = "complete";
      events.push({ type: "complete", ...(this.state.messageId ? { messageId: this.state.messageId } : {}) });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (eventName === "delta_encoding") return;
    if (eventName === "delta" || (isObject(payload) && ("p" in payload || "o" in payload))) {
      this.applyDeltaPayload(payload, events);
      return;
    }
    this.applyDataPayload(payload, events);
  }

  private applyDeltaPayload(payload: unknown, events: ChatGptNetworkStreamEvent[]): void {
    if (Array.isArray(payload)) {
      for (const item of payload) this.applyDeltaPayload(item, events);
      return;
    }
    if (!isObject(payload)) return;
    const op = asString(payload.o) ?? this.previousDelta.o;
    const path = asString(payload.p) ?? this.previousDelta.p;
    if (op === undefined && path === undefined && !("v" in payload)) return;
    this.previousDelta = { ...(op ? { o: op } : {}), ...(path !== undefined ? { p: path } : {}) };
    this.applyOperation(op, path ?? "", payload.v, events);
  }

  private applyOperation(
    op: string | undefined,
    path: string,
    value: unknown,
    events: ChatGptNetworkStreamEvent[],
  ): void {
    if (!op || op === "add") {
      if (path === "" || path === "/message") {
        this.addMessage(value, events);
        return;
      }
      if (path === "/message/content/parts/0" || path.endsWith("/content/parts/0")) {
        this.appendToActiveMessage(value, events);
        return;
      }
      if (isObject(value) && isObject(value.message)) this.addMessage(value.message, events);
      return;
    }
    if (op === "append") {
      if (path === "" || path === "/message") {
        this.addMessage(value, events);
        return;
      }
      this.appendToActiveMessage(value, events);
      return;
    }
    if (op === "replace") {
      if (path === "" || path === "/message") {
        this.addMessage(value, events);
        return;
      }
      if (path === "/message/content/parts/0" || path.endsWith("/content/parts/0")) {
        this.replaceActiveMessage(value, events);
        return;
      }
      if (isObject(value) && isObject(value.message)) this.addMessage(value.message, events);
      return;
    }
    if (op === "patch") {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (!isObject(item)) continue;
          this.applyOperation(asString(item.o), asString(item.p) ?? "", item.v, events);
        }
      } else if (isObject(value) && isObject(value.message)) {
        this.addMessage(value.message, events);
      }
      return;
    }
    // `remove` and unknown ops do not change visible text.
  }

  private addMessage(value: unknown, events: ChatGptNetworkStreamEvent[]): void {
    const message = messageFromValue(value);
    if (!message) return;
    const existing = this.messages.get(message.id);
    this.messages.set(message.id, {
      ...existing,
      ...message,
      // A later delta may carry metadata without repeating the accumulated text.
      text: message.text || existing?.text || "",
    });
    this.activeMessageId = message.id;
    this.state.messageId = message.id;
    const parentId = isObject(value) && isObject(value.message)
      ? asString(value.message.parent_id)
      : undefined;
    if (parentId) this.state.parentId = parentId;
    const conversationId = isObject(value) ? asString(value.conversation_id) : undefined;
    if (conversationId) this.state.conversationId = conversationId;
    this.emitMessageEvent(message, events);
  }

  private appendToActiveMessage(value: unknown, events: ChatGptNetworkStreamEvent[]): void {
    const fragment = typeof value === "string" ? value : undefined;
    if (fragment === undefined) return;
    const message = this.activeMessageId ? this.messages.get(this.activeMessageId) : undefined;
    if (!message) return;
    message.text = normalizedText(appendText(message.text, fragment));
    this.emitMessageEvent(message, events);
  }

  private replaceActiveMessage(value: unknown, events: ChatGptNetworkStreamEvent[]): void {
    if (typeof value !== "string") return;
    const message = this.activeMessageId ? this.messages.get(this.activeMessageId) : undefined;
    if (!message) return;
    message.text = normalizedText(value);
    this.emitMessageEvent(message, events);
  }

  private emitMessageEvent(
    message: ChatGptNetworkStreamMessage,
    events: ChatGptNetworkStreamEvent[],
  ): void {
    if (message.hidden) {
      if (message.role === "tool") {
        const tool: ChatGptNetworkToolMessage = {
          id: message.id,
          ...(message.name ? { name: message.name } : {}),
          text: message.text,
          ...(message.status ? { status: message.status } : {}),
        };
        this.replaceTool(tool);
        events.push({ type: "tool", message: { ...tool } });
      } else if (message.role === "assistant" && message.channel === "analysis") {
        this.state.reasoning = appendText(this.state.reasoning, message.text);
        events.push({ type: "reasoning", messageId: message.id, text: message.text });
      }
      return;
    }
    this.state.text = message.text;
    events.push({ type: "text", messageId: message.id, text: message.text });
  }

  private applyDataPayload(payload: unknown, events: ChatGptNetworkStreamEvent[]): void {
    if (!isObject(payload)) return;
    const type = asString(payload.type);
    const conversationId = asString(payload.conversation_id);
    const turnExchangeId = asString(payload.turn_exchange_id);
    if (conversationId || turnExchangeId) {
      this.state = {
        ...this.state,
        ...(conversationId ? { conversationId } : {}),
        ...(turnExchangeId ? { turnExchangeId } : {}),
      };
      events.push({
        type: "ids",
        ...(conversationId ? { conversationId } : {}),
        ...(turnExchangeId ? { turnExchangeId } : {}),
      });
    }
    if (type === "input_message" || type === "message") {
      this.addMessage(payload.input_message ?? payload, events);
      return;
    }
    if (type === "resume_conversation_token") {
      return;
    }
    if (type === "stream_handoff") {
      const options = Array.isArray(payload.options) ? payload.options : [];
      const resume = options.find(option => isObject(option) && option.type === "resume_sse_endpoint");
      const subscribe = options.find(option => isObject(option) && option.type === "subscribe_ws_topic");
      const topicId = asString(payload.topic_id)
        ?? (isObject(resume) ? asString(resume.topic_id) : undefined)
        ?? (isObject(subscribe) ? asString(subscribe.topic_id) : undefined);
      const handoff = {
        ...(conversationId ? { conversationId } : {}),
        ...(turnExchangeId ? { turnExchangeId } : {}),
        ...(topicId ? { topicId } : {}),
        ...(isObject(resume) && asString(resume.topic_id) ? { resumeSseEndpoint: asString(resume.topic_id)! } : {}),
      };
      this.state.handoff = handoff;
      events.push({ type: "handoff", handoff });
      return;
    }
    if (type === "message_stream_complete" || type === "conversation_complete") {
      this.state.status = "complete";
      events.push({
        type: "complete",
        ...(asString(payload.message_id) ? { messageId: asString(payload.message_id)! } : {}),
      });
      return;
    }
    if (type === "error" || type === "moderation" || payload.error !== undefined) {
      const error = isObject(payload.error) ? payload.error : payload;
      const message = asString(error.message)
        ?? asString(payload.message)
        ?? (type === "moderation" ? "ChatGPT blocked the response" : "ChatGPT returned a stream error");
      const code = asString(error.code);
      this.state.status = "error";
      this.state.error = { ...(code ? { code } : {}), message };
      events.push({ type: "error", ...(code ? { code } : {}), message });
      return;
    }
    if (isObject(payload.message)) this.addMessage(payload.message, events);
  }

  private replaceTool(tool: ChatGptNetworkToolMessage): void {
    const index = this.state.toolMessages.findIndex(existing => existing.id === tool.id);
    if (index < 0) this.state.toolMessages.push(tool);
    else this.state.toolMessages[index] = tool;
  }
}

/** Parse an already-buffered response body. Useful for fixtures and non-streaming transports. */
export function parseChatGptNetworkStream(body: string): ChatGptNetworkStreamState {
  const parser = new ChatGptNetworkStreamParser();
  parser.push(body);
  parser.finish();
  return parser.snapshot();
}
