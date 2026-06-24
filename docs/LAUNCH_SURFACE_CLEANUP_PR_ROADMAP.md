# Launch Surface Cleanup — PR Roadmap

Status: proposed (2026-06-22). Scope: tighten the agent-facing MCP surface for launch.
Owner actions only where noted. All PRs are backward-compatible (no breaking changes at
launch); old names keep working via the existing alias + `PLATFORM_MCP_DISABLED_ALIASES`
machinery.

## Decisions (no-code or framing)

### D1 — KEEP the per-agent "Add direct to agent" button. Do not remove it.
The per-agent button (`buildToolInstallContext`, api/handlers/launch.ts:4716-4798;
`AddAgentConnectButton`, apps/launch-web/src/pages/foundation-pages.tsx:1185-1228) is
**strictly better** than the platform connection for the single-agent case, and a runtime
tool cannot replicate it:

- It installs the agent's own `/mcp/{id}` endpoint as a standalone MCP server, so the
  agent's functions appear as **native, typed MCP tools** in the host agent (Claude Code /
  OpenClaw) — not behind the generic `ul.call(app_id, function_name, args)` envelope. Better
  tool-selection and arg-construction reliability for the host LLM.
- It mints a key **scoped to that one app** (`scopes:["apps:call"], appIds:[id]`,
  launch.ts:4787-4790) — least privilege, vs the platform key's full capability.
- It bypasses the platform tool manifest entirely (per-app `/mcp/{id}` serves the app's
  manifest functions + SDK tools; see api/handlers/mcp.ts), so the PR2 manifest trim does
  not affect it.

The two connection modes are complementary and both should be offered:
- **Platform** (`/mcp/platform`): broad — discover/call/build across the whole library with
  one full-capability key. For a power agent that orchestrates many apps.
- **Per-agent** (`/mcp/{id}`): narrow — one agent as native typed tools, scoped key. For
  "I just want my OpenClaw agent to run Email-ops."

Optional micro-polish (not required): on the platform install copy, add one line clarifying
"for a single agent, use 'Add direct to agent' on its page for native tools + a scoped key."

### D2 — DROP `ul.wire`. Do not build it.
For the external-agent case it is redundant: the per-agent button already gives the best
possible integration (native tools), and `ul.call` already reaches every app once the
platform MCP is connected — no wiring step needed. A tool call cannot rewrite the host's MCP
config, so `ul.wire` cannot do what the button does anyway. The only non-redundant value
(intra-platform agent→agent semantic wiring) already belongs to `ul.grants`; if a one-shot
"discover + propose grant" verb is ever wanted, add it as `ul.grants({action:"wire"})`, not a
new top-level tool.

---

## PR sequence & dependencies

```
PR1 (ul.secrets rename) ──► PR2 (manifest trim)      [PR2 decides if ul.secrets is core]
PR3 (ai fan-out hardening)   — independent
PR4 (honest versioning)      — independent
```
Land order: PR1 → PR2; PR3 and PR4 anytime (parallel).

---

## PR1 — Rename `ul.connect` → `ul.secrets` (and fold `ul.connections`)

**Goal.** Stop the misleading "connect" verb (an LLM reaches for `ul.connect` to wire to
another agent — exactly wrong). Canonical name becomes `ul.secrets`. Fold the read/list tool
in, so two tools become one.

**Files / anchors.**
- Tool defs: api/handlers/platform-mcp.ts:2487 (`ul.connect`), :2513 (`ul.connections`).
- Dispatch (already alias-style + `logAliasUsage`): platform-mcp.ts:4836-4842.
- Handlers (unchanged): `executeConnect` (:11719), `executeConnections` (:11893).
- Deprecation map: docs/PLATFORM_MCP_ALIAS_DEPRECATION_MAP.md:40-41.
- Docs/copy: skills.md, cli/skills.md, README.md, docs/PLATFORM-MCP-CLI-DESIGN.md.

**Changes.**
1. Add one `ul.secrets` entry to `PLATFORM_TOOLS` (replacing the `ul.connect` + `ul.connections`
   entries). Schema: `{ app_id?, secrets? }`. Semantics: `secrets` present → set/remove
   (`executeConnect`); only `app_id` → inspect one app (`executeConnections`); no args → list
   connected apps (`executeConnections`). Description: "Save or inspect your per-user
   credentials/secrets for an installed app."
2. Add `case "ul.secrets":` to the main `tools/call` switch routing on presence of `secrets`
   to `executeConnect`/`executeConnections`. No handler-body changes.
3. Keep `ul.connect` and `ul.connections` cases verbatim in the alias block (already
   `logAliasUsage`) so copied install prompts and 90-day keys keep working.
4. Remove `ul.connect`/`ul.connections` from `PLATFORM_TOOLS` so `tools/list` advertises only
   `ul.secrets`.
5. Update the deprecation map canonical column → `ul.secrets`; update docs/CLI/README.

**Backward compat.** Old names still callable (alias block); retire later via
`PLATFORM_MCP_DISABLED_ALIASES` once telemetry goes quiet. No breaking change.

**Tests.** Add to platform-mcp tests: `ul.secrets` set/inspect/list parity with old tools;
`ul.connect`/`ul.connections` still dispatch + log alias usage; `tools/list` no longer
contains the old names but contains `ul.secrets`.

**Risk / size.** Low / ~half day. `tools/list` net −1 tool.

---

## PR2 — Trim the platform `tools/list` to a launch core + progressive disclosure

**Goal.** Cut the always-loaded platform manifest from ~20 tools (post-PR1) to a tight core
(~10), keeping everything callable by name. Reduces context cost (~6–10k tokens today) and
wrong-tool selection for external agents, reversibly.

**Files / anchors.**
- Single chokepoint: `getPlatformTools()` (platform-mcp.ts:2894) → `handleToolsList` (:3978).
- Env idiom to mirror: `PLATFORM_MCP_DISABLED_ALIASES` (:4050), `getEnv` (already imported).
- Provisional check to reuse for `ul.auth.link`: inverse of the memory block (~:4853).
- `ul.discover` scopes: executeDiscover* (~:4058-4092).

**Changes.**
1. Add a lite filter branch to `getPlatformTools()` gated on a new env var
   (`PLATFORM_MCP_LITE`, default ON for launch). When on, return only the CORE set.
2. **CORE advertised (10):** `ul.discover`, `ul.call`, `ul.job`, `ul.upload`, `ul.test`,
   `ul.set`, `ul.memory`, `ul.secrets`, `ul.grants`, `ul.codemode`.
   - `ul.job` must stay if `ul.call` stays (only way to read async results).
   - `ul.grants` stays = cross-agent spine (a launch priority).
   - Swing votes (keep or demote per launch positioning): `ul.codemode` (advanced
     orchestration), and `ul.command` (agentic interfaces — demote unless interfaces are a
     launch headline).
3. **DEMOTE to call-only (still in `tools/call`):** `ul.download`, `ul.command`, `ul.routine`,
   `ul.emit`, `ul.permissions`, `ul.logs`, `ul.rate`, `ul.marketplace`, `ul.wallet`.
4. `ul.auth.link`: advertise **only to provisional sessions** (it is provisional-only anyway);
   hide for authenticated bearer-key agents.
5. Progressive disclosure: add `scope:"tools"` to `ul.discover` that lists the demoted tool
   names + one-line descriptions, so an agent can find and call them by name. Add one line to
   the `initialize` response (~:3241) pointing to it.
6. Slim the fat schemas (token win without capability loss): trim verbose per-action prose on
   `ul.command` (~12 actions/30 props), `ul.routine` (~10/23), `ul.marketplace`, `ul.wallet`,
   `ul.set`.

**Backward compat.** No execution-path change: all handlers + the `tools/call` switch stay
intact, so every demoted tool remains callable by name. Env flag makes the whole thing
reversible at deploy.

**Tests.** Smoke assertion on the lite manifest (exact CORE set) so cuts can't silently
regress; assert a demoted tool (e.g. `ul.marketplace`) still executes by name; assert
`ul.discover({scope:"tools"})` lists the demoted names; assert `ul.auth.link` advertised only
for provisional.

**Risk / size.** Medium / ~1–1.5 days. Main risk = cutting a tool an agent needs; mitigated
by progressive disclosure + reversible flag + smoke. Note: does **not** affect per-agent
`/mcp/{id}` connections (D1).

---

## PR3 — Fan-out "good enough" hardening (NOT the helper)

**Goal.** Make `ultralight.ai()` fan-out safe and honest for launch without building a
`ul.ai.fanout` primitive (deferred). Ship three small things.

**Files / anchors.**
- Path-specific `tools` drop: in-process path forwards tools (api/services/ai.ts:132); the
  dynamic-worker/codemode binding drops them — local `AIRequest` has no `tools`
  (api/src/bindings/ai-binding.ts:41-46), body hardcodes `{model,messages,max_tokens,
  temperature}` (~:162-172), response returns only `content` (~:240).
- SDK doc: docs/IN-APP-SDK-DESIGN.md (only shows `ultralight.ai({messages})`, never `tools`).

**Changes.**
1. **Correctness (must-fix):** make `tools` behavior consistent across executors. For launch,
   **reject loudly** in the binding path when `tools` is present (clear error: "tool-calling
   in ultralight.ai() is not supported on this runtime"), OR drop `tools` from the public
   `AIRequest` type so it's never advertised. Do **not** plumb full tool-calling (multi-day,
   touches billing/streaming) — out of launch scope.
2. **Docs:** add a fan-out section to IN-APP-SDK-DESIGN.md with the canonical `Promise.all`
   best-of-N snippet and the real ceilings: subrequests apps 512 / codemode 128 (flagged
   *unverified pending staging smoke*), wall-clock 30s default / 120s max, balance gate
   pre-call + fail-open, no mid-flight abort. State plainly it is NOT bound by the 20-fetch
   sandbox cap.
3. **Example:** one app under examples/ that fans out 3 `ai()` calls and fuses
   (copy-pasteable). Currently zero reference exists.

**Defer.** `ul.ai.fanout` best-of-N helper → fast-follow, only if usage shows repeated
reimplementation, and only after the staging smoke confirms the subrequest ceiling (so the
N-cap/abort design isn't built on sand). Revisit if "consult-many-models-and-fuse" becomes a
marketed launch headline — then the helper is the one safe choke point and should ship.

**Tests.** `ai({tools})` returns a clear error (or the field is gone) on the binding path;
in-process behavior unchanged; example app smoke-runs.

**Risk / size.** Low / ~half day (mostly docs + example; ~10-line code fix).

---

## PR4 — Honest versioning (de-hardcode `1.0.0`)

**Goal.** Make app versions truthful. Re-uploads already auto-bump
(`bumpVersion(app.current_version)`, platform-mcp.ts:6296), so this is a narrow consistency +
GPU fix, not a rework.

**Files / anchors.**
- `bumpVersion` (works): platform-mcp.ts:6227.
- GPU new-app hardcode (bug): platform-mcp.ts:7131 (`const version = "1.0.0"`, ignores
  manifest).
- New-app defaults: upload-pipeline.ts:212, :554, :609; upload.ts:466/618/709/750/913/1803.

**Changes.**
1. GPU new-app path: derive `version = manifest?.version || "1.0.0"` (mirror the Deno path)
   instead of hardcoding.
2. Normalize the new-app default to a single helper so Deno/GPU/pipeline agree
   (`manifest?.version || "1.0.0"`).
3. Ensure the upload response and `version_metadata` report the actual resolved version
   (incl. the auto-bumped value on re-upload) so the draft→`ul.set` promote story is honest.
4. Optional: when `manifest.version` is set on a re-upload, prefer it (already supported via
   `bumpVersion(current, explicit)`); document precedence (explicit manifest > auto patch
   bump).

**Backward compat.** No storage-key change; existing apps keep their versions. Auto-bump
already prevents R2 path collisions for re-uploads.

**Tests.** GPU new-app picks up `manifest.version`; re-upload bumps patch and reports it;
new app without manifest version still defaults to 1.0.0.

**Risk / size.** Low / ~half day.

---

## Launch assessment

These five items are **launch-surface hygiene + one correctness fix**, not blocker-clearing
features. They make the first thing an external agent sees — the tool manifest and the connect
flow — cleaner, smaller, better-named, and behaviorally honest. That improves tool-selection
reliability, lowers per-call context cost, and removes the `ul.connect` foot-gun and the
silent `tools`-drop. Real, but incremental.

What this batch does **not** touch (and what still gates a confident launch), from prior
audits:
- The flagged platform-handler `ul.call` caller-context question (is the cross-agent call
  grant-gated, or does it forward the user bearer?) — verify before leaning on the cross-agent
  story.
- The unverified subrequest ceiling — run the staging smoke (PR3 docs depend on it for honest
  numbers).
- Balance gate fail-open — economic-integrity edge.

The heavier launch blockers from the MVP readiness register (credit acquisition, a real deploy
path, E2E smoke) appear largely addressed by recent Track A–E work (top-up + Stripe Link,
interface deploy smoke + CI, Stripe Connect publish gate). Against that more-complete base,
this batch is the right *polish* layer: it raises the "does this feel finished and trustworthy
when my agent connects" bar, which is exactly the launch impression. Net: **moves the needle on
launch-readiness (medium-high confidence), primarily on trust/clarity, with the remaining true
gates being verification (caller-context, staging smoke), not new build.**
