# Galactic — Release Notes

Customer-facing, user-visible changes. Newest first. Always state money in dollars
(never internal "Light" units).

---

## Builder Milestone 1 — less context, less source retransmission

Galactic now gives coding agents three primitives designed to spend fewer
tokens while building and maintaining professional Agents:

- **Upload source once.** `gx.stage` creates an immutable, content-addressed
  `bundle_id`. The same bundle can be tested with `gx.test` and deployed with
  `gx.upload`, so a coding agent does not resend the complete project at every
  step. Later edits can stage only changed/new files and deletions. Reused
  content is refreshed safely, deduplicated, rate-limited, and admitted against
  an atomic owner storage quota before anything is written.
- **Orient from a compact Agent snapshot.** `gx.project` returns an owner-only
  coding capsule containing the current directive, function contracts, data
  schema, permissions, routines, model policy, recent failures, release state,
  and file hashes. Passing its prior `revision` returns only what changed.
  Source contents, secrets, stored application data, and full logs are excluded.
  Responses report the revision lease and the actual secret-free default model
  route, including whether a selected BYOK route is configured.
- **Ask models for typed data directly.** `galactic.ai({ output_schema })` uses
  provider-native strict JSON Schema, returns the parsed value as `output`, and
  verifies it before Agent code receives it. Galactic does not silently fall
  back to asking for JSON in prose.

Existing `files` workflows and the `ul.*` / `ultralight.*` aliases remain
supported. See [Builder Milestone 1](BUILDER_MILESTONE_1.md) for the complete
contracts and operational requirements.

---

## Launch — Free Mode + a lower inference threshold

**Free Mode keeps you working when your balance runs low.**
When your wallet balance falls below **$0.25**, Galactic automatically switches to
**Free Mode** — a no-spend, read-only way to keep using the platform without
surprise charges:

- **Free functions keep working.** Anything that doesn't charge you — free
  functions, your own Agents, and calls covered by a developer's free allowance —
  runs normally.
- **AI features use your own key.** Functions that use AI keep working **if you've
  connected your own model provider key (BYOK)** — that draws on your provider, not
  your Galactic balance. Without a BYOK key, AI functions are paused until you add
  funds.
- **Paid functions are paused, not surprising.** Anything that would charge you is
  hidden and won't run, so you're never billed unexpectedly while low.
- **Your agent is told what's happening.** Connected agents (e.g. Claude Code) see a
  clear note that Free Mode is active and that adding funds restores full access.

**Add funds from your wallet at any time to leave Free Mode and restore everything.**

**Lower platform-inference threshold: $0.50 → $0.25.**
The minimum balance to use **platform-billed** AI inference is now **$0.25** (down
from $0.50). You can start using AI with a smaller balance. This does **not** affect
**BYOK** inference, which needs no Galactic balance at all.

> Note for developers: nothing about your Agent's pricing, fees, or payouts changes.
> Free Mode only governs what a *low-balance caller* can run; your free-call
> allowances are still honored (those calls run, and you sponsor them as before).
