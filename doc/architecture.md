
# dsh-chatgpt-web Architecture

**Status:** Definitive target architecture  
**Document role:** Architectural reference and implementation boundary  
**Repository:** lordraiden/dsh-chatgpt-web  
**Last updated:** 2026-10-02

## 1. Purpose

dsh-chatgpt-web exists to make an authenticated ChatGPT Web session behave, from the perspective of DeepSeek Harness (DSH), as closely as possible to a normal model provider consumed through an API.

The target is **not** to pretend that ChatGPT Web is an official API, nor to reproduce OpenAI's internal product architecture. The target is a clean abstraction boundary:

> DSH should interact with ChatGPT Web Luna as a first-class model provider, while browser automation, ChatGPT Web turn mechanics, and compatibility workarounds remain implementation details inside this plugin.

This distinction is fundamental.

The plugin must provide API-like **semantics** at the DSH boundary even when the underlying transport is a browser and therefore cannot provide API-like **mechanics** internally.

The architecture therefore optimizes for these properties, in this order:

1. Native DSH provider semantics.
2. Correct ownership of execution authority and security.
3. One source of truth for DSH capabilities.
4. One canonical context/replay model.
5. Strong isolation of ChatGPT Web surface fragility.
6. Reuse of one execution core across all supported entrypoints.
7. Observability and deterministic failure behavior.
8. Minimal compatibility machinery outside the canonical path.

The result should feel like:

~~~text
DSH agent/runtime
    |
    v
ctx.llm
    |
    v
ChatGPT Web provider
    |
    v
provider execution core
    |
    +--> DSH capability projection
    +--> turn coordination
    +--> context/replay/compaction
    +--> browser/session lifecycle
    |
    v
ChatGPT Web surface transport
    |
    v
chatgpt.com
~~~

and not like:

~~~text
DSH
    |
    v
llm-pi-ai
    |
    v
OpenAI-compatible localhost API
    |
    v
plugin
    |
    v
browser automation
~~~

The second architecture may remain as a compatibility path, but it must not define the plugin's identity.

---

## 2. Design goal: "as close to an API model as possible"

The phrase "as close as possible to an API model" has a precise meaning in this architecture.

For a DSH caller, a model invocation should look conceptually like:

~~~text
generate(
    provider,
    model,
    messages,
    tools,
    reasoningEffort,
    sessionId,
    signal
)
        |
        v
stream(
    text,
    reasoning,
    usage,
    finish/error
)
~~~

The caller should not need to know:

- that a browser is involved;
- which DOM framework ChatGPT currently uses;
- which selectors locate the composer;
- whether the ChatGPT UI labels the reasoning control "Think";
- whether ChatGPT internally performs a tool loop;
- how an MCP capability is transported to the browser;
- how a turn token is bound;
- how rolling checkpoints are stored;
- how a compatibility HTTP request is translated.

Those are provider implementation details.

This does **not** mean that every ChatGPT Web behavior can be made identical to a direct API provider. Some properties are inherently different:

- ChatGPT Web is a product UI, not a provider protocol.
- The browser surface is mutable and can change without notice.
- The authenticated account determines capabilities.
- The web composer has practical input limits that may be lower than a model's theoretical context window.
- Some tool calls are executed by the ChatGPT-side loop through MCP rather than by the DSH agent loop.
- Usage accounting can be best-effort rather than authoritative.
- Browser recovery and rehydration are provider-specific concerns.

The correct abstraction therefore hides the **mechanism**, not the **observable semantics**.

---

## 3. Architectural invariants

The following invariants are mandatory.

### 3.1 DSH owns runtime authority

DSH remains authoritative for:

- agent identity;
- session identity;
- workspace identity;
- sandbox policy;
- tool authorization;
- approvals;
- guards;
- tool execution;
- skill policy;
- lifecycle;
- telemetry/presentation;
- cancellation ownership;
- provider selection.

ChatGPT never becomes the authority for these properties.

The model may request an operation. It cannot grant itself authority to perform the operation.

### 3.2 ChatGPT owns model reasoning

ChatGPT Web remains the model execution surface.

The plugin must not attempt to reconstruct the model itself or create a second "model runtime" around it.

ChatGPT decides:

- what to say;
- what reasoning to perform;
- whether to request a capability;
- which capability to request;
- how to continue after a capability result.

DSH decides:

- whether the requested capability exists;
- whether the request is allowed;
- what scope applies;
- what approval policy applies;
- what sandbox applies;
- whether the result may be returned.

### 3.3 One authoritative DSH capability registry

There must not be a second authoritative tool system inside dsh-chatgpt-web.

The canonical relationship is:

~~~text
DSH ctx.tools
    |
    +--> schemas
    +--> scope/policy
    +--> approvals/guards
    +--> execute
    +--> result handling
    +--> telemetry
    |
    v
ChatGPT capability projection
    |
    v
MCP / browser transport
~~~

Any plugin-specific representation exists only because ChatGPT Web requires a transport representation.

### 3.4 Skills remain DSH-owned

Skills are distinct from tools.

The plugin must not create a second skill registry.

The preferred relationship is:

~~~text
DSH ctx.skills
    |
    v
native DSH skill projection / skill tool
    |
    v
ctx.tools capability plane
    |
    v
ChatGPT Web
~~~

The provider adapter should not become a bespoke skill engine.

The model-facing path must preserve:

- model-invocable policy;
- user-invocable policy;
- lazy loading;
- skill lifecycle;
- distinction between reusable instructions/knowledge and executable tools.

### 3.5 The broker coordinates; it does not own capability semantics

The turn broker is not inherently architectural debt.

It solves a real problem:

~~~text
ChatGPT/Web process
        |
        | asynchronous tool requests
        v
turn-bound coordination
        |
        v
DSH/runtime process
~~~

A browser turn can outlive the request that initiated it, and MCP calls can arrive through another process.

The broker therefore owns:

- cross-process coordination;
- turn binding;
- leases/expiration;
- correlation;
- cancellation propagation;
- late-call rejection;
- channel lifetime;
- settlement/cleanup.

It must not own:

- the canonical tool registry;
- authorization policy;
- sandbox policy;
- approval semantics;
- agent ownership;
- skill policy.

In short:

> DSH owns capability semantics. The broker owns transport-time turn coordination.

### 3.6 The browser is a transport

The ChatGPT Web browser implementation is the final transport layer.

It must be treated similarly to a provider's HTTP transport:

~~~text
provider abstraction
    |
    v
ChatGPT Web execution core
    |
    v
browser/surface transport
~~~

The browser layer should not define DSH provider semantics.

### 3.7 One canonical execution core

The native DSH provider, compatibility HTTP endpoint, and any supported native Codex compatibility path must converge on one ChatGPT Web execution core.

The architecture must not grow three different browser-turn implementations.

---

## 4. Current implementation and why it needs re-architecture

The current repository already contains substantial functionality:

- ChatGPT Web model routing;
- browser automation;
- reasoning selection;
- streaming;
- model capability detection;
- turn identity;
- per-turn environment validation;
- MCP exposure;
- turn broker coordination;
- structured tool calls;
- cancellation;
- compaction support;
- rolling checkpoints;
- usage estimation;
- native Codex passthrough;
- an OpenAI Responses-compatible HTTP server.

However, the DSH-facing provider identity is currently indirect.

The current conceptual path is:

~~~text
DSH
  -> llm-pi-ai
  -> localhost Responses-compatible HTTP
  -> dsh-chatgpt-web server
  -> ProviderAdapter / ChatGPT Web adapter
  -> browser worker
  -> chatgpt.com
~~~

The plugin's Cordis entrypoint currently focuses on lifecycle management and starts the sidecar. Its public DSH-facing plugin shape is not yet a first-class ctx.llm provider.

The repository's current ChatGPT adapter is implemented around a plugin-local ProviderAdapter abstraction. That abstraction is useful inside the plugin, but it is not yet the same boundary as DSH's LlmAdapter.

This creates several architectural consequences:

1. The DSH model catalogue depends on compatibility configuration rather than native provider registration.
2. Provider metadata is partly outside ctx.llm.
3. Provider errors and streaming have an additional translation boundary.
4. The localhost HTTP server becomes part of the canonical architecture instead of merely being compatibility.
5. Tool and skill semantics have to cross additional transport abstractions.
6. Context is reconstructed for the web boundary rather than remaining a native DSH structure until the last responsible moment.

The re-architecture must preserve the mature browser and turn machinery while moving the DSH provider boundary inward.

---

## 5. Target architecture

The target architecture has five major planes.

~~~text
                           DeepSeek Harness
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  Agent Loop                                                     │
│       |                                                         │
│       v                                                         │
│    ctx.llm  <-----------------------------------------------+   │
│       |                                                       |  │
│       v                                                       |  │
│  ChatGptWebLlmAdapter                                        |  │
│       |                                                       |  │
│       v                                                       |  │
│  ChatGPTWebProviderCore                                      |  │
│       |                                                       |  │
│       +----------------------+----------------------+         |  │
│       |                      |                      |         |  │
│       v                      v                      v         |  │
│  Context/Replay        Capability Plane       Turn/Session    |  │
│  Projection            ctx.tools/skills       Coordinator     |  │
│       |                      |                      |         |  │
└───────|──────────────────────|──────────────────────|─────────┘
        |                      |                      |
        |                      v                      v
        |               MCP / capability        Broker / IPC
        |                 projection                 |
        |                      |                      |
        +----------------------+----------------------+
                               |
                               v
                     ChatGPT Web Transport
                      Playwright / browser
                               |
                               v
                           chatgpt.com
~~~

In parallel, compatibility entrypoints converge into the same core:

~~~text
Legacy DSH / external client
        |
        v
OpenAI Responses compatibility server
        |
        +--------------------+
                             |
Native Codex compatibility  |
        |                    |
        v                    v
   compatibility adapters
            |
            v
    ChatGPTWebProviderCore
~~~

The core distinction is that **provider semantics and execution behavior are centralized**.

---

## 6. Layer 1: DSH runtime

DSH remains the outer runtime.

Relevant native concepts include:

- ctx.llm;
- ctx.tools;
- ctx.skills;
- agent/session identity;
- sandbox/workspace state;
- approval/guard mechanisms;
- session replay;
- event lifecycle.

The plugin should integrate with these existing DSH abstractions rather than invent equivalents.

### 6.1 Native LLM registration

The target provider should use DSH's standard LlmAdapter mechanism:

~~~text
Cordis plugin
    |
    +--> inject ["llm"]
    |
    v
ctx.llm.registerAdapter(["chatgpt-web"], adapter)
~~~

The adapter should implement the provider-neutral DSH contract, including:

- providerInfo;
- listModels;
- resolveModel;
- prepareCall where needed;
- stream;
- provider retry policy;
- model capability metadata;
- reasoning metadata;
- cancellation;
- replayState when provider-private continuity data is required.

The exact implementation must follow the LlmAdapter contract of the target DSH version rather than introducing another generic abstraction.

DSH's current adapter contract already provides:

- provider registration;
- model discovery;
- model resolution;
- model context capacity;
- input modalities;
- reasoning effort metadata;
- tool schemas;
- tool history;
- AbortSignal propagation;
- StreamChunk output;
- replayState.

The provider must map ChatGPT Web behavior onto that vocabulary.

### 6.2 Provider/model identity

Inside DSH, the canonical concepts should be separated:

~~~text
provider = chatgpt-web
model    = luna
~~~

A composite user-facing display name such as chatgpt-web/luna can remain as a presentation convention or compatibility alias.

The adapter must not require users to duplicate the model definitions in llm-pi-ai for the canonical path.

---

## 7. Layer 2: ChatGptWebLlmAdapter

The native adapter is deliberately thin.

Its responsibility is to translate between DSH's provider-neutral LLM contract and the ChatGPT Web provider core.

It should own:

- provider registration;
- model resolution;
- provider/model capability metadata;
- reasoning effort mapping;
- multimodal capability declarations;
- provider-neutral error translation;
- stream translation;
- cancellation propagation;
- provider retry policy.

It must not own:

- DOM selectors;
- browser readiness heuristics;
- MCP protocol details;
- turn broker internals;
- skill registration;
- DSH sandbox authorization;
- compatibility HTTP semantics.

The adapter should therefore look conceptually like:

~~~text
DSH GenerateOptions
       |
       v
ChatGptWebLlmAdapter
       |
       +--> resolve model/capabilities
       +--> prepare provider call
       +--> delegate to ProviderCore
       +--> map provider events to StreamChunk
       |
       v
DSH StreamChunk
~~~

This layer should be small enough that it can be reasoned about independently from Playwright.

---

## 8. Layer 3: ChatGPTWebProviderCore

This is the central architectural component.

The ProviderCore is the shared implementation behind every supported ChatGPT Web entrypoint.

It owns the semantics that are currently spread across the plugin's browser adapter, prompt compiler, turn execution, broker integration, replay/compaction helpers, and HTTP compatibility path.

It is responsible for:

- model route resolution;
- account capability gating;
- logical turn creation;
- turn identity;
- execution namespace;
- context projection;
- replay state;
- compaction/checkpoint coordination;
- capability snapshot binding;
- browser/session delegation;
- cancellation;
- retry policy;
- provider diagnostics;
- usage estimation/normalization;
- execution provenance;
- settlement and cleanup.

It must not become a giant monolith.

The ProviderCore is a coordination boundary, not a place to dump every implementation detail.

Its major internal components should remain independently testable:

~~~text
ChatGPTWebProviderCore
├── ModelResolver
├── CapabilityProjector
├── ContextProjector
├── TurnCoordinator
├── Replay / Checkpoint Store
├── BrowserSession Manager
├── WebSurfaceTransport
├── Result / Stream Translator
├── Usage Meter
├── Error Classifier
└── Diagnostics / Provenance
~~~

The exact class/module decomposition may differ, but the responsibilities must remain separable.

---

## 9. Dual-loop model: the critical behavioral decision

A major architectural constraint is that there are two possible owners of the model/tool loop.

### 9.1 DSH-owned loop

The conventional API-provider pattern is:

~~~text
DSH Agent Loop
    |
    v
LlmAdapter
    |
    v
model
    |
    v
tool call
    |
    v
DSH tool runtime
    |
    v
tool result
    |
    v
model continuation
~~~

This is the ideal contract for an ordinary API that exposes structured tool calls.

### 9.2 ChatGPT Web-owned loop

The current browser-based Luna path behaves differently:

~~~text
DSH
    |
    v
ChatGptWebLlmAdapter
    |
    v
ChatGPT Web turn
    |
    v
ChatGPT decides to use capability
    |
    v
MCP
    |
    v
turn broker
    |
    v
DSH capability runtime
    |
    v
result
    |
    v
ChatGPT continuation
    |
    v
final response
~~~

Here, the model-side loop is executed inside the ChatGPT Web session.

This is not a defect to be hidden. It is an important implementation property.

### 9.3 Target policy

The canonical Luna Free architecture should **encapsulate** the ChatGPT-owned loop inside the provider.

From DSH's perspective, the invocation remains one logical model call.

Internal tool activity should be represented as provider trace/provenance, not automatically surfaced as DSH AgentLoop tool calls unless the target runtime is explicitly operating in a mode where DSH owns the tool loop.

This prevents a false abstraction in which DSH believes it owns tool execution when the actual owner is ChatGPT Web.

### 9.4 Why forcing one loop would be wrong

Trying to force Luna Free to imitate a conventional structured API by extracting every browser-side tool request and feeding it into DSH's normal agent loop would introduce:

- redundant turn orchestration;
- duplicated continuation logic;
- additional latency;
- more replay state;
- more serialization;
- more opportunities for mismatched authority;
- a larger compatibility surface.

The correct strategy is to expose a stable API-like provider contract and hide the browser-side loop internally.

---

## 10. Layer 4: Capability Plane

The capability plane connects DSH-owned tools and skills to the ChatGPT session.

### 10.1 Tools

The canonical source of truth is DSH ctx.tools.

The provider must derive the current model-visible capabilities from the exact DSH agent/turn scope.

The projection may include:

- regular function tools;
- namespaced tools;
- freeform tools;
- deferred/tool-search forms;
- image viewing;
- patch operations;
- long-running execution/session controls.

Transport-specific flattening is acceptable where ChatGPT requires a different representation.

For example:

~~~text
DSH semantic identity
    namespace + name
        |
        v
wire representation
    namespace__name
        |
        v
ChatGPT
~~~

But the wire name is a projection, not a new authority.

### 10.2 Execution

A model request must eventually return to DSH's tool runtime.

The plugin may translate:

~~~text
ChatGPT MCP request
      |
      v
capability binding
      |
      v
DSH ctx.tools.execute(...)
~~~

The DSH executor remains responsible for:

- argument validation;
- approval;
- guards;
- sandbox;
- scope;
- agent ownership;
- cancellation;
- structured results;
- telemetry.

The MCP layer cannot override any of these.

### 10.3 Broker

The broker binds capability requests to the correct turn.

A binding must encode sufficient trusted state to prevent:

- stale tool calls being executed against a newer turn;
- one browser session borrowing another agent's capability;
- expired turns retaining authority;
- model-provided metadata widening permissions.

The broker may hold:

- binding identifiers;
- activity identifiers;
- channel/socket information;
- expiration;
- turn identity;
- references to the trusted environment.

The broker must not become the source of truth for capability policy.

---

## 11. Skills

Skills are reusable instructions/knowledge, not executable operations.

The architecture deliberately avoids implementing a plugin-specific skill subsystem.

The preferred path is:

~~~text
DSH ctx.skills
    |
    +--> catalog
    +--> model-invocable policy
    +--> lazy loader
    |
    v
native DSH skill projection / skill tool
    |
    v
ctx.tools capability plane
    |
    v
MCP / ChatGPT
~~~

### 11.1 Why skills should not be hard-wired into the LLM adapter

DSH's LLM request contract exposes tools, but skills are a separate runtime subsystem.

Making ChatGptWebLlmAdapter directly manage ctx.skills would create coupling between:

- model provider concerns;
- agent preparation;
- skill policy;
- skill lifecycle.

That is unnecessary if DSH already supplies a native model-facing skill projection.

### 11.2 Required behavior

The model-facing skill projection must:

- use the canonical DSH registry;
- expose only permitted skills;
- preserve model-invocable policy;
- load detailed skill content lazily;
- preserve skill scope;
- reject hidden/non-invocable skills;
- keep skill instructions semantically distinct from executable tools.

The plugin should transport this projection without becoming its owner.

---

## 12. Layer 5: Turn Coordinator

The TurnCoordinator is responsible for one logical ChatGPT Web turn.

It must reconcile:

- DSH call identity;
- ChatGPT conversation identity;
- turn identity;
- browser execution;
- capability binding;
- cancellation;
- replay;
- completion;
- cleanup.

A turn must have a stable internal identity that is never derived from model-visible text.

### 12.1 Required turn state

Conceptually:

~~~text
Turn
├── provider/model
├── DSH session identity
├── DSH agent identity
├── thread identity
├── turn identity
├── capability scope
├── environment snapshot
├── browser session
├── context revision
├── tool binding
├── cancellation
├── stream state
├── replay/checkpoint state
└── settlement/cleanup state
~~~

### 12.2 Completion

Completion detection must be based on transport state and authoritative browser/session signals rather than text such as:

- "done";
- "finished";
- "Stopped thinking";
- "I will now...".

Visible text is data, not a control protocol.

### 12.3 Late calls

The coordinator must reject late calls after:

- turn retirement;
- capability revocation;
- session cancellation;
- browser settlement;
- timeout;
- provider shutdown.

This is part of correctness, not merely cleanup.

---

## 13. Layer 6: Context and replay

The internal canonical representation is DSH's structured context.

The plugin must avoid repeatedly converting:

~~~text
DSH structures
  -> ad-hoc JSON
  -> custom object
  -> prompt text
  -> protocol text
  -> browser composer
~~~

Instead:

~~~text
DSH structured request
       |
       v
one canonical ChatGPT Web projection
       |
       v
browser composer
~~~

### 13.1 One canonical projection

The ChatGPT projection may still contain explicit transport framing because the browser composer only accepts model-visible content.

That is acceptable.

The target invariant is:

> Final textual serialization is unavoidable; repeated semantic serialization is not.

### 13.2 Roles and instruction priority

The projection must preserve:

- system;
- developer;
- user;
- assistant;
- tool result;
- agent-message semantics where supported;
- reasoning state where replay requires it.

The transport framing must make it explicit to the model which content constitutes conversation data and which content constitutes transport instructions.

However, model-visible text must never become the source of truth for trusted execution metadata.

### 13.3 Trusted metadata

The following must remain out-of-band whenever technically possible:

- turn identity;
- thread identity;
- agent identity;
- workspace roots;
- sandbox policy;
- capability authorization;
- approval state;
- broker binding;
- cancellation authority.

If a workaround requires part of that state to be represented in model-visible content, that copy is advisory and reconstructible only from trusted local state.

### 13.4 Retired handles

Historical context can contain old identifiers.

The projection must remove or neutralize stale:

- turn handles;
- request handles;
- binding identifiers;
- superseded control contracts.

A model copying a retired handle must never accidentally revive its authority.

### 13.5 Images

Images must remain structured content as long as possible.

The adapter must avoid degrading image references into arbitrary text.

The final browser projection should use whatever image representation the ChatGPT Web surface accepts, preserving the distinction between:

- user/developer image input;
- tool-returned images;
- screenshots;
- view_image results.

---

## 14. Compaction and long-session continuity

Context management is part of the provider architecture because the browser surface has practical limits.

The implementation already contains mechanisms such as:

- rolling Luna checkpoints;
- compaction handoff;
- structured compaction controls;
- replay state;
- context revisions;
- multipart/bigger-context experimental paths.

These mechanisms should be unified under the ProviderCore rather than treated as unrelated workarounds.

### 14.1 Model context versus transport context

The provider must distinguish:

~~~text
theoretical model context
        !=
effective ChatGPT Web transport context
~~~

The effective limit is governed by the browser surface and account mode.

Therefore the native provider must advertise a transport-safe context capacity to DSH rather than blindly copying a theoretical model context value.

A large nominal context value must never cause DSH to generate an input that the browser composer cannot accept.

### 14.2 Deterministic size handling

The provider should know, before submission:

- estimated serialized size;
- target composer budget;
- retained image budget;
- checkpoint/replay overhead;
- remaining output headroom.

If the request cannot fit, it should:

1. compact deterministically;
2. reduce transport-only overhead;
3. use the supported multi-part strategy if enabled;
4. fail with a provider-neutral context error if none of the above can safely recover.

It must not rely on accidental DOM truncation.

### 14.3 Lossless-first policy

Context optimization should minimize **lossy transformations**, not merely character count.

Prefer:

~~~text
native DSH structure
    |
    v
one canonical projection
~~~

over:

~~~text
native structure
    |
    v
many smaller intermediate representations
~~~

The architecture values semantic fidelity over cosmetic prompt minimization.

---

## 15. Layer 7: ChatGPT Web Surface Transport

This is the most fragile layer and must therefore be the most isolated.

The surface transport should expose a small stable interface such as:

~~~text
ensureReady()
detectCapabilities()
selectModel()
selectReasoning()
submit()
observeTurn()
readResponse()
cancel()
recover()
close()
~~~

The rest of the plugin must not depend on DOM selectors directly.

### 15.1 Selector isolation

The browser layer may use fallbacks for:

- composer detection;
- model/reasoning controls;
- send readiness;
- response container detection.

For example, the current code already supports selectors for modern and legacy composer variants, including ProseMirror and contenteditable/ARIA forms.

Those selectors are implementation details.

No other layer should know that a selector is:

- a class;
- a data-testid;
- a role;
- an ARIA label;
- a ProseMirror class.

### 15.2 Surface capability detection

The transport should detect the surface revision and capabilities at runtime.

Capability detection should distinguish:

- available model controls;
- available reasoning controls;
- tool connector state;
- browser interaction mode;
- composer capabilities;
- temporary chat availability.

The provider should not infer capabilities solely from version strings.

### 15.3 Readiness

Readiness should be state-based.

The transport must distinguish:

- page loaded;
- composer attached;
- composer editable;
- model selected;
- reasoning control available;
- send enabled;
- turn accepted;
- first response signal seen;
- response completed.

A visible "waiting" or "thinking" label is not sufficient evidence of any particular state.

### 15.4 Reasoning state

Reasoning selection must be represented internally as an abstract effort identifier.

The adapter maps:

~~~text
DSH reasoningEffort
        |
        v
ChatGPT Web reasoning selection
~~~

DOM labels, menu item text, or slider coordinates are transport details.

The system must not classify a turn as dead solely because the UI enters an intermediate visual state such as "Stopped thinking".

### 15.5 Completion

Completion should use a combination of:

- response DOM observation;
- stable turn identity;
- transport progress;
- known final state;
- browser worker settlement.

No single UI string should be the sole completion signal.

### 15.6 Cancellation

Cancellation must flow from:

~~~text
DSH AbortSignal
    |
    v
LlmAdapter
    |
    v
ProviderCore
    |
    v
TurnCoordinator
    |
    +--> MCP capability cancellation
    +--> broker cancellation
    +--> browser turn cancellation
    |
    v
surface transport
~~~

Cancellation must be idempotent.

A cancellation race must not produce a false successful completion.

---

## 16. Browser process boundary

The target architecture does not require the browser worker to run in the same process as the DSH provider registration.

A local process boundary is acceptable and can be desirable for:

- Playwright fault isolation;
- browser crashes;
- dependency containment;
- lifecycle isolation;
- independent recovery;
- platform-specific browser hosting;
- protecting the DSH runtime from browser library failures.

However, the process boundary must be treated as a **private implementation transport**, not as the public model-provider contract.

Therefore the preferred arrangement is:

~~~text
DSH Cordis process
    |
    +--> native ChatGptWebLlmAdapter
    |
    +--> ProviderCore
            |
            v
      private browser-worker transport
            |
            v
        browser process
~~~

The exact IPC may remain HTTP, Unix socket, named pipe, or another local channel.

The important architectural property is:

> HTTP/IPC is an implementation detail between ProviderCore and browser infrastructure, not the semantic boundary through which DSH consumes the model.

This allows process isolation without preserving the old OpenAI-compatibility architecture.

---

## 17. Compatibility entrypoints

The repository currently contains more than one way to reach ChatGPT Web.

These paths must converge.

### 17.1 Native DSH path

Canonical:

~~~text
DSH ctx.llm
    |
    v
ChatGptWebLlmAdapter
    |
    v
ChatGPTWebProviderCore
~~~

### 17.2 OpenAI Responses compatibility path

Compatibility:

~~~text
llm-pi-ai or external client
    |
    v
localhost /v1/responses
    |
    v
thin request translator
    |
    v
ChatGPTWebProviderCore
~~~

The compatibility server remains useful but is not the architectural owner.

It may translate:

- request messages;
- model ids;
- tools;
- streaming;
- errors;
- usage;
- compaction requests.

It must not own a second browser execution loop.

### 17.3 Native Codex compatibility path

The repository also has a native Codex passthrough to:

https://chatgpt.com/backend-api/codex

This path is distinct from the browser turn path.

It should not be removed merely because a native DSH provider exists.

Instead:

~~~text
Native DSH provider
        |
        v
ProviderCore
        ^
        |
Responses compatibility
        ^
        |
Native Codex compatibility
~~~

Where a capability is genuinely tied to the Codex transport, that capability must remain a compatibility concern rather than being falsely modeled as a browser feature.

### 17.4 One execution core

The invariant is:

> Different ingress protocols may translate into different request shapes, but they must not create independent ChatGPT Web execution semantics.

---

## 18. Model catalogue and capability resolution

The current repository already centralizes substantial model knowledge in the ChatGPT Web model catalogue and account-capability probing.

The native provider should make this information visible to DSH through the native model catalogue.

### 18.1 Model catalogue

The model catalogue should provide:

- stable provider model id;
- display name;
- account/mode availability;
- input modalities;
- reasoning levels;
- default reasoning where applicable;
- effective context capacity;
- output limits;
- account capability requirements.

### 18.2 Account gating

Model availability must be capability-driven.

The plugin should not simply publish every known model and let calls fail later.

Instead:

~~~text
authenticated browser
        |
        v
capability probe
        |
        v
provider model catalogue
        |
        v
DSH ctx.llm model list
~~~

This provides predictable model selection.

### 18.3 Effective context metadata

A model's advertised DSH context should represent the provider's usable transport contract.

If ChatGPT Web exposes a larger theoretical model context than the current browser composer can safely transport, the provider must report a safe effective capacity.

This is more useful to DSH than copying an optimistic theoretical value.

---

## 19. Streaming and error semantics

The native adapter must implement DSH's StreamChunk protocol rather than leaking plugin-specific AdapterEvent values into the harness.

The mapping is conceptually:

~~~text
ChatGPT/provider event
        |
        v
ProviderCore normalized event
        |
        v
ChatGptWebLlmAdapter
        |
        v
DSH StreamChunk
~~~

### 19.1 Text

Text deltas become DSH text-delta chunks.

### 19.2 Reasoning

Reasoning output becomes DSH reasoning-delta chunks where the provider can reliably expose it.

### 19.3 Tool calls

Provider-internal MCP calls should not be surfaced as DSH tool-call deltas merely for appearance.

They should become DSH tool-call events only when the active execution mode actually hands tool-loop ownership back to DSH.

Otherwise:

- retain provenance internally;
- expose progress diagnostically where appropriate;
- return the final assistant result through the normal model stream.

### 19.4 Usage

Usage is best-effort unless the upstream provides authoritative accounting.

The adapter should normalize:

- input tokens;
- output tokens;
- total tokens;
- cached input where known;
- reasoning output where available;
- estimated flag.

### 19.5 Finish ordering

The adapter must follow DSH's provider contract:

- usage before finish;
- nothing after finish;
- raw JSON tool argument fragments where tool-call streaming applies;
- consistent block indexes;
- replayState only when safe and supported.

### 19.6 Errors

Provider failures should be translated into stable DSH LlmError categories where possible.

Examples:

- authentication/session unavailable;
- account capability unavailable;
- rate limited;
- context too large;
- surface unavailable;
- browser closed;
- provider timeout;
- user aborted;
- stale turn;
- unsupported option.

Do not classify provider behavior from arbitrary error-message text when structured state is available.

---

## 20. Retry policy

Retries must distinguish between safe and unsafe failures.

Safe candidates may include:

- temporary browser surface attachment failure;
- transient transport connection failure;
- recoverable model-selection UI race;
- one-shot page rehydration.

Unsafe candidates include:

- partially executed capability calls;
- stateful ChatGPT turns that may have continued;
- ambiguous completion;
- capability invocation where side effects may already have happened.

The ProviderCore must therefore know whether a failure occurred:

- before submission;
- after submission but before first response;
- during reasoning;
- during capability execution;
- after final content was visible;
- during settlement.

A retry must never duplicate an operation merely because the browser transport timed out.

The turn coordinator and execution namespace must provide the idempotence boundary.

---

## 21. Security model and trust boundaries

The following boundaries are mandatory.

~~~text
UNTRUSTED / MODEL-CONTROLLED
--------------------------------
model text
model tool arguments
model-visible transport text
ChatGPT UI content

        |
        | validated projection
        v

TRUSTED / DSH-CONTROLLED
--------------------------------
agent identity
session identity
turn identity
workspace roots
sandbox policy
tool registry
skill policy
approvals
guards
broker bindings
capability scope
cancellation authority
~~~

### 21.1 Model text is never authority

The model cannot create:

- new tools;
- new skills;
- new workspace roots;
- broader filesystem permissions;
- new sandbox policies;
- new approval grants;
- new agent identity.

### 21.2 Turn-scoped authority

Capabilities must be bound to:

- agent;
- thread/session;
- turn;
- execution namespace or equivalent trusted identity.

A browser session alone is not sufficient authorization.

### 21.3 Fail-closed behavior

When trusted context is missing or inconsistent, the operation should fail closed.

Examples:

- missing turn identity when browser replay requires it;
- stale binding;
- mismatched workspace;
- invalid environment;
- unknown tool;
- capability outside the current scope.

### 21.4 Compatibility transports inherit DSH authority

A call arriving through the local Responses endpoint must not bypass the native DSH authorization model.

Compatibility is a protocol; it is not an alternate security domain.

---

## 22. Provenance and observability

Every important event should have a distinguishable provenance.

Useful provenance categories include:

- ChatGPT-native model/session;
- DSH model provider;
- DSH tool;
- DSH skill;
- MCP transport;
- turn broker;
- browser surface;
- compatibility HTTP;
- native Codex compatibility.

Diagnostics should make it possible to answer:

1. Where did the event originate?
2. Which DSH turn owns it?
3. Which browser turn corresponds to it?
4. Which capability scope applied?
5. Was it model-generated or DSH-authorized?
6. Which transport path carried it?
7. Was the result authoritative or estimated?

This is especially important when debugging failures that cross process boundaries.

---

## 23. Session and browser lifecycle

The Cordis lifecycle should own provider availability.

The target lifecycle is:

~~~text
DSH startup
    |
    v
plugin initialization
    |
    +--> register native ctx.llm provider
    |
    +--> initialize ProviderCore
    |
    +--> lazily attach/start browser infrastructure
    |
    v
provider ready
~~~

A browser process may start eagerly or lazily depending on configuration, but provider registration should not require a successful browser login just to compose the plugin.

Instead, the provider can report a meaningful runtime error when invoked without usable authentication.

### 23.1 Shutdown

Shutdown order must be:

1. stop accepting new provider calls;
2. cancel active logical turns;
3. revoke capability bindings;
4. settle browser turns;
5. close MCP/broker channels;
6. flush diagnostics/checkpoints where appropriate;
7. stop browser infrastructure.

This prevents new model requests from racing with teardown.

---

## 24. Concurrency model

ChatGPT Web is not equivalent to a stateless HTTP model server.

The provider must explicitly manage concurrency.

The canonical default should favor one controlled browser session and deterministic sequencing for the same ChatGPT account/session.

Parallel work should be allowed only when:

- the browser surface supports it;
- the account/session semantics are known to be safe;
- the turn coordinator can isolate identities;
- capability bindings remain disjoint;
- UI state cannot be accidentally shared.

The plugin must not claim API-like parallelism merely because DSH can issue concurrent model calls.

When concurrency is unsupported, the provider should fail deterministically or queue according to an explicit policy.

It must not let two callers race on the same composer.

---

## 25. Cancellation model

Cancellation is end-to-end:

~~~text
DSH AbortSignal
    |
    v
LlmAdapter
    |
    v
ProviderCore
    |
    v
TurnCoordinator
    |
    +--> browser worker
    +--> browser surface
    +--> MCP/broker
    +--> in-flight capability call
~~~

Cancellation must be:

- idempotent;
- turn-scoped;
- observable;
- safe during any execution phase.

A cancellation that arrives after the browser has already completed must not corrupt the settled result.

A late cancellation must not accidentally cancel a newer turn sharing the same browser session.

---

## 26. Completion and recovery model

A robust provider must distinguish:

- request accepted;
- model started thinking;
- first visible output;
- capability request;
- capability result;
- final response visible;
- turn completion;
- browser settlement;
- logical completion.

These are not interchangeable.

A recovery operation may need to:

1. determine whether the browser still owns the intended turn;
2. determine whether the final response was already committed;
3. verify the expected turn identity;
4. restore the conversation from trusted state;
5. replay the minimal required context;
6. retire obsolete bindings;
7. resume or fail deterministically.

The system must prefer replay from trusted local state over attempting to infer state from arbitrary UI text.

---

## 27. Browser surface resilience strategy

The browser layer is expected to change over time.

The architecture therefore optimizes for localized breakage.

### 27.1 All DOM knowledge belongs here

Do not allow these details to leak upward:

- selector strings;
- CSS classes;
- test ids;
- ARIA labels;
- contenteditable structure;
- ProseMirror internals;
- DOM node traversal;
- response container layout.

### 27.2 Versioned surface contract

The transport should expose a stable internal contract and may internally support multiple surface revisions.

Conceptually:

~~~text
WebSurface
├── discovery
├── readiness
├── composer
├── model selection
├── reasoning selection
├── submit
├── observation
├── cancellation
├── recovery
└── diagnostics
~~~

When ChatGPT changes its UI, the expected change should normally be isolated to this layer.

### 27.3 Multiple locator strategies

Fallback selectors are acceptable inside the surface transport.

They should be ordered from most semantically meaningful to least specific, for example:

1. stable test or accessibility attributes;
2. semantic role/name;
3. known editor implementation;
4. last-resort structural selector.

The caller should see only success/failure/capability results, not the selector mechanics.

### 27.4 No text-based control protocol

Do not use visible response prose to determine:

- whether a tool ran;
- whether a turn is complete;
- whether the model will continue;
- whether a permission was granted.

Visible prose is model output.

---

## 28. API-like semantics that are achievable

With the target architecture, DSH can provide:

- provider-native model selection;
- dynamic model catalogue;
- reasoning effort selection;
- multimodal request support where the web surface supports it;
- streaming;
- cancellation;
- provider-neutral errors;
- context capability metadata;
- session-aware replay;
- usage accounting where available;
- capability access;
- skill discovery/loading through DSH's native model-facing projection;
- deterministic compaction and checkpointing;
- provider lifecycle.

These are the aspects that matter for making Luna feel like a normal provider.

---

## 29. API-like semantics that should not be faked

The following must remain explicitly provider-specific:

- exact browser UI timing;
- exact ChatGPT Web rate limits;
- official API token accounting where unavailable;
- guaranteed arbitrary concurrency;
- guaranteed maximum theoretical context;
- arbitrary provider-level tool-call ownership;
- DOM stability;
- account feature availability.

The provider should expose the strongest accurate contract, not a fictional one.

---

## 30. Rejected architectural approaches

### 30.1 Keep llm-pi-ai + localhost Responses as the canonical integration

Rejected.

It is a useful compatibility adapter, but it puts an artificial protocol boundary between DSH and a provider the plugin already understands.

It also encourages provider semantics to drift outside ctx.llm.

### 30.2 Put Playwright directly into the DSH agent loop

Rejected.

The browser is transport infrastructure and should remain isolated.

The model provider abstraction should not know whether the underlying transport is Playwright, a socket, a native endpoint, or a future official API.

### 30.3 Delete the turn broker

Rejected.

The broker solves a genuine cross-process lifetime problem.

What must disappear is duplicate capability authority, not turn coordination.

### 30.4 Rebuild skills inside the plugin

Rejected.

DSH already owns skills.

A second registry would create policy drift and duplicate lifecycle logic.

### 30.5 Force DSH to own every ChatGPT-side tool loop

Rejected for the canonical Luna Web path.

Doing so would make the integration less reliable, not more API-like, unless ChatGPT provides a stable structured turn protocol that makes DSH-side loop ownership viable.

### 30.6 Treat the DOM as a stable API

Rejected.

The DOM is an unstable product surface.

Only the WebSurfaceTransport may depend on it.

### 30.7 Optimize context solely by character count

Rejected.

Context reduction is useful only when it preserves semantics.

The primary goal is minimizing lossy transformations and redundant serialization.

---

## 31. Canonical ownership table

| Concern | Owner | Transport/Projection |
|---|---|---|
| Provider registration | DSH ctx.llm / plugin | LlmAdapter |
| Model catalogue | ChatGPT Web provider core | DSH LlmAdapter |
| Account capability detection | Plugin + authenticated browser | ProviderCore |
| Model reasoning selection | ProviderCore | WebSurfaceTransport |
| Conversation structure | DSH | ContextProjector |
| Tool registry | DSH ctx.tools | Capability projection |
| Tool schema | DSH ctx.tools | MCP / provider projection |
| Tool authorization | DSH | Native runtime |
| Tool execution | DSH | Broker/MCP transport |
| Tool result | DSH | Provider capability projection |
| Skill registry | DSH ctx.skills | Native skill projection |
| Skill policy | DSH | Skill subsystem |
| Skill loading | DSH | Capability projection |
| Sandbox | DSH | Trusted turn environment |
| Approval | DSH | Native runtime |
| Agent identity | DSH | Trusted turn state |
| Thread identity | DSH + ProviderCore | Internal binding |
| Turn identity | ProviderCore | Browser/provider transport |
| Cross-process coordination | TurnBroker | Private IPC |
| ChatGPT Web DOM | WebSurfaceTransport | Playwright |
| Context serialization | ContextProjector | Browser composer |
| Compaction/checkpoints | ProviderCore | Replay stores |
| Streaming conversion | LlmAdapter | DSH StreamChunk |
| Usage estimation | ProviderCore | DSH usage |
| HTTP compatibility | Compatibility adapter | ProviderCore |
| Native Codex compatibility | Compatibility adapter | ProviderCore / native transport |
| Diagnostic provenance | ProviderCore | DSH logging/telemetry |

The table should remain synchronized with the implementation.

---

## 32. Canonical request lifecycle

A normal request should conceptually execute as follows.

~~~text
1. DSH selects provider=chatgpt-web, model=luna
                |
                v
2. ctx.llm resolves exact model metadata
                |
                v
3. ChatGptWebLlmAdapter prepares one provider generation
                |
                v
4. ProviderCore creates a logical turn
                |
                v
5. CapabilityPlane snapshots permitted DSH tools/skills
                |
                v
6. ContextProjector builds one canonical ChatGPT projection
                |
                v
7. TurnCoordinator binds identity + environment + capability lease
                |
                v
8. WebSurfaceTransport ensures ChatGPT surface readiness
                |
                v
9. Model/reasoning selection is applied
                |
                v
10. Prompt is submitted
                |
                v
11. ChatGPT Web reasons and may request capabilities
                |
                +--> MCP
                |     |
                |     v
                |   Broker
                |     |
                |     v
                |   DSH ctx.tools / skill projection
                |     |
                |     v
                |   result
                |     |
                |     +--------------------+
                |                          |
                +--------------------------+
                |
                v
12. ProviderCore observes final model output
                |
                v
13. Usage/replay/checkpoint state is finalized
                |
                v
14. Capability binding is retired
                |
                v
15. LlmAdapter maps events to DSH StreamChunk
                |
                v
16. DSH receives the normal provider result
~~~

The exact number of internal turns or tool calls is not visible to the DSH caller.

---

## 33. Provider state machine

A provider call should have an explicit state machine.

~~~text
IDLE
  |
  v
PREPARING
  |
  +--> FAILED
  |
  v
BOUND
  |
  v
SURFACE_READY
  |
  v
SUBMITTED
  |
  v
RUNNING
  |
  +--> CAPABILITY_WAIT
  |         |
  |         v
  |      RUNNING
  |
  +--> COMPLETED
  |
  +--> CANCELLED
  |
  +--> FAILED
  |
  v
SETTLING
  |
  v
RETIRED
~~~

A state transition must be monotonic.

A retired turn must never return to running.

---

## 34. Testing strategy

The architecture should be tested at multiple boundaries.

### 34.1 Provider contract tests

Verify:

- model listing;
- model resolution;
- reasoning metadata;
- context metadata;
- modality metadata;
- stream ordering;
- usage-before-finish;
- cancellation;
- unsupported option behavior;
- replayState handling.

### 34.2 ProviderCore tests

Verify:

- turn identity;
- lifecycle;
- capability binding;
- cleanup;
- late-call rejection;
- recovery;
- compaction;
- replay;
- retry classification;
- concurrency.

### 34.3 Capability-plane tests

Verify:

- tool scope projection;
- schema fidelity;
- namespace mapping;
- freeform tool handling;
- tool-search/deferred capability handling;
- authorization;
- sandbox preservation;
- cancellation;
- structured results.

### 34.4 Skill tests

Verify:

- model-invocable filtering;
- lazy loading;
- user-invocable policy where applicable;
- forbidden skill rejection;
- no plugin-owned registry;
- skill/tool semantic separation.

### 34.5 Context tests

Verify:

- role preservation;
- instruction ordering;
- image preservation;
- tool history preservation;
- stale handle removal;
- authority metadata separation;
- checkpoint round trips;
- compaction correctness;
- deterministic size handling.

### 34.6 Surface transport tests

Verify:

- capability detection;
- composer discovery;
- model selection;
- reasoning selection;
- send readiness;
- first-token detection;
- completion detection;
- cancel;
- rehydration;
- stale page recovery.

These tests should avoid overfitting to one DOM revision where possible.

### 34.7 Compatibility tests

Run the native and compatibility paths through the same core and verify:

- equivalent capability behavior;
- equivalent context semantics;
- equivalent error classes where applicable;
- no duplicated execution loop;
- no authority bypass.

---

## 35. Migration strategy

This architecture should be implemented incrementally.

### Phase 0 — architecture contract

Freeze the ownership and layering rules in this document before changing core execution ownership.

No code should be added solely because a lower-level workaround is convenient.

### Phase 1 — native DSH provider boundary

Implement:

- plugin injection into llm;
- native ChatGptWebLlmAdapter;
- model catalogue projection;
- reasoning/capability metadata;
- provider error and stream mapping.

Keep the existing compatibility server alive.

Do not rewrite browser automation.

### Phase 2 — ProviderCore extraction

Extract shared execution semantics from the current Responses path into a ProviderCore without changing browser behavior unnecessarily.

The first success criterion is:

~~~text
Native DSH entrypoint
        |
        v
ProviderCore
        |
        v
existing browser execution
~~~

### Phase 3 — capability plane

Make DSH ctx.tools authoritative.

Retain the broker as a coordinator.

Replace duplicate authoritative registries with projections.

Integrate skills through the native DSH skill projection rather than adding plugin-owned skill logic.

### Phase 4 — context/replay normalization

Make one canonical context projection.

Keep trusted metadata out-of-band.

Unify rolling checkpoints and compaction handoff under the provider core.

### Phase 5 — WebSurfaceTransport isolation

Move all DOM knowledge behind the surface boundary.

Add explicit capability detection, recovery, completion, and cancellation semantics.

### Phase 6 — compatibility convergence

Make:

- Responses compatibility;
- native Codex compatibility;
- native DSH provider

all converge on the same ProviderCore.

Only then consider retiring redundant code.

### Phase 7 — observability and retirement

Add architectural contract tests and provenance diagnostics.

Remove duplicated state only after parity is demonstrated.

---

## 36. Relationship to the current issue sequence

The current open architecture issues were created before this document and should be treated as implementation work items, not as the architecture itself.

The intended dependency order is:

1. Native provider boundary + ProviderCore + ownership/trust model.
2. Unified capability plane for tools and native DSH skill projection.
3. Canonical context/replay/compaction projection.
4. Isolated and resilient WebSurfaceTransport.
5. Converged compatibility entrypoints.
6. Observability, architecture tests, and retirement of redundant paths.

This means some existing issue descriptions should eventually be adjusted to match this document.

In particular:

- the turn broker must not be removed merely because ctx.tools becomes authoritative;
- direct ctx.skills integration should not become a duplicate skill subsystem;
- context optimization should focus on canonical projection and semantic preservation, not only character reduction;
- the capability/ownership boundary should be established early rather than postponed until the end;
- WebSurfaceTransport resilience must be a first-class architectural concern.

This document is the higher-level contract against which those issues should be reconciled.

---

## 37. Implementation rules

Future changes to this repository should follow these rules.

### Rule 1

If a change modifies model-provider behavior, determine whether it belongs in:

- DSH adapter boundary;
- ProviderCore;
- capability plane;
- context/replay;
- surface transport.

Do not place it wherever it is easiest.

### Rule 2

If a change adds a new authoritative registry, stop and establish why an existing DSH registry is insufficient.

### Rule 3

If a change adds DOM selectors outside the surface transport, stop and move the responsibility downward.

### Rule 4

If a change adds model-visible security state, stop and determine whether that state can remain trusted and out-of-band.

### Rule 5

If a change adds another protocol translation, establish which layer already owns the same semantics.

### Rule 6

If a change modifies compatibility behavior, ensure it still converges on ProviderCore rather than creating another execution path.

### Rule 7

If a workaround is unavoidable because ChatGPT Web lacks an API capability, isolate it behind the smallest stable internal contract possible.

### Rule 8

Never confuse "the browser can do it" with "the model is authorized to do it".

---

## 38. Future transport substitution

One of the most important tests of this architecture is whether the browser can eventually be replaced.

Possible future transports might include:

- an official model API;
- a different ChatGPT desktop transport;
- a native product protocol;
- a more stable browser automation layer.

The replacement should affect primarily:

~~~text
ChatGPT Web Transport
~~~

It should not require redesigning:

- DSH provider semantics;
- capability ownership;
- skills;
- turn authority;
- context structures;
- compaction;
- session ownership;
- approvals;
- sandbox policy.

That is the ultimate decoupling test.

If replacing Playwright requires rewriting the provider, the architecture has leaked browser concerns upward.

---

## 39. What "native" means for this project

"Native" has three distinct meanings, and only one is the project's actual goal.

### Native to DSH

Required.

ChatGPT Web should participate in DSH through:

- ctx.llm;
- native model metadata;
- native stream semantics;
- native cancellation;
- native capability authority;
- native skill policy;
- native lifecycle.

### Native to ChatGPT Web

Not fully controllable.

The provider remains constrained by:

- the ChatGPT Web product;
- browser DOM;
- account state;
- web-session behavior.

The plugin must encapsulate those constraints.

### Native to OpenAI's internal protocol

Not a goal.

This project must not depend on undocumented assumptions that make the implementation look like an official API.

---

## 40. Final architecture invariant

The entire architecture can be reduced to the following ownership model:

~~~text
DSH
  = runtime authority
  = tools
  = skills
  = sandbox
  = approvals
  = agent/session lifecycle
  = provider contract

ChatGPT
  = model reasoning
  = model response
  = ChatGPT-native product behavior

ProviderCore
  = integration semantics
  = turn coordination
  = context/replay
  = lifecycle bridge
  = capability binding
  = browser-independent provider behavior

MCP / broker
  = capability and turn transport
  = cross-process coordination
  = not authority

WebSurfaceTransport
  = browser mechanics
  = DOM
  = readiness
  = selection
  = submit
  = observe
  = cancel
  = recovery

HTTP / Codex compatibility
  = alternate ingress/transport
  = never a second provider implementation
~~~

The critical invariant is:

> **ChatGPT decides what it wants to do; DSH decides what it is allowed to do.**

And the critical provider invariant is:

> **Every supported ChatGPT Web entrypoint converges on one provider execution core, while browser-specific mechanics remain isolated at the transport boundary.**

This is the architecture that most closely approximates consuming ChatGPT Luna Free through a normal model API without pretending that ChatGPT Web is itself a normal API.

---

## 41. Current implementation evidence

The target architecture is grounded in the existing repository rather than being a green-field rewrite.

Relevant current components include:

- [src/plugin.ts](../src/plugin.ts) — current Cordis lifecycle/sidecar integration.
- [src/types.ts](../src/types.ts) — request, tool, stream, usage, provider configuration, and browser tuning types.
- [src/adapters/chatgpt-web/index.ts](../src/adapters/chatgpt-web/index.ts) — current ChatGPT Web provider adapter and turn orchestration.
- [src/adapters/chatgpt-web/environment.ts](../src/adapters/chatgpt-web/environment.ts) — trusted turn environment, identity, sandbox, and tool context.
- [src/adapters/chatgpt-web/turn-broker.ts](../src/adapters/chatgpt-web/turn-broker.ts) — cross-process turn/capability coordination.
- [src/adapters/chatgpt-web/mcp-server.ts](../src/adapters/chatgpt-web/mcp-server.ts) — ChatGPT-facing MCP projection and bridge calls.
- [src/adapters/chatgpt-web/turn-execution.ts](../src/adapters/chatgpt-web/turn-execution.ts) — logical turn execution, settlement, and cancellation.
- [src/adapters/chatgpt-web/prompt.ts](../src/adapters/chatgpt-web/prompt.ts) — context projection and ChatGPT Web transport contract.
- [src/adapters/chatgpt-web/thread-environment.ts](../src/adapters/chatgpt-web/thread-environment.ts) — persisted thread environment state.
- [src/adapters/chatgpt-web/compaction-handoff.ts](../src/adapters/chatgpt-web/compaction-handoff.ts) — compaction coordination.
- [src/adapters/chatgpt-web/rolling-checkpoint.ts](../src/adapters/chatgpt-web/rolling-checkpoint.ts) — Luna checkpoint continuity.
- [src/chatgpt-session.ts](../src/chatgpt-session.ts) — browser surface selectors and UI interaction.
- [src/native-passthrough.ts](../src/native-passthrough.ts) — native Codex compatibility path.
- [src/server.ts](../src/server.ts) — current HTTP compatibility server and lifecycle control.
- [src/chatgpt-web-models.ts](../src/chatgpt-web-models.ts) — ChatGPT Web model/account capability definitions.

The current repository also exposes the architectural distinction that motivated this specification:

- the ChatGPT adapter is currently a plugin-local ProviderAdapter;
- the DSH-native LlmAdapter boundary is not yet the canonical provider path;
- the current browser adapter already contains substantial turn, environment, tool, replay, and compaction machinery worth preserving;
- the local Responses server is currently a meaningful compatibility surface and should therefore be demoted rather than abruptly removed.

---

## 42. Upstream DSH contract references

The native implementation should track the target DSH release rather than copying an old contract.

Relevant upstream documentation:

- DSH LLM runtime: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts
- DSH LLM types: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/types.ts
- LLM adapter cookbook: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-an-llm-adapter.md
- DSH tools subsystem: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md
- DSH skills subsystem: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md
- DSH skill tool projection: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/tool-skill/src/index.ts

The implementation must re-check these contracts against the exact DSH version being targeted before introducing the native adapter.

---

## 43. Definition of architectural success

The re-architecture is successful when all of the following are true.

### From DSH's perspective

ChatGPT Web is a normal provider:

- selectable through ctx.llm;
- model metadata comes from the provider;
- reasoning is provider metadata;
- streaming follows DSH semantics;
- cancellation works;
- capability access follows DSH authority;
- skills remain native DSH concepts;
- context is generated from DSH-native structures.

### From the plugin's perspective

There is one execution core:

- browser turns are centralized;
- tool/skill authority is not duplicated;
- compatibility paths share execution logic;
- context/replay behavior has one owner;
- browser DOM details are isolated.

### From the security perspective

No transport can grant authority:

- model text cannot widen permissions;
- MCP cannot bypass DSH;
- HTTP compatibility cannot bypass DSH;
- stale turn bindings cannot execute;
- browser state cannot redefine sandbox policy.

### From the maintenance perspective

When ChatGPT changes its UI:

- the WebSurfaceTransport is the primary change point.

When DSH changes its LLM contract:

- ChatGptWebLlmAdapter is the primary change point.

When tool policy changes:

- DSH ctx.tools is the primary change point.

When skill policy changes:

- DSH ctx.skills is the primary change point.

When compatibility requirements change:

- compatibility adapters are the primary change point.

The rest of the architecture should remain stable.

---

## 44. Non-negotiable anti-patterns

The following patterns should be treated as architecture regressions:

~~~text
DSH -> llm-pi-ai -> HTTP -> plugin -> browser
as the only canonical path

plugin-owned authoritative tool registry

plugin-owned authoritative skill registry

DOM selectors in ProviderCore

sandbox decisions in MCP

approval decisions in broker

model-visible text used as trusted authority

separate browser execution implementations for HTTP and native paths

a second generic LLM abstraction layered on ctx.llm

a provider context limit that ignores actual browser transport capacity

automatic retries after ambiguous side-effecting turns

completion based solely on visible ChatGPT prose

reasoning-state detection based solely on one UI label
~~~

Any such change should require explicit architectural review.

---

## 45. Final target diagram

~~~text
                                   DeepSeek Harness
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  Agent / Session Runtime                                                   │
│      |                                                                      │
│      +------------------------------+                                       │
│      |                              |                                       │
│      v                              v                                       │
│    ctx.llm                       ctx.tools / ctx.skills                     │
│      |                              |                                       │
│      v                              v                                       │
│ ChatGptWebLlmAdapter          DSH Capability Plane                          │
│      |                              |                                       │
│      +---------------+--------------+                                       │
│                      v                                                      │
│             ChatGPTWebProviderCore                                          │
│             ├── Model Resolver                                              │
│             ├── Turn Coordinator                                             │
│             ├── Context / Replay Projector                                  │
│             ├── Compaction / Checkpoints                                    │
│             ├── Capability Binding                                           │
│             ├── Usage / Error Mapping                                       │
│             ├── Browser Session Manager                                     │
│             └── Provenance / Diagnostics                                    │
│                      |                                                      │
│              +-------+--------+                                             │
│              |                |                                             │
│              v                v                                             │
│       Capability Transport   WebSurfaceTransport                             │
│          MCP + broker       Playwright / Browser                            │
│              |                |                                             │
└──────────────|────────────────|──────────────────────────────────────────────┘
               |                |
               +--------+-------+
                        |
                        v
                    ChatGPT Web
                        |
                        v
                 Luna / ChatGPT model


Compatibility paths:

 OpenAI Responses -------------------+
                                      |
 Native Codex compatibility ---------+--> ChatGPTWebProviderCore
                                      |
 Native DSH ctx.llm ------------------+
~~~

This diagram is the architectural center of the project.

Everything else is implementation detail around it.
