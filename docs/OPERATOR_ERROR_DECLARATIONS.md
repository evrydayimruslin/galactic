# Operator-safe error declarations

Agent code owns domain context; Galactic owns operator diagnosis and
remediation. `manifest.json` can declare safe metadata for stable errors your
code throws, so the owner sees useful guidance instead of raw exception prose.

```json
{
  "operator_errors": {
    "UPSTREAM_TIMEOUT": {
      "summary": "The configured upstream service did not respond.",
      "detail": "Review the failed run and verify the service connection before running once.",
      "retryable": true,
      "suggested_actions": [
        "inspect_run",
        "open_logs",
        "open_routine"
      ]
    }
  }
}
```

Throw the matching stable code from Agent code:

```ts
const error = new Error("request timed out");
error.name = "UPSTREAM_TIMEOUT";
throw error;
```

## Contract

- Codes are 1–80 uppercase letters, numbers, or underscores and start with a
  letter.
- `summary` is required and limited to 240 characters.
- `detail` is optional and limited to 2,000 characters.
- `retryable` says whether the same operation may succeed after the cause is
  fixed. It does not trigger a retry or resume work.
- `suggested_actions` may contain only `inspect_run`, `open_logs`, and
  `open_routine`. A hint only prioritizes navigation Galactic already knows is
  safe and available.
- Keep all text operator-safe: no secret values, tokens, credentials, raw
  request/response bodies, personal data, or stack traces.

The runtime matches declarations only to developer-code failures. Platform and
provider failures keep their platform diagnosis. All declared text passes
through runtime secret redaction before persistence and projection.

## Galactic-owned controls

Galactic derives current conditions and creates controls from trusted entity
IDs. It automatically supplies applicable standard controls:

- **View failed run**
- **Open logs** (bounded, redacted, owner-scoped)
- **Open routine**
- **Run once** (real work, usage, and possible side effects)

A manifest cannot declare a URL, route, entity ID, button label, authority
level, approval, payment, secret mutation, `Run once`, resume action, or any
other executable remediation. Unknown declaration fields are rejected.

Developers improve the diagnosis; they do not construct privileged buttons.
After a fix, `Run once` verifies real routine behavior while leaving scheduled
execution paused. A successful run can recover the incident, but the owner still
explicitly resumes the schedule.

## Client parity

The web, `gx.attention`, MCP clients (including Codex, Claude Code, and Cursor),
and `galactic attention` receive the same canonical diagnosis and typed
remediation objects. Clients render semantic targets for their surface and must
never infer actions from error prose.
