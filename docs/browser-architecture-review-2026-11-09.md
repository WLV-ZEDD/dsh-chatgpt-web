# Browser transport architecture review — 2026-11-09

Scope: read-only source and runtime review of how this plugin turns a DSH/ACP model
request into a ChatGPT Web browser turn. No code was changed for this review. Source
snapshot is `034f3d8` plus the current dirty tree (modified `lib/`, `src/config.ts`,
`src/server.ts`, `src/adapters/chatgpt-web/{mcp-server,prompt}.ts`, new `src/tool-gateway/`).
`bun run typecheck` passes; `bun test` reports **149 passed, 0 failed, 1,093 assertions
across 28 files**.

## 1. Bottom line

The browser layer is not a thin transport. It is a **DOM-reconstruction engine**: every
model turn creates a Temporary Chat tab, types a flattened copy of the whole conversation
into the composer, clicks Send, and then reconstructs the answer, completion state,
tool-boundary state, and error state by polling `chatgpt.com`'s DOM four times per second
per turn.

That design is the direct cause of most non-cancellation `turn_error`s. From the current
sidecar log, **65 of 88 non-abort browser failures (74%) are response observation,
assistant-identity, or DOM-health defects** — not model, account, or network failures.
Another 13 are context-limit rejections created by re-sending the whole history through a
composer. Only five are effort-picker UI failures and four are session/network checks.

The recommendation is therefore not "add more selectors". It is:

1. **Strategic:** use a native Responses transport (the same ChatGPT-subscription backend
   the official Codex CLI uses, or the newer sanctioned subscription-OAuth path) and keep
   the browser only as a fallback. This repo already contains the native passthrough; the
   DSH/ACP route is the one path still locked to the browser.
2. **If the browser must stay:** keep the composer for submission, but make the **network
   stream the source of truth** for text, completion, errors, and turn identity. The DOM
   should only handle login, connector approval, and (optionally) model selection.
3. **Immediately:** stop collapsing browser observation failures into the generic,
   non-retryable `chatgpt_submitted_turn_failed`, stop retrying a bad retained surface,
   and take browser compaction off the critical path.

## 2. What the browser layer does today

### 2.1 Call path

```
DSH / ACP / T3
  │  OpenAI Responses request (full message history, tool schemas)
  ▼
src/server.ts  /v1/responses
  ▼
src/adapters/chatgpt-web/index.ts
  │  compileChatGptWebPrompt()  -> one giant Markdown/JSON user message
  │  turn-broker token          -> maps browser tool calls back to this turn
  ▼
src/adapters/chatgpt-web/browser-worker.ts
  │  new page (Temporary Chat) -> select model/effort -> @mention connector
  │  type prompt -> click Send -> poll DOM every 250 ms
  ▼
Chrome (playwright-core)  or  Electron launcher over CDP
  ▼
chatgpt.com
  │  model calls the "ChatGPT Web Tools" connector
  ▼
bridge /mcp  -> turn-broker -> DSH native tool -> result -> browser continuation
```

Key properties:

- **Every turn is stateless at the model layer.** `compileChatGptWebPrompt()` flattens
  system items, the full transcript, tool results, images and tool inventory into the
  composer (`src/adapters/chatgpt-web/prompt.ts:456`). Continuity is re-sent, not carried
  by a conversation ID.
- **One browser process, one tab per turn.** `ChatGptBrowserWorker.pageForNewTurn()` opens
  a new page for each turn; `MAX_CHATGPT_BROWSER_TABS` defaults to 32 with resource-based
  admission (`src/adapters/chatgpt-web/concurrency.ts`, `browser-admission.ts`).
- **Submission and observation are DOM operations.** Stage timeouts are 60 s for the page,
  150 s for Temporary Chat preparation, 120 s for effort selection, 60 s for prompt
  attachment, 20 s for send (`browser-worker.ts:1250`).
- **The response is reconstructed from HTML.** `responseDomSnapshot()` reads `innerText`,
  `innerHTML`, code blocks, tables, images, canvas/SVG, KaTeX and trace blocks, then
  converts to Markdown. A 250 ms loop compares snapshots to decide completion
  (`browser-worker.ts:5368-5638`).
- **Turn identity is inferred.** Assistant/user turn keys are derived from
  `[data-testid^="conversation-turn-"]`, `[data-chatgpt-search-unit-key]` and fallback
  ordinal keys (`src/chatgpt-session.ts:38-58`). `reconcileAssistantTurnBinding()` re-derives
  the binding when a locator disappears (`browser-worker.ts:3286`).
- **Errors are inferred too.** Session expiry, subscription failure, rate limits, the
  "messages too long" alert, and the generic upstream alert are all located by visible text
  and `role="alert"` siblings (`browser-worker.ts:813-861`).
- **Tool use requires the connector.** Because ChatGPT Web has no native function calling,
  the page must call a public MCP endpoint, which reaches the turn broker, which reaches
  DSH. That is why `mcp-server.ts`, `turn-broker.ts`, the tunnel and approval handling all
  exist.

There are two browser hosts: `managed-chrome` (launch Chrome with a saved storage state)
and `launcher` (attach over CDP to an Electron host, used by Zero Risk). The live config is
`managed-chrome`, headless, one Chrome process. `chromium-bidi` is a declared dependency but
is not used anywhere in `src/`.

### 2.2 Failure envelope

Any error raised after submission that is not already a `ChatGptWebAdapterError` is wrapped:

```ts
// src/adapters/chatgpt-web/index.ts:335-365
code: ambiguous ? "chatgpt_submission_ambiguous" : "chatgpt_submitted_turn_failed"
retryable: false
```

So a locator timeout, a disappeared assistant node, a detached binding, a Markdown
consistency bug, or an unexpected `undefined.textContent` all reach DSH/ACP as the same
non-retryable `chatgpt_submitted_turn_failed`. The generic message ("ChatGPT stopped
responding…") is the symptom users see as `turn_error`.

## 3. Evidence

### 3.1 Live failure taxonomy

Source: `~/.local/state/dsh-web-stack/sidecar.log` (cumulative, no timestamps on these
lines; 62,562 lines). Counts are failure **events**, not turns, and may span older builds.

| Failure | Events | Share of all | Share of non-abort |
| --- | ---: | ---: | ---: |
| `ChatGPT web turn aborted` (client/MCP disconnect) | 85 | 49% | — |
| `opened another user turn while the bound assistant response was detached` | 39 | 23% | 44% |
| `locator.evaluate: Timeout … exceeded` (DOM probe) | 16 | 9% | 18% |
| context window / input too long | 13 | 8% | 15% |
| `response DOM disappeared while the browser turn was active` | 8 | 5% | 9% |
| effort control did not expose its menu/slider | 5 | 3% | 6% |
| session check network error | 4 | 2% | 5% |
| connector menu did not expose "ChatGPT Web Tools" | 1 | 1% | 1% |
| completed without a final answer after last tool call | 1 | 1% | 1% |
| `Cannot read properties of undefined (reading 'textContent')` | 1 | 1% | 1% |
| **Total** | **173** | 100% | 100% |

Non-abort total = 88. Response observation / identity / DOM health = 39 + 16 + 8 + 1 + 1 =
**65 (74%)**. Context-limit rejections = 13 (15%). Compaction traces account for 58 of 173
failure events (23 distinct traces). Several traces fail repeatedly with the same error
(for example `6776b939343a-compact-3` fails seven times, `1a3d02540755-compact-2` six
times), which is consistent with retrying the same bad retained surface.

Recent diagnostics are better than the cumulative log: the current
`diagnostics/browser-turns` sample has 10 traces, 9 completed, 1 failed (missing
connector). That does **not** retire the failure class; it shows the class is intermittent
and load/state-dependent.

Caveat: `ChatGPT web turn aborted` is mostly not a browser fault. It is emitted on
downstream stream cancellation / broker invocation disconnect (for example
`http_stream_cancel` followed by `invocation_disconnected`). It still surfaces as a turn
error, so it belongs in the error-taxonomy work, not the browser redesign.

### 3.2 Where the code spends its complexity

- `browser-worker.ts` is **5,682 lines**. A large share of it (selectors, snapshot
  extraction, Markdown conversion, identity rebinding, alerts, effort menu, rehydration) is
  DOM handling.
- `browser-worker.ts` has 8 tolerated internal observation faults, 2 page rebinds, 3
  surface-stale recovery attempts, and 3 connector trigger attempts. These are mitigations
  layered on a fragile observation model.
- The response loop calls `locator.evaluate` on the assistant locator every 250 ms, plus
  `stop.isVisible()` and alert probes. The heavy extraction is skipped when an in-page
  MutationObserver revision is unchanged, but the round-trip still happens four times per
  second per turn. At the measured 11 concurrent turns that is roughly 40+ CDP evaluations
  per second in one browser.
- `src/adapters/chatgpt-web/turn-execution.ts` is 943 lines, `index.ts` 1,713,
  `turn-broker.ts` 1,535, `mcp-server.ts` 1,112. A large fraction of the product exists
  only to emulate native tool calling over a chat UI.
- The test suite is extensive but mostly **synthetic fixtures** (`tests/chatgpt-dom-lifecycle.test.ts`
  builds its own HTML). It validates the heuristics, not that `chatgpt.com` still matches
  them.

### 3.3 Project-state notes

- The dirty tree adds a harness-agnostic `src/tool-gateway/` adapter and `tool_call`
  gateway. That is a good direction for other harnesses, but it does not change the
  browser observation problem.
- The repo already contains a **native Codex passthrough**
  (`src/native-passthrough.ts:9`, `src/server.ts:514`). When the requested model is not a
  `chatgpt-web/*` slug, the bridge forwards the Responses request to
  `https://chatgpt.com/backend-api/codex` with the caller's bearer token. For
  `config.purpose === "dsh"`, however, `/v1/models` only returns `chatgpt-web/*` routes
  (`src/server.ts:426`), so DSH/ACP can never take that path. This is the most important
  asymmetry in the project.
- The local `~/.codex/auth.json` on this machine is `auth_mode: "chatgpt"`, with a valid
  access/refresh token and a `plus` plan. The local Codex model cache lists
  `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna`,
  `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`. These are the same model families the
  browser route targets, available through a Responses endpoint with native tools.
- `browser-login.ts` uses `context.route` only for login mocking; there is no runtime
  network interception. `chromium-bidi` is unused.

## 4. Root causes, ranked

### R1. The DOM is the source of truth for everything after Send

Text, completion, reasoning, tool boundaries, images, error messages and turn identity all
come from a UI that OpenAI does not version, document, or keep stable. Every renderer
change becomes a plugin change. Every virtualized transcript, connector approval, or
rehydration can detach the bound node. The observed top failures are exactly this:
detached assistant (39), evaluate timeout (16), DOM disappeared (8).

### R2. Turn identity is reconstructed from text projections

DSH's structured message provenance is lost in the pi-ai → Responses projection. The
adapter compensates with prompt text, role and prefix heuristics
(`prompt.ts:270`, `environment.ts`, `browser-worker.ts:3300-3351`). The same loss makes
compaction handoff and pending tool results ambiguous. This is an integration defect, not
a model defect: a structured `sessionId/turnId/messageSource` bridge would remove most of
it.

### R3. Observation failures are reported as non-retryable request failures

`submittedTurnFailure()` genericizes them and sets `retryable: false`. DSH/ACP therefore
shows a terminal `turn_error` even when the correct action is "start a fresh surface and
retry before send" or "reattach the same generation". This turns recoverable renderer
hiccups into user-visible failures.

### R4. Whole-history resend + browser limits put compaction on the critical path

Because each turn re-sends the flattened transcript, the browser composer becomes the
context budget. The adapter enforces model-specific windows (41k instant, 90k medium/high,
128k Luna budget; `src/chatgpt-web-models.ts:36-64`, `input-tokens.ts:19`) and then runs
**compaction as another browser turn**. Compaction traces are 23 of 148 distinct failed
traces and 58 of 173 failure events. A native Responses transport would use the real model
context and native compaction, removing this class.

### R5. Busy DOM polling does not scale with the configured concurrency

The transport polls at 4 Hz per turn, on one browser process. The adaptive admission
policy measures memory/CPU and allows up to 32 turns, but the observation model is
request/response DOM evaluation. Under load this produces exactly the observed
`locator.evaluate` timeouts, rebinds, and DOM disappearance. Raising the cap made the
resource policy better; it did not make the transport event-driven.

### R6. UI-coupled setup steps remain on the critical path

Model/effort selection (5 failures), connector `@mention` discovery (1 failure), and
connector approval are all UI operations. A native Responses request carries the model and
tools in the request body; there is no picker, no mention, and no approval card.

## 5. Alternatives considered

| Option | How it works | Removes | Effort | Risk |
| --- | --- | --- | --- | --- |
| **A. Native Codex/Responses passthrough** | Bridge forwards the Responses request to `chatgpt.com/backend-api/codex/responses` with the Codex OAuth token; DSH executes native `function_call` items | Browser, DOM, connector, broker, MCP approval, composer limits, compaction-by-browser | Medium (auth + route + tool loop already largely present) | Endpoint is undocumented/grey-area; ChatGPT-plan rate limits; OpenAI may restrict third-party callers |
| **B. Sanctioned subscription OAuth** | Official subscription OAuth (dynamic agent client) → `api.openai.com/v1/responses`, `store:false`, `stream:true` | Same as A, with a public endpoint | Medium | Preview, limited feature set, requires OAuth registration/consent; per-plan quota |
| **C. Network-native hybrid (keep the browser)** | Page still submits; a `window.fetch` tee (or CDP `Fetch`) captures `/backend-api/f/conversation` SSE; text/completion/errors/IDs come from the stream; DOM only for approval | Detached assistant, DOM disappeared, completion heuristics, Markdown extraction, most evaluate timeouts | Medium | Private SSE schema can change; Pro `stream_handoff`/WS needs a second leg; keep DOM fallback |
| **D. Token-oracle direct conversation POST** | Harvest sentinel/auth headers from the page (pause and abort its request), then POST the conversation inside the page | Composer, model picker, effort picker, prompt typing; DOM only for login | Medium-high | Connector selection/approval semantics not established; PoW/sentinel rotates; highest ToS exposure |
| **E. Hardened DOM automation** | `patchright-core`/Camoufox, MutationObserver instead of polling, selector self-heal, process isolation | Some detection/polling failures | Low-medium | Does not remove the DOM-as-truth class; the observed failures are not Cloudflare blocks |
| **F. Change the provider / demote Web** | Use an API/local model for tool turns; expose ChatGPT Web as a `consult`-style tool for pure chat | All browser failures on the agent path | Low | No longer a drop-in free provider; cost/quality tradeoff |

### A. Native Codex/Responses passthrough (recommended strategically)

The bridge already supports it for non-DSH clients:

```ts
// src/server.ts:514
if (typeof requestedModel === "string" && !isChatGptWebModelSlug(requestedModel)) {
  return await forwardNativeCodexRequest(nativeRequest, "responses", undefined, raw);
}
```

`forwardNativeCodexRequest()` (`src/native-passthrough.ts`) forwards the Responses request
and SSE response to `https://chatgpt.com/backend-api/codex`, preserving
`Authorization` and `ChatGPT-Account-ID`. The local Codex auth file already provides a
ChatGPT Plus token. Native Responses means:

- native `function_call` / `function_call_output` items — no connector, no turn broker,
  no MCP approval card;
- server-assigned response/item IDs — no DOM identity heuristics;
- real streaming events (`response.output_text.delta`, `response.completed`) — no 250 ms
  polling;
- real context windows and native compaction — no browser composer budget;
- one request per turn — no "Temporary Chat rehydrated" surface.

The missing pieces for DSH are: (1) a DSH credential mode that reads/refreshes
`~/.codex/auth.json` (or performs OAuth) and attaches it to native model requests;
(2) exposing native model slugs to DSH instead of only `chatgpt-web/*`; (3) deciding
whether DSH's existing tool runtime can consume native `function_call` items directly
(it already speaks Codex Responses, so this is likely small).

Caveats to state plainly: this is the Codex CLI's endpoint, not a documented public API.
OpenAI's newer subscription-OAuth preview explicitly directs third-party agents to the
public Responses endpoint and prohibits the private `backend-api` path. Treat A as a
personal/local interoperability mode with the user's own token, not a hosted service, and
prefer B where eligible.

### B. Sanctioned subscription OAuth

In 2026 OpenAI previewed "bring your own subscription" OAuth for third-party agents:
dynamic client registration (`dynamic_agent_client`), loopback callback, and inference via
the public `api.openai.com/v1/responses` with `store:false` and `stream:true`. This is the
sanctioned version of A and keeps the same architectural win (no browser). It has
preview limitations (no hosted MCP connectors, no background, no `max_output_tokens`,
etc.), but local tool execution is exactly what we need. Evaluate eligibility before
building; if it works, it is the best long-term path.

### C. Network-native hybrid (recommended if the browser stays)

Keep the current submission path (attach prompt, click Send, handle connector approval).
Add an `evaluateOnNewDocument` hook that wraps `window.fetch` and `ReadableStream.tee()`s
`POST /backend-api/f/conversation` and `/backend-api/conversation`; forward parsed events
to Node via `page.exposeBinding`. Then:

- reconstruct the answer from `delta_encoding v1` (`add`/`append`/`replace`/`remove`/`patch`
  JSON-pointer ops), not from `innerHTML`;
- use `conversation_id`, `message_id`, `parent_id`, `turn_exchange_id` as the canonical
  turn identity;
- treat `message_stream_complete` / `[DONE]` / `error` events as terminal, including the
  "too long" and upstream errors that currently require alert scraping;
- handle Pro `stream_handoff` by polling `GET /backend-api/conversation/{id}` or the
  WS/resume topic;
- keep the DOM observer only as a fallback, for connector approval, and for login.

This is a surgical, reversible change. It eliminates the three largest failure classes
without changing the account, connector, or billing model. It also gives the adapter real
streaming deltas instead of 250 ms snapshots.

Implementation notes:

- Install the hook before the app boots (`context.addInitScript`), not after navigation.
- Prefer the `ReadableStream.tee()` approach over CDP `Network.getResponseBody`; CDP
  network events do not preserve SSE framing and `getResponseBody` blocks until the stream
  closes.
- Keep the parser tolerant: ChatGPT sends cumulative `parts[0]` in some frames and JSON
  pointer ops in others; dedupe by prefix and by message ID.
- Keep a DOM fallback behind a flag so a protocol change degrades instead of breaking.

### D. Token-oracle direct conversation POST

Existing community implementations (`@minzicat/pi-chatgpt-web-adapter`, `rosetta`,
`chat2api`, `chrome-ai-bridge`) harvest the sentinel/auth headers by letting the real page
mint them (pause the SPA's `POST /f/conversation`, snapshot headers, abort) and then POST
inside the page context. This removes the composer and picker entirely. It is attractive
for pure chat, but for this plugin it creates an unresolved problem: the ChatGPT connector
(and its approval) is part of the tool loop. Without evidence that a direct POST can
select the connector and receive connector tool calls, D is a research spike, not the
next step. It also has the highest ToS exposure and the highest protocol-maintenance cost.

### E. Hardened DOM automation

Useful as a complement, not a cure:

- `patchright-core` is a near drop-in for `playwright-core` and removes common CDP
  automation signals; Camoufox is the stronger Firefox option but slower and less mature.
- Replace 250 ms `locator.evaluate` polling with a `MutationObserver` + bindings so the
  page pushes changes.
- Use one browser context per concurrency lane / process isolation instead of many tabs in
  one browser.
- Add selector self-heal (`check` against the live page) and record selector misses as
  first-class metrics.

The current failures are **not** predominantly anti-bot blocks (no Cloudflare challenge in
the taxonomy), so stealth tooling alone will not move the number much. The DOM-as-truth
design will still fail.

### F. Change the provider / demote ChatGPT Web

If the goal is reliable agentic work, the honest answer is that a chat UI is the wrong
transport for a tool-calling harness. AITerm's own write-up reaches the same conclusion:
tool calling is simulated, fidelity is lower than native, context is capped by the plan,
and the maintenance burden never ends. Two product shapes are defensible:

- **Native model for agent turns**, ChatGPT Web for pure-chat/consult calls. Offer a
  `consult`-style tool (rosetta-mcp's model) rather than making Web the primary agent.
- **Explicit reliability tiers:** `chatgpt-web/*` (cheap, browser, best-effort, pure chat)
  vs `native/*` (subscription, Responses, tools, reliable). Let the user choose per task.

This aligns the product with what each transport can actually do.

## 6. Recommended plan

### Phase 0 — stop making recoverable failures look terminal (days)

1. Add structured, timestamped lifecycle events with `traceId`, stage, phase, surface ID,
   turn/message IDs from the network, and terminal outcome. Current sidecar browser lines
   have no timestamps, which makes incidence and regression analysis unreliable.
2. Split the error envelope:
   - pre-send DOM/setup failure → retryable with a **fresh surface**, never replays a tool;
   - post-send renderer failure → preserve the generation and reattach, or report
     `chatgpt_submitted_turn_failed` only after a bounded, evidence-backed reattach;
   - user/MCP cancel → cancellation, not an error;
   - context limit → `context_length_exceeded` (already done for the alert; extend to the
     preflight and native stream).
3. Do not retry a retained conversation after a detached-binding failure; open a fresh
   surface. The repeated `compact-*` failures show the current retry loop is counterproductive.
4. Take browser compaction off the critical path: use the existing text compaction, a
   separate request, or (best) the native route. A compaction failure must not fail the
   user turn.
5. Add a health metric for "turns that needed a DOM identity rebind" so the architectural
   cost is visible.

### Phase 1 — native-first route behind a flag (1–2 weeks)

1. Add a credential provider that reads and refreshes Codex OAuth (or performs the
   sanctioned dynamic-client OAuth), with no secrets in logs.
2. Expose native model routes to DSH when a credential is available; keep
   `chatgpt-web/*` as the fallback.
3. Wire DSH's Responses tool loop to native `function_call` items. Verify a real
   tool round trip and multi-turn compaction.
4. Measure on the same workloads: success rate, p50/p95 latency, context errors, tool
   round-trip success, and browser fallback rate.

### Phase 2 — network-native fallback (if browser remains)

1. Add the fetch/XHR tee and delta parser with captured-frame fixtures.
2. Use stream IDs as canonical turn identity; retire the prompt-text/ordinal heuristics.
3. Keep DOM for login, connector approval, and as a flag-gated fallback.
4. Delete the 250 ms snapshot loop and the rebind machinery once the stream path is
   proven.

### Phase 3 — simplify

Once native is primary and network observation is the browser fallback, the connector
broker is only needed for the browser path. Keep it there; do not carry its complexity
into native turns. The `tool-gateway` can remain the harness-agnostic browser tool bridge.

### Acceptance criteria

- Zero user-visible `turn_error`s caused by assistant binding, DOM disappearance, or
  completion detection.
- Context-limit errors only from real model limits, not composer budgets.
- A 10-client queued workload completes with no observation faults and no more than one
  retry per turn.
- Every failure has a code, a phase, a trace, a timestamp, and a documented retry policy.
- The browser fallback remains opt-in and does not regress pure-chat.

## 7. What not to do

- Do not add more selectors or widen timeouts. Both treat symptoms; the 39 detached-binding
  and 16 evaluate-timeout events are structural.
- Do not raise the concurrency ceiling to compensate for slow DOM observation. It increases
  renderer contention and rebinds.
- Do not replay a turn after Send unless the stream proves the model did not accept it.
- Do not present subscription-quota usage as "zero cost"; it is zero marginal API spend,
  not unlimited.
- Do not assume headless is the root cause. The taxonomy is post-submission observation,
  not bot detection.

## 8. Open questions

1. Is this account eligible for the sanctioned subscription-OAuth third-party agent flow?
2. Can a native Responses request select/auto-approve the ChatGPT connector, or is the
   connector only a Web-UI feature? (Determines whether the browser path can ever be fully
   retired for tool turns.)
3. Does DSH's pi-ai transport preserve native `function_call` items end to end, or does it
   need a small adapter? The bridge already speaks Codex Responses, so this is likely a
   configuration + credential problem, not a protocol rewrite.
4. What is the real per-turn failure **rate** (denominator)? The current log has no
   timestamps and the diagnostic sample is small (10 traces). Add per-turn structured
   outcomes before quoting reliability numbers.
5. Is `browserHost: launcher` still required? If only Zero Risk uses it, keep it as a
   deliberate manual mode and do not let it shape the automatic path.

## Appendix — key files

| Concern | File |
| --- | --- |
| Turn orchestration, retries, error envelope | `src/adapters/chatgpt-web/index.ts` |
| DOM submission/observation, selectors, staging | `src/adapters/chatgpt-web/browser-worker.ts` |
| Turn identity, effort menu, selectors | `src/chatgpt-session.ts` |
| Prompt flattening, tool inventory injection | `src/adapters/chatgpt-web/prompt.ts` |
| Browser context limits, model routes | `src/chatgpt-web-models.ts`, `src/adapters/chatgpt-web/input-tokens.ts` |
| Connector MCP surface | `src/adapters/chatgpt-web/mcp-server.ts` |
| Session broker / tool delivery | `src/adapters/chatgpt-web/turn-broker.ts` |
| Native Codex passthrough | `src/native-passthrough.ts`, `src/server.ts` |
| Concurrency / capacity | `src/adapters/chatgpt-web/{concurrency,browser-admission,browser-capacity,browser-resources}.ts` |
| Diagnostics | `src/adapters/chatgpt-web/browser-worker.ts` (diagnostics class), `scripts/analyze-browser-diagnostics.mjs` |

## Appendix — external references consulted

- AITerm, "ChatGPT's Web App Has No API? So We Built a Bridge Inside the Browser"
  (in-page fetch, sentinel PoW, stateless history, simulated tool calls).
- `@minzicat/pi-chatgpt-web-adapter` architecture (CDP sentinel token-oracle, in-page
  `/f/conversation`, delta v1 reassembler, Pro `stream_handoff`).
- `rosetta` (CDP `Fetch` request rewrite, SSE/WS second leg, per-tab concurrency).
- `chrome-ai-bridge` (network-native stream extraction; DOM fallback).
- `chatgpt-mcp` (patchright, persistent profile, selector self-heal, single-threaded mutex).
- OpenAI Codex docs and community write-ups on `chatgpt.com/backend-api/codex/responses`
  and the newer subscription-OAuth public Responses preview.
- Patchright / Camoufox comparisons (driver-level vs engine-level stealth).
