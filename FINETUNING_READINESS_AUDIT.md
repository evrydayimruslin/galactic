# FINETUNING READINESS AUDIT

Audit date: 2026-05-05
Scope: Flash and Heavy tier LLM-using components in the current Ultralight codebase. CLOB and BioASM were explicitly skipped; I found no code references matching `clob`, `CLOB`, `bioasm`, `BioASM`, `bio_asm`, or `BIOASM`.

Model availability note: I checked the official Cerebras docs while writing this report. The shared public endpoint list currently shows `llama3.1-8b` and `gpt-oss-120b` as production models, with `llama3.1-8b` scheduled for deprecation on 2026-05-27. The enterprise dedicated-endpoint docs are the better match for Ultralight's reserved-capacity plan: they explicitly support bring-your-own fine-tuned weights and list Qwen3 small/tiny variants (`0.6B`, `1.7B`, `8B`, `14B`, `32B`), Llama 3.3 70B, Llama 4 Scout/Maverick, Mistral, GPT-OSS, GLM, Kimi, DeepSeek, and other families. Sources: [Cerebras supported models](https://inference-docs.cerebras.ai/models/overview) and [Cerebras dedicated endpoints](https://inference-docs.cerebras.ai/dedicated/overview).

## 1. ARCHITECTURE READINESS SCORECARD

| Dimension | Score | Evidence | Readiness judgment |
| --- | ---: | --- | --- |
| LLM call abstraction | 4/5 | Core chat/orchestrate calls route through `api/services/inference-client.ts`, where `fetchInferenceChatCompletion()` builds the OpenAI-compatible `/chat/completions` request. BYOK/runtime calls also use `api/services/ai.ts` via `AIService.call()`. However, Flash broker calls (`api/services/flash-broker.ts`), the legacy context resolver (`api/services/context-resolver.ts`), runtime app calls (`api/services/runtime-ai.ts`), and Dynamic Worker AI (`api/src/bindings/ai-binding.ts`) are separate call paths. | Strong central primitives exist, but there is not yet one universal LLM chokepoint carrying component identity, telemetry, routing, and eval metadata. |
| Provider/model parameterization | 3/5 | Desktop has global interpreter/heavy defaults in `desktop/src/lib/storage.ts` (`deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro`) and sends them through `streamOrchestrate()` in `desktop/src/lib/api.ts`. Server routing supports Light/BYOK in `api/services/inference-route.ts`. Platform model aliases are centralized in `api/services/platform-inference-models.ts`. But many MCP apps hard-code requested models such as `openai/gpt-4o-mini`, `openai/gpt-4o`, `google/gemini-3-flash-preview`, and `meta-llama/llama-4-scout`. | Good for user/provider selection, weak for per-component fine-tuned endpoint selection. |
| Telemetry and logging | 3/5 | `api/services/chat-capture.ts` stores chat threads, messages, events, heavy recipes, tool outputs, and request artifacts. `api/services/invocation-telemetry.ts` records `llm_invocations` plus `llm_context_snapshots`; `api/services/capture-inspection.ts` exports these plus tool invocations and training annotations to JSONL. Heavy orchestrate calls are instrumented in `api/services/orchestrator.ts`. Gaps: Flash broker calls and runtime `ultralight.ai()` calls are not consistently recorded as component-tagged LLM invocations. | The capture substrate is valuable and already close to training-data export, but fine-tuning needs every Flash/Heavy subcall tagged by component and task. |
| OpenAI-compatible API surface | 4/5 | `api/services/ai.ts` is explicitly an OpenAI-compatible adapter; `api/services/inference-client.ts` posts to `/chat/completions`; `api/handlers/app.ts` exposes `/v1/chat/completions`; Google is configured through its OpenAI-compatible endpoint in shared provider config. | Strong. Cerebras/OpenPipe/Together can drop in behind base URL/model changes for chat completions. Embedding calls remain separate. |
| Per-component model assignment | 2/5 | The architecture has two global model slots: interpreter/Flash and Heavy (`desktop/src/lib/storage.ts`, `desktop/src/components/ChatView.tsx`). Flash can suggest `flash` or `sonnet` inside `api/services/flash-broker.ts`, but that maps back to the global Flash/Heavy defaults. `InferenceRoutePreference` only includes `billingMode`, `provider`, and `model`, not `component_id` or `tier`. | This is the main readiness gap. Tasks are separable in code, but model assignment is not yet a first-class component registry. |
| Eval harness | 2/5 | There are route, billing, capture, runtime, and inference tests; `scripts/smoke/chat-capture-smoke.mjs` can exercise `/chat/orchestrate` and verify Supabase capture rows. I did not find a component-level model eval harness comparing candidate outputs to a baseline with task metrics. | Good infrastructure tests, not yet output-quality evals. |
| Tier-routing primitives | 4/5 | The server-side orchestration pipeline explicitly has Flash analysis/prompt construction and Heavy execution (`api/services/orchestrator.ts`, `api/services/flash-broker.ts`). Defaults map to DeepSeek V4 Flash/Pro. Light/BYOK routing exists in `api/services/inference-route.ts`. | Flash/Heavy routing is real and functional. It needs per-component registry, traffic splits, and frontier fallback policies to become a fine-tuning flywheel. |

Overall answer: Ultralight is closer than a typical app because the Flash/Heavy pipeline, OpenAI-compatible routing, and capture substrate already exist. The missing piece is not "use an LLM client"; it is component identity. The code needs every LLM call to say "I am `flash_broker.analyze`, tier Flash, schema X, baseline model Y, eval metric Z" before production fine-tunes can be cleanly trained, served, compared, and ramped.

## 2. FLASH TIER COMPONENT INVENTORY

Notes:

- "Current model/provider" means the requested model in code plus the effective route behavior where visible. In Light mode backed by direct DeepSeek, `selectInferenceModel()` may ignore a non-platform requested model and use the route model.
- Training volume estimates assume production traces plus teacher re-labeling where needed.
- Cerebras-supported recommendations use plausible Cerebras-served open model families; final availability should be confirmed against the reserved-capacity catalog before implementation.

| Component | Source location | Current model/provider | Volume | Latency | Input shape | Output shape | Student size | Base family | Data needed | Readiness blockers |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| Flash request analyzer/router | `api/services/flash-broker.ts` (`FLASH_ANALYZE_SYSTEM`, `runFlashBroker`, `callFlash`) | Default `ultralight/deepseek-v4-flash` -> DeepSeek direct; can be overridden by interpreter model | very high | tight | Structured catalog + current message + summary/history + optional files/project context | JSON classification/routing: mode, relevant apps, actions, delegations, conversation search, rolling summary | 8B | Qwen3-8B | high: ~20K+ | Add `component_id=flash_broker.analyze`; log request/output/parse failures; create app/action routing eval set; move model from global interpreter default to component registry. |
| Flash prompt constructor for Heavy | `api/services/flash-broker.ts` (`FLASH_PROMPT_SYSTEM`, write-mode second `callFlash`) | Default `ultralight/deepseek-v4-flash` -> DeepSeek direct | high | tight | Magnified app data + function signatures + conventions + user request | JSON with final Heavy prompt, model hint, entities, conventions | 8B | Qwen3-8B | high: ~20K+ | Instrument separately from analyzer; validate JSON schema; score entity resolution and tool argument readiness; separate prompt-constructor model assignment. |
| Flash read-response synthesizer | `api/services/flash-broker.ts` (`FLASH_READ_RESPONSE_SYSTEM`, read-mode `callFlashText`) | Default `ultralight/deepseek-v4-flash` -> DeepSeek direct | high | tight | Long-ish live app data + question + conversation context | Short grounded natural-language answer | 8B | Qwen3-8B | med: ~5-20K | Add grounding/citation evals; log read-mode input/output as its own component; define fallback when data is too long or answer confidence is low. |
| Flash action confirmation | `api/services/orchestrator.ts` execution result confirmation via `callFlashText` | Interpreter model if provided; otherwise hard-coded fallback request `google/gemini-3.1-flash-lite-preview:nitro`, then route selection applies | med-high | tight | User request + truncated execution result | 1-3 sentence confirmation | 1.5B | Qwen3-1.7B | med: ~5-20K | Remove hard-coded fallback into registry; instrument as `orchestrate.confirmation`; eval factual inclusion/no hallucinated action. |
| Legacy context resolver | `api/services/context-resolver.ts` (`resolveContext`, `callFlashBroker`) | `ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL` -> DeepSeek direct | med | tight | Prompt + function/entity/convention indexes | JSON: functions, entities, conventions, model suggestion | 8B | Qwen3-8B | med: ~5-20K | Decide whether this is legacy or supported; add invocation telemetry; align schema with Flash broker routing labels. |
| Conversation title generation | `desktop/src/components/ChatView.tsx` async `streamChat()` with trace source `title_generation` | Desktop interpreter model, default `deepseek/deepseek-v4-flash` | high | loose-medium | Short prompt with first user message | Short title | 0.5B or 1.5B | Qwen3-0.6B or Qwen3-1.7B | low: ~1-5K | Move to server-side component registry or at least structured trace/component; define title quality heuristic and rejection rules. |
| Agent state summary | `desktop/src/lib/agentStateSummary.ts` | `DEFAULT_INTERPRETER_MODEL` (`deepseek/deepseek-v4-flash`) via `streamChat()` | med-high | medium | Last few conversation messages | 1-2 sentence state summary | 1.5B | Qwen3-1.7B | med: ~5-20K | Component-level server telemetry exists only through generic chat stream; add summary-specific eval for entity retention and no invented state. |
| Conversation compaction summary | `desktop/src/lib/summarizer.ts` | Current agent model passed into summarizer, not a dedicated summary model | med | medium | Long conversation nearing context limit | Structured-ish conversation summary | 8B | Qwen3-8B | med: ~5-20K | Split from active agent model; capture source `conversation_summary` with component ID; eval against facts retained and compression ratio. |
| Legacy agent tool selection/function calling | `desktop/src/lib/agentLoop.ts` (`streamWithRetry()` sends tools to `/chat/stream`) | User/agent-selected model, default usually Flash | med-high, but appears superseded by server orchestrate for new chats | tight | Chat history + tool schemas | Tool call or assistant text | 8B | Qwen3-8B | high: ~20K+ if retained | Decide whether legacy loop remains production path; if retained, add per-tool-call eval and model registry. |
| Memory Wiki sync compiler | `apps/mcps/memory-wiki/index.ts` (`sync`) | Requested `openai/gpt-4o-mini` through `ultralight.ai()`; effective model depends runtime route | med | medium | Existing wiki page list + up to 20 raw notes | JSON creates/updates of typed wiki pages | 8B | Qwen3-8B | med: ~5-20K | Runtime `ultralight.ai()` needs component IDs and telemetry; replace ad hoc JSON parse with schema validation; collect human/accepted-page labels. |
| Memory Wiki lint checks | `apps/mcps/memory-wiki/index.ts` (`lint` contradiction and gap checks) | Requested `openai/gpt-4o-mini` through runtime route | low-med | loose | Wiki page snippets or page list | JSON contradictions/gaps | 1.5B | Qwen3-1.7B | low-med: ~1-20K | Add component names for contradiction vs gap; define precision-focused eval to avoid noisy false positives. |
| Fitness nutrition extraction | `apps/mcps/fitness-tracker/index.ts` (`log_meal`) | Requested `openai/gpt-4o-mini` through runtime route | high if app active | tight | Short meal description | JSON nutrition estimate | 1.5B | Qwen3-1.7B | med: ~5-20K | Need labeled nutrition baseline or accepted user corrections; component telemetry in runtime AI. |
| Email classification | `apps/mcps/email-ops/index.ts` (`receive_email`) and `apps/mcps/resort-manager/index.ts` (`email_process`) | Email Ops requests `google/gemini-3-flash-preview`; Resort Manager requests `openai/gpt-4o`; effective runtime route may differ | high if inbox automation active | tight | Email + business conventions + thread context | JSON classification, language, reply-needed, priority, knowledge gaps | 8B | Qwen3-8B | med-high: ~5-20K+ | Split classification from drafting where currently combined; use admin send/skip decisions as labels; runtime component telemetry. |
| Email translation | `apps/mcps/email-ops/index.ts` (`conversation_act` action `translate`) | Requested `google/gemini-3-flash-preview` through runtime route | med | tight | Single email body + translation instruction | Translation text | 8B | Qwen3-8B | med: ~5-20K | Keep as separate component only if translation volume justifies it; need language-pair quality eval. |
| Recipe suggestion JSON generator | `apps/mcps/recipe-box/index.ts` (`suggest`) | Requested `openai/gpt-4o-mini` through runtime route | med | medium | Ingredients/preferences | JSON recipe list | 8B | Qwen3-8B | low-med: ~1-20K | Capture accepted/saved suggestions; schema validation; not first fine-tune unless app has high usage. |
| Tweet/theme extraction | `apps/x-scrape/index.tsx` (`analyzeCollection`, `extractThemes`) | Requested `openai/gpt-4o` through runtime route | med | medium | Lists of tweet snippets | JSON summary/themes/sentiment | 8B | Qwen3-8B | med: ~5-20K | App uses BYOS Supabase and runtime AI; add component telemetry and robust JSON repair/retry. |
| Digest insight synthesis | `apps/mcps/digest/index.ts` (`synthesize`) | Requested `openai/gpt-4o` through runtime route | med | loose-medium | Batch of 15 undigested content snippets | JSON insight objects | 8B | Qwen3-8B | med: ~5-20K | Need approval/rejection labels from `review`; capture runtime prompts/outputs; eval source-index faithfulness. |
| Embedding-backed retrieval calls | `api/services/embedding.ts`, `apps/mcps/embeds/index.ts`, `apps/mcps/reading-list/index.ts`, `apps/mcps/digest/index.ts`, `apps/x-scrape/index.tsx`, `apps/ultravision/index.tsx` | Mostly `openai/text-embedding-3-small`, often via OpenRouter or `ultralight.ai()` | very high | tight | Text/query chunks | Vector embedding, not chat generation | N/A | Use an embedding model, not chat SFT | high if replacing | This is not a chat fine-tune candidate. Treat as a separate embedding model/vendor decision, with retrieval evals rather than instruction tuning. |

## 3. HEAVY TIER COMPONENT INVENTORY

| Component | Source location | Current model/provider | Volume | Latency | Input shape | Output shape | Student size | Base family / serving note | Data needed | Readiness blockers |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| Heavy codemode planner/recipe writer | `api/services/orchestrator.ts` (`callHeavyModel`, `buildCodemodeToolDef`) | Default Heavy `ultralight/deepseek-v4-pro` -> DeepSeek direct | high | medium | Flash-constructed prompt, app/function tool schema, optional multimodal files | Assistant text and/or `ul_codemode` tool call containing JavaScript recipe | 32B or 70B | Qwen3-32B first; Llama 3.3-70B or OpenPipe/Together catalog if 32B misses | high: ~20K+ | Already has LLM telemetry, but needs component-specific evals for valid recipe, safe tool args, execution success, and final user acceptance. |
| Tool Builder system agent | `desktop/src/lib/systemAgents.ts` (`tool_builder`), `api/services/orchestrator.ts` (`magnifyForSystemAgent`) | Same Flash/Heavy orchestrate stack, default Heavy Pro | med | loose-medium | User request + local/project context + app source/D1 schema | App-building plan, code, file writes, codemode actions | 70B | Llama 3.3-70B; future OpenPipe/Together if Cerebras catalog lacks best coding specialist | high, future candidate pending enough accepted build traces | Needs task outcome labels, code/test execution evals, and safety gates. Do not fine-tune first unless production build traces exist. |
| Tool Dealer / marketplace specialist | `desktop/src/lib/systemAgents.ts` (`tool_marketer`), orchestrator delegation path | Flash handles discovery widget for some paths; Heavy may handle broader marketplace reasoning | med | medium | Marketplace/catalog context + user need | Tool recommendations, gap reports, publishing/pricing guidance | 14B or 32B | Qwen3-14B/32B | med: ~5-20K | Some flows bypass Heavy with a widget; need define exact LLM responsibilities before tuning. |
| Platform Guide / platform manager | `desktop/src/lib/systemAgents.ts` (`platform_manager`) | Same Flash/Heavy stack, default Heavy Pro | low-med | medium | Platform settings/API key/billing context | Guidance and orchestration plan | 14B | Qwen3-14B | low-med: ~1-20K | Needs policy-safe answer corpus and escalation rules; likely not first due lower volume. |
| Memory Wiki Q&A synthesis | `apps/mcps/memory-wiki/index.ts` (`query`) | Requested `openai/gpt-4o-mini` through runtime route | med | medium | Relevant wiki pages + unsynced notes + question | Grounded answer with wiki links | 14B | Qwen3-14B | med: ~5-20K | Runtime telemetry; citation/faithfulness eval; train only after enough saved/accepted answers. |
| Memory Wiki composition/sync at high complexity | `apps/mcps/memory-wiki/index.ts` (`sync`) | Requested `openai/gpt-4o-mini` through runtime route | med | medium | Raw notes + existing page graph | Entity/page composition and updates | 14B | Qwen3-14B | med: ~5-20K | Same as Flash row; if 8B cannot maintain page graph quality, promote to 14B specialist. |
| Private Tutor quick-start extraction | `apps/mcps/study-coach/index.ts` (`quick_start`) | Requested `meta-llama/llama-4-scout` through runtime route | med | medium | Topic and/or file/image study material | JSON subject, concepts, summary | 14B | Qwen3-14B; OpenPipe/Together if multimodal needs dominate | med: ~5-20K | Multimodal file path complicates Cerebras-only serving; split text-only extraction from image/PDF frontier path. |
| Private Tutor adaptive quiz generation | `apps/mcps/study-coach/index.ts` (`quiz`, `start_quiz`, `pre_generate_quiz`) | Requested `meta-llama/llama-4-scout` through runtime route | med-high | medium | Concepts, course history, mastery, prior quiz context | JSON quiz questions/rubrics | 14B or 32B | Qwen3-14B first; Qwen3-32B if adaptive quality matters | high: ~20K+ if app active | Need item-quality evals, duplicate detection, difficulty calibration labels, and schema validation. |
| Private Tutor grading/fluency assessment | `apps/mcps/study-coach/index.ts` (`complete_quiz`) | Requested `meta-llama/llama-4-scout` through runtime route | med-high | medium | Student answers, rubric, MC performance, timing, history | JSON grades, feedback, fluency assessment | 14B or 32B | Qwen3-14B/32B | high: ~20K+ | Needs expert/human-validated grading set; high risk of subjective drift, so not first unless labels exist. |
| Private Tutor personalized lesson generation | `apps/mcps/study-coach/index.ts` (`generate_lesson`) | Requested `meta-llama/llama-4-scout` through runtime route | med | loose-medium | Course history + quiz results + misconceptions | 500-800 word lesson | 14B or 32B | Qwen3-14B/32B | med-high: ~5-20K+ | Needs quality rubric and learner feedback/engagement labels. |
| Email drafting and regeneration | `apps/mcps/email-ops/index.ts` (`receive_email`, `conversation_act`) and `apps/mcps/resort-manager/index.ts` (`email_process`) | Email Ops requests `google/gemini-3-flash-preview`; Resort Manager requests `openai/gpt-4o`; runtime route may override | high if deployed to inbox | tight-medium | Email/thread + business conventions + admin instruction | JSON or text draft, knowledge gaps | 14B | Qwen3-14B | high: ~20K+ | Split classification vs draft generation; use sent/edited versions as labels; preserve language matching; component telemetry in runtime. |
| Digest research analyst | `apps/mcps/digest/index.ts` (`synthesize`; newsletter composition is mostly deterministic over stored insights) | Requested `openai/gpt-4o` through runtime route | med | loose | Batch content snippets | JSON insight synthesis | 14B | Qwen3-14B | med: ~5-20K | Approval/rejection feedback exists conceptually in `review`, but capture needs to connect model output to later review decisions. |
| Story Builder handoff brief | `apps/mcps/story-builder/index.ts` (`get_context` narrative mode) | Requested `openai/gpt-4o-mini` through runtime route | low-med | loose | Structured world bible and recent scenes | Narrative handoff brief | 14B | Qwen3-14B | low-med: ~1-20K | Needs long-context consistency eval; not first unless Story Builder traffic is high. |
| Story Builder narrative generation | `apps/mcps/story-builder/index.ts` (`generate`) | Requested `openai/gpt-4o-mini` through runtime route | low-med | loose | World context, characters, arcs, lore, recent scenes | Creative scene/content | 32B or 70B | Llama 3.3-70B or curated creative-writing catalog | high, future candidate pending data | Subjective creative quality and long-term consistency make this a later fine-tune; need saves/edits/ratings as labels. |
| Resort/email operations agent | `apps/mcps/resort-manager/index.ts` (`email_process`) | Requested `openai/gpt-4o` through runtime route | med-high | tight-medium | Guest email + resort guidelines + availability/guest data | Classification, DB-change suggestions, reply draft | 14B or 32B | Qwen3-14B/32B | med-high: ~5-20K+ | Needs operational safety eval; DB-change suggestions should be separated from email drafting before tuning. |
| Cooking walkthrough tutor | `apps/mcps/recipe-box/index.ts` (`walkthrough`) | Requested `openai/gpt-4o-mini` through runtime route | med | loose | Recipe ingredients/steps/current step | Instructional cooking guidance | 14B | Qwen3-14B | low-med: ~1-20K | Not first unless volume is high; needs user helpfulness labels. |

## 4. FRONTIER-RETAINED COMPONENTS

I found few components that must remain frontier indefinitely. The better framing is "frontier fallback for out-of-distribution and safety-critical cases," not "frontier by default."

| Component/use case | Why retain frontier | Token-spend estimate |
| --- | --- | ---: |
| Open-ended Tool Builder work on arbitrary local repos | The system can inject local project files and ask for file writes. Novel repo architecture, security-sensitive changes, multi-file debugging, and unfamiliar frameworks are exactly where a 14B-70B specialist may fail silently. Keep a frontier fallback for high-risk project edits, new architecture, and failing eval confidence. | Assumption: 5-10% of total token spend if most routine app/tool work moves to specialist Heavy. |
| Multimodal/private tutor ingestion for images/PDFs | `study-coach` supports image/file quick-start. If Cerebras-served text specialists cannot see or parse images/PDFs directly, use a frontier or multimodal provider for OCR/visual reasoning, then hand text to a specialist. | Assumption: <5% unless image/PDF tutoring is a primary product path. |
| Creative narrative generation requiring high novelty and long consistency | `story-builder.generate` can be distilled later, but open-ended creative quality is subjective and label-poor. Keep frontier fallback for long-form or premium creative sessions until there is enough edit/acceptance data. | Assumption: <5% of total token spend unless Story Builder is heavily used. |
| Medical/health reasoning beyond simple logging | The code currently has nutrition estimation and fitness logging, not medical diagnosis. If future health-dashboard reasoning is added, keep frontier or human-reviewed fallback for clinical, medication, injury, or safety advice. | Current code evidence: near 0%; future-dependent. |
| Ambiguous cross-domain assistant chats with no component match | Direct general questions and requests outside installed-app data can be routed to Flash, but low-confidence or high-stakes unknown domains should escalate. | Assumption: 5-10% after routing matures. |

Estimated retained-frontier fraction: 10-20% of total LLM token spend, assuming core Flash routing, prompt construction, confirmations, email, tutor, wiki, and codemode loops are gradually distilled. This is an assumption because I did not find production token-spend distribution in the repo.

## 5. RECOMMENDED REFACTOR PRIORITY ORDER

1. **Add a component-aware LLM registry and client wrapper (L).**
   Create a single server-side entry point such as `callLlmComponent({ componentId, tier, messages, tools, responseFormat, requestedModel, route, telemetry, evalTags })` wrapping `fetchInferenceChatCompletion()` and `AIService.call()`. Preserve existing defaults by seeding registry entries for `flash_broker.analyze`, `flash_broker.prompt_builder`, `flash_broker.read_response`, `orchestrate.heavy`, `orchestrate.confirmation`, `runtime_ai.default`, and `chat_stream.default`. This unlocks model swapping, telemetry, eval replay, traffic splits, and fine-tuned endpoint rollout without touching every callsite later.

2. **Instrument untracked Flash and runtime calls (M/L).**
   Add `createLlmInvocationTelemetrySession()` around `callFlash()`, `callFlashText()`, `context-resolver.callFlashBroker()`, `RuntimeAIService.call()`, and `AIBinding.call()`. Include `component_id`, `tier`, app slug/function name for runtime calls, schema name, parse status, and teacher/baseline model. This closes the biggest training-data capture gap.

3. **Extend request contracts with component metadata without breaking callers (M).**
   Add optional fields to `AIRequest`, `ChatStreamRequest`, and runtime `ultralight.ai()` requests: `component`, `tier`, `task`, and `training_eligibility`. Default to current behavior when omitted. MCP apps can then migrate gradually.

4. **Externalize hard-coded MCP app model strings (M).**
   Replace direct `model: 'openai/gpt-4o-mini'`, `model: 'openai/gpt-4o'`, `AI_MODEL = 'google/gemini-3-flash-preview'`, and `AI_MODEL = 'meta-llama/llama-4-scout'` with component IDs or manifest-level defaults. Preserve the requested model as a fallback until the registry is populated.

5. **Standardize structured-output validation and retries (M).**
   For JSON tasks in Flash broker, memory wiki, email, digest, tutor, fitness, recipe, and x-scrape, use JSON schema/Zod-style validation with repair/retry metadata. Parse failures should become eval labels and training examples.

6. **Build component eval harness from capture exports (M/L).**
   Add `scripts/evals/` that reads `captureExportToJsonl()` output, reconstructs component requests from `llm_context_snapshots`, replays baseline and candidate endpoints, and reports component metrics. Start with router mode accuracy, app/action F1, JSON validity, recipe execution success, and human/admin acceptance.

7. **Add per-component traffic splitting and fallback policy (M).**
   Registry entries should support `baseline_model`, `candidate_model`, `shadow_percent`, `serve_percent`, `fallback_model`, and fail-open rules. This lets Cerebras/OpenPipe/Together endpoints ramp without code changes.

8. **Add privacy/redaction/training eligibility gates (M).**
   Capture artifacts already have `training_eligibility`; make component calls honor it. Add app/user opt-out, PII redaction hooks for email/wiki/tutor data, and export filters for trainable examples only.

9. **Create cost/latency dashboards by component (S/M).**
   `llm_invocations` already stores provider/model/duration/usage. Add component IDs and dashboards so fine-tune priorities can be driven by real spend, p50/p95 latency, error rate, and parse-failure rate.

10. **Add provider registry entries for Cerebras/OpenPipe/Together OpenAI-compatible endpoints (S/M).**
   The OpenAI-compatible surface is already there. Add configured providers/base URLs/model IDs and model capability metadata rather than introducing new request code.

## 6. SUGGESTED FIRST FINE-TUNES

### 1. Flash request analyzer/router (`flash_broker.analyze`)

- Why first: very high call volume, tight latency, and directly controls whether Heavy is invoked. Small improvements here multiply downstream savings.
- Data availability: production traces can be captured from every orchestrated chat once `callFlash()` is instrumented. Labels are available from teacher JSON, actual selected apps/actions, execution success, user follow-up corrections, and tool invocation outcomes.
- Eval harness:
  - Baseline: current DeepSeek V4 Flash output.
  - Metrics: JSON validity >= 99.5%; mode accuracy >= 97%; relevant app recall >= 95%; action-function F1 >= 90%; no increase in missing-tool delegation failures; p95 latency materially below baseline.
  - Ramp threshold: shadow for 10K calls, then 5% traffic if metrics meet threshold and failure buckets are manually reviewed.

### 2. Flash prompt constructor (`flash_broker.prompt_builder`)

- Why second: high-volume on write actions and determines Heavy prompt quality. A cheap specialist can shrink prompt-construction cost and reduce Heavy retries/failures.
- Data availability: teacher outputs are already structured JSON; execution success, plan parse success, and tool result quality can label examples.
- Eval harness:
  - Baseline: current DeepSeek V4 Flash prompt construction.
  - Metrics: JSON validity >= 99%; required function recall >= 95%; entity ID resolution accuracy >= 95%; downstream Heavy recipe valid/executable rate within 1-2 points of baseline; no increase in user-visible correction rate.
  - Ramp threshold: shadow on write-mode requests first, then ramp only for app-action classes with enough examples.

### 3. Heavy codemode planner/recipe writer (`orchestrate.heavy`)

- Why third: lower call volume than Flash, but highest per-call token/cost leverage. It is also the core Heavy-tier flywheel task.
- Data availability: `api/services/orchestrator.ts` already creates LLM invocation telemetry for Heavy; chat capture stores heavy recipes, plan-ready events, execution results, and tool invocation telemetry. This is the best-instrumented Heavy component today.
- Eval harness:
  - Baseline: current DeepSeek V4 Pro.
  - Metrics: valid `ul_codemode` tool call rate >= baseline; recipe parse success >= 99%; no forbidden API usage; tool execution success within 2 points of baseline; user confirmation/edit/retry rate not worse than baseline; cost at least 3x lower or latency at least 5x faster before production ramp.
  - Ramp threshold: begin with read-only or low-risk app actions, then graduate to write actions after human review of sampled recipes.

Not first despite being attractive: email drafting and Private Tutor grading. Both have high product value, but they need stronger human labels and safety/quality rubrics before production fine-tuning. Email classification, however, should become an early Flash candidate once component telemetry exists.

## 7. OPEN QUESTIONS

1. Which components are expected to run on Cerebras reserved capacity first: only core orchestration, or also MCP app `ultralight.ai()` calls?

2. Should runtime app authors be allowed to request arbitrary models, or should published apps declare component IDs that the platform maps to approved models?

3. What is the product policy for user data becoming training data: default opt-in, explicit opt-in, workspace-level opt-in, or only synthetic/teacher-labeled examples?

4. Is `api/services/context-resolver.ts` still a production path, or should it be treated as legacy and excluded from fine-tune investment?

5. Are new chats guaranteed to use server-side orchestration now, or does the legacy client `agentLoop` still receive meaningful production traffic?

6. What acceptance signal should be considered authoritative for codemode actions: execution success, no user correction, explicit user approval, app-state diff, or a later task-level score?

7. Should Flash specialists be trained per component (`analyze`, `prompt_builder`, `read_response`) or as one multitask Flash model with a task tag?

8. Which endpoint vendors are target-compatible beyond Cerebras: OpenPipe curated catalog, Together AI broader catalog, or both behind the same registry?

9. What are the safety boundaries for email/resort automation DB-change suggestions? Those should likely be separated from reply drafting before fine-tuning.

10. Do system-agent traces have enough volume to justify dedicated Heavy models, or should Tool Builder/Tool Dealer/Platform Guide initially share the core `orchestrate.heavy` specialist?
