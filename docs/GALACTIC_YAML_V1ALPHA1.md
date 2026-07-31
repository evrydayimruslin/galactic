# `galactic.yaml` v1alpha1

Status: Galactic launch contract for TypeScript Agents.

Namespace:

```yaml
apiVersion: agents.connectgalactic.com/v1alpha1
kind: Agent
```

`galactic.yaml` is the portable, authored description of an Agent release. It
declares what the release exposes, what authority each function requests, which
endpoints and configuration it needs, and which cases Galactic must rehearse
before the release can be described as qualified.

It is intentionally only one part of the trust model:

1. **`galactic.yaml` is the Agent's promise.** It is authored and can be wrong.
2. **`gx.test` is evidence from a padded-room rehearsal.** It records what the
   exact tested release attempted on the declared cases, without allowing real
   external side effects.
3. **The live runtime is the security boundary.** A test only covers the paths
   it exercised. Runtime capability and destination gates must still prevent the
   release from exceeding its effective authority.

The honest user-facing claim is therefore bounded: an exact release passed its
required rehearsals, those rehearsals exercised a disclosed subset of its
functions and effects, and the runtime still constrains live execution. It is
not a universal claim that an Agent is safe.

## Source-of-truth rules

- The authored file must be named exactly `galactic.yaml` at the project root.
- Do not author `manifest.json` beside it. Galactic compiles `galactic.yaml`
  into the existing internal runtime manifest and rejects a source set
  containing both contracts.
- `gx.download({ app_id })` returns authored source, not the server-derived
  manifest.
- Qualification and upload must produce one self-contained prepared ESM
  executable. Every runtime dependency must be vendored into the submitted
  source and included in that executable. After preparation, the only module
  specifier that may remain is the literal `ultralight` platform runtime module;
  URL imports, bare package imports, other unresolved imports/exports/requires,
  and computed `import()` or `require()` targets fail closed as unbound runtime
  code.
- A project with no `galactic.yaml` may continue to use `manifest.json`. This is
  the legacy compatibility path and does not receive v1alpha1 basic conformance
  evidence.
- Server-rendered invitation and owner UI must derive the capability summary
  from the compiled manifest for the qualified `release_digest`, and the test
  summary from its signed qualification. Client-authored marketing copy is not
  evidence.

`metadata.parentReleaseDigest`, when present, identifies the immediate parent
release or fork claimed by the authored document. It is release lineage, not an
onboarding-session or handoff identifier. The compiler preserves the claim, but
it is not a verified reputation edge by itself. Invitation, discovery, and
reputation surfaces must use it only after server-side candidate admission has
resolved the digest and recorded a verified lineage relationship.

## Complete example

This example declares two functions but rehearses one. That is valid: the result
must disclose that only one of two functions was exercised. The Gmail credential
and endpoint are declared for setup and runtime enforcement; the launch `basic`
profile does not contact Gmail.

```yaml
apiVersion: agents.connectgalactic.com/v1alpha1
kind: Agent

metadata:
  name: Inbox Triage
  version: 1.0.0
  description: Proposes labels, then applies an approved label in Gmail.
  author: Example Publisher

spec:
  entry:
    functions: index.ts

  functions:
    proposeLabels:
      description: Propose labels from an inbox summary.
      parameters:
        summary:
          type: string
          required: true
          description: A credential-free fixture summary.
      returns:
        type: object
      authority:
        level: read
        effects:
          database.read: free
          inference.generate: ask
      spend:
        inference: ask

    applyLabel:
      description: Apply an owner-approved label to one Gmail message.
      parameters:
        message_id:
          type: string
          required: true
        label:
          type: string
          required: true
      returns:
        type: object
      authority:
        level: external_write
        effects:
          credential.http: ask

  network:
    allowed_destinations:
      - host: gmail.googleapis.com
        label: Gmail API
        description: Read message metadata and apply approved labels.

  env_vars:
    GMAIL_ACCESS_TOKEN:
      description: OAuth access token for the owner's Gmail account.
      required: true
      scope: per_user
      input: password
      credential:
        destination: gmail.googleapis.com
        inject:
          as: bearer
    DEFAULT_LABEL:
      description: Label proposed when no rule matches.
      required: false
      default: follow-up
      scope: universal
      input: text

  conformance:
    profile: basic
    cases:
      - id: propose-labels-basic
        function: proposeLabels
        input:
          summary: Three customer messages need replies this week.
        fixtures:
          env:
            DEFAULT_LABEL: follow-up
          database:
            responses:
              - method: select
                table: label_rules
                result:
                  - phrase: customer
                    label: follow-up
```

`required` is omitted in the example and therefore normalizes to `true`. Fixture
environment values are committed test data, not vaulted credentials. Never put a
real token or secret in `galactic.yaml`.

The exact semantic document above has the normative v1alpha1 `document_digest`
`63da3277d8b569fc68fab9bd6237e915f5237ac8d3c1d766f79d92cde24950a7`. Independent
implementations should reproduce it.

## Document schema

### Root and metadata

| Path                           | Required | Contract                                                                                                                                              |
| ------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiVersion`                   | yes      | Exactly `agents.connectgalactic.com/v1alpha1`                                                                                                         |
| `kind`                         | yes      | Exactly `Agent`                                                                                                                                       |
| `metadata.name`                | yes      | Non-empty Agent name                                                                                                                                  |
| `metadata.version`             | yes      | Non-empty release version; the compiled runtime manifest applies its normal version validation                                                        |
| `metadata.description`         | no       | Owner- and installer-facing summary                                                                                                                   |
| `metadata.author`              | no       | Publisher attribution                                                                                                                                 |
| `metadata.icon`                | no       | Icon reference accepted by the runtime manifest                                                                                                       |
| `metadata.parentReleaseDigest` | no       | Lowercase 64-character SHA-256 release digest                                                                                                         |
| `spec.functions`               | yes      | Function declarations keyed by exported function name; names start with an ASCII letter and contain at most 64 ASCII letters, numbers, or underscores |
| `spec.conformance`             | yes      | Named qualification profile and cases                                                                                                                 |

The following existing runtime-manifest sections may also be authored under
`spec`: `entry`, `operator_errors`, `access_policy`, `external_functions`,
`imports`, `emits`, `interfaces`, `widgets`, `context_sources`, `routines`,
`env_vars`, `http`, `rate_limit`, `network`, and `compute`.

Do not author derived fields such as top-level `permissions`, `flight_recorder`,
or function-level `uses_inference` and `uses_compute`. Galactic derives those
fields from authority and spend declarations, then runs the result through the
existing manifest validator.

Unrecognized standard fields fail closed. Namespaced `x-*` fields are the
extension mechanism at the root and supported schema objects; a vendor must not
occupy an unprefixed field. Authored extensions remain part of the normalized
document and therefore change `document_digest`.

### Functions, authority, and spend

Each `spec.functions.<name>` accepts the established function contract fields:
`description`, `parameters`, `returns`, `examples`, `annotations`,
`generation_hints`, and `execution`. `description` and `authority` are required.

Authority is function-scoped:

```yaml
authority:
  level: internal_write
  effects:
    storage.read: free
    storage.write: ask
```

`level` is the concise consequence class shown to a human:

- `read`: observes information without intentionally changing state.
- `internal_write`: changes state inside Galactic but does not intentionally
  change an external system.
- `external_write`: may change an external system or communicate externally.

`level` is a conservative summary, not an independent grant. It may be more
restrictive than the known effects, but it must never understate them. Generic
network calls, credentialed HTTP, managed email, notifications, events, and
Agent calls therefore require `external_write`; internal storage/database/memory
writes require at least `internal_write`.

The effect map is the more precise declaration. Each value is:

- `ask`: the authority must be called out for explicit owner approval during
  setup or activation before it is enabled.
- `free`: after installation and activation, the authority may operate under the
  owner's standing policy without another per-call prompt.

Neither value grants a capability by itself. Account configuration, setup,
runtime permissions, and destination gates may always narrow or deny it.

For the launch slice, `ask` and `free` are review/activation policy, not a
generic prompt injected before every SDK call. Deployment remains private and
`setup_required`, routines remain paused, and setup must obtain approval for
`ask` authority before explicit activation. Once enabled, the live runtime
enforces the same declared effect and destination ceiling for both policies.
Future runtimes may add finer-grained per-call approval without changing the
meaning of the authored ceiling.

Inference and compute spend are separate from the authority ordering:

```yaml
spend:
  inference: ask
  compute: free
```

`spend.inference` requires `inference.generate` or `inference.embed` in the same
function's effects. `spend.compute` requires `compute.execute`.

### Endpoints, credentials, and variables

Endpoint and credential needs use the established manifest vocabulary rather
than a second connection schema:

```yaml
spec:
  network:
    allowed_destinations:
      - host: api.example.com
        label: Example API
        description: Fetch records and apply approved changes.
      - host: imap.example.com:993
        label: Example IMAP

  env_vars:
    API_TOKEN:
      required: true
      scope: per_user
      input: password
      credential:
        destination: api.example.com
        inject:
          as: bearer
    ACCOUNT_ID:
      required: true
      scope: per_user
      input: text
```

- `network.allowed_destinations` is the outbound host allowlist. A destination
  is a bare hostname, an optional `*.` subdomain wildcard, and an optional
  port—never a scheme, path, or query.
- `env_vars` declares every variable name the Agent needs. Variables without a
  `credential` block are ordinary setup values.
- A credential binding identifies exactly where a vaulted value may be sent and
  how the parent runtime attaches it. Its `destination` must match a declared
  allowed destination.
- Supported credential injection forms are bearer, named header (with optional
  prefix), HTTP basic (with optional username variable), and named query
  parameter.
- Credential values are supplied during setup and remain outside authored
  source. Their names and delivery rules are part of the release contract.

In v1alpha1 these connection declarations are release-wide. Function-level
authority grants the `credential.http`, `email.imap.read`, or `email.smtp.send`
effect; it does not yet name a subset of credential keys. A function granted
`credential.http` may therefore select any configured HTTP credential, while
the host runtime still restricts every credential to its declared destination.
Function-to-connection references and provider-specific OAuth scopes are
deliberately outside the minimal core and may be added by a later standard
revision or a namespaced extension.

Managed IMAP and SMTP use ordinary `per_user` setup variables rather than the
HTTP-specific `credential.inject` block. The three variables for one connection
must share a protocol-specific prefix:

- `IMAP_HOST`, `IMAP_USER` (or `IMAP_USERNAME`), and `IMAP_PASS` (or
  `IMAP_PASSWORD`); or a shared prefix ending in `_IMAP`, such as
  `SUPPORT_IMAP_HOST`, `SUPPORT_IMAP_USER`, and `SUPPORT_IMAP_PASS`.
- The equivalent `SMTP_*` or shared `*_SMTP_*` names for SMTP.

Declare the resolved mail host, optionally with its port, in
`network.allowed_destinations`. Declare all three as `per_user`; the password
variable must use `input: password`, while host and username may use their
ordinary input types. At runtime Galactic resolves all three values host-side,
rejects a password that was exposed as ordinary configuration, rejects reuse of
an HTTP-bound credential, and refuses a host/port outside that release allowlist
before opening the socket. Secret values never enter the Agent isolate or
runtime diagnostics.

This lets an invitation say both “this Agent connects to Gmail” and “it needs
`GMAIL_ACCESS_TOKEN` for that endpoint” before the owner deploys it.

### Basic conformance cases

The only v1alpha1 profile is `basic`:

```yaml
conformance:
  profile: basic
  cases:
    - id: lookup-basic
      function: lookup
      input:
        query: example
      fixtures:
        env:
          MODE: test
        database:
          responses:
            - method: select
              table: records
              when:
                where:
                  status: active
              result: []
        http:
          - id: lookup-api
            kind: raw
            request:
              method: GET
              url: https://api.example.com/v1/records?status=active
            response:
              status: 200
              headers:
                content-type: application/json
              body_text: '{"records":[]}'
      required: true
```

Rules:

- Declare between 1 and 16 cases.
- Case IDs are unique, start with a letter, and contain at most 64 letters,
  numbers, `.`, `_`, or `-`.
- `function` must name a declared function.
- `input`, when present, is one args object.
- `required` defaults to `true`; at least one case must be required.
- `fixtures.env` is a string map. It is public test data and must never contain
  a real secret.
- `fixtures.database.responses` supports `select`, `first`, `count`, `insert`,
  `update`, `delete`, `upsert`, and `batch`. A response may constrain `table`
  and a deep-subset `when`; first match wins. Missing database fixtures fail the
  case rather than touching live data.
- `fixtures.http` is an ordered array of 1–32 exact entries:

  ```yaml
  fixtures:
    http:
      - id: gmail-list
        kind: credential
        credential_key: GMAIL_ACCESS_TOKEN
        request:
          method: GET
          url: https://gmail.googleapis.com/gmail/v1/users/me/messages
          # Optional: lowercase SHA-256 of the exact request-body bytes.
          body_sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        response:
          status: 200
          headers:
            content-type: application/json
          body_text: '{"messages":[{"id":"fixture-message"}]}'
  ```

  `id` is unique within the case, begins with a letter, and contains at most 64
  letters, numbers, `.`, `_`, or `-`. `kind` is `raw` for global `fetch` or
  `credential` for `galactic.fetch`; `credential_key` is required only for a
  credential fixture and names the declared credential without supplying its
  value. Credential fixtures require HTTPS.
- Matching normalizes the method to uppercase and serializes one absolute
  HTTP(S) URL with the WHATWG URL algorithm. It preserves query-parameter
  order, then compares method and the complete normalized URL exactly. A
  credential fixture additionally matches `credential_key`. Request headers
  are never match inputs. When `body_sha256` is present, Galactic compares it
  with the SHA-256 of the exact intercepted body bytes.
- Entries are considered in authored order and the first complete match wins.
  There are no regular expressions, templates, callbacks, provider rules, or
  live-network fallback.
- A fixture response has an integer `status` and an optional map of string
  `headers`, plus exactly one of UTF-8 `body_text` or canonical padded
  `body_base64`.
  Redirect statuses are forbidden. Status is otherwise 200–599 except 204 and
  205, which cannot carry the required body. Responses are bounded to 32
  headers, 32 KiB of aggregate header names and values, and a 1 MiB decoded
  body. Individual header names are at most 128 bytes and values at most 8 KiB;
  hop-by-hop, framing, and `Location` headers are rejected.
- Fixture URLs are at most 4 KiB and cannot contain user information,
  fragments, or ASCII controls. The normalized HTTP fixture configuration is
  at most 4 MiB. Each conformance-case invocation admits at most 32 intercepted
  HTTP attempts across raw and credentialed requests; every request body is
  bounded to 256 KiB whether or not `body_sha256` is present. Matched request
  bodies plus synthetic response headers and bodies share an 8 MiB
  invocation-local budget. An unmatched or over-budget request is recorded,
  blocked, and disqualifying even if Agent code catches the resulting error.

Legacy `manifest.json` tests receive the same matcher through
`gx.test({ ..., http_fixtures })` or an `http_fixtures` member in the
`test_fixture.json` envelope. New `galactic.yaml` releases declare fixtures
inside each case instead of passing them ad hoc.

## What `basic` qualification does

For a `galactic.yaml` release, `gx.test`:

1. admits and secret-scans the exact source set;
2. validates and compiles the document;
3. requires a successful strict build and zero lint errors;
4. executes every declared case in its own invocation-local test session;
5. records stable effect IDs before each supported operation;
6. compares every observed effect with the authority declaration for that case's
   function;
7. computes release and report identities; and
8. issues a signed `gxt2` attestation only when the release qualifies.

A release qualifies when every required case succeeds, no case observes an
undeclared effect, and no case attempts a blocked external effect. An ordinary
optional-case failure is reported as `optional_failed`; an authority violation
or blocked external attempt is disqualifying even in an optional case.

Coverage is deliberately literal:

- case counts say how many cases passed, how many were required, and how many
  optional cases failed;
- function counts say how many declared entrypoints were invoked;
- effect counts are function/effect declaration pairs that were or were not
  observed.

This is conformance coverage, not line, branch, or proof-of-all-inputs code
coverage. A declared but unobserved effect remains visible as **untested**. The
invitation projection uses bounded copy such as:

> Galactic basic test passed · all 2 required cases passed · 1 of 3 functions exercised

When optional cases fail, the summary calls that out explicitly, for example:

> Galactic basic test passed · all 2 required cases passed · 1 optional failed

It may also show exercised versus declared effect counts. It must not collapse
partial coverage into “safe” or “fully tested.”

Before the host seals that transcript, it drains every promise returned by a
runtime binding or outbound fetch. An Agent cannot make a write disappear from
qualification simply by starting it without `await`.

### Launch fixture boundary

The launch profile does not include full Gmail, Slack, or other provider
simulators. The padded room currently behaves as follows:

| Operation                | `gx.test` behavior                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------- |
| Agent storage and memory | Invocation-local, bounded in-memory state                                           |
| Structured database API  | Explicit canned responses from `fixtures.database`                                  |
| Inference and embeddings | Deterministic, zero-cost host stubs                                                 |
| Compute                  | Deterministic no-work host stub                                                     |
| Owner notification       | Recorded and acknowledged without creating a notification                           |
| Routine history          | Recorded and returns an empty test history                                          |
| Raw HTTP                 | Exact `kind: raw` fixture returns a canned response; unmatched requests are blocked |
| Credentialed HTTP        | Exact HTTPS credential fixture returns a canned response; no credential is exposed  |
| Raw TCP, IMAP, or SMTP   | Recorded, blocked, and disqualifying                                                |
| Event publication        | Recorded, blocked, and disqualifying                                                |
| Cross-Agent calls        | Recorded, blocked, and disqualifying                                                |

An exact HTTP fixture lets realistic code continue through one declared path
without any network request. It is not a Gmail, Slack, or webhook simulator and
does not reproduce OAuth, pagination, quotas, provider state transitions,
delivery, retries, or webhook semantics. Full provider behavior still requires
a safe post-credential connection check during setup. No fixture supports
regular expressions, templates, callbacks, or a “just try the live service”
fallback.

## Stable v1alpha1 effects

These 19 effect IDs are the public launch catalog:

| Effect                     | Meaning                                                   |
| -------------------------- | --------------------------------------------------------- |
| `storage.read`             | Read Agent storage                                        |
| `storage.write`            | Write Agent storage                                       |
| `storage.delete`           | Delete Agent storage                                      |
| `database.read`            | Read the structured Agent database                        |
| `database.write`           | Insert, update, delete, upsert, or batch database records |
| `memory.read`              | Read Agent- or user-scoped memory                         |
| `memory.write`             | Write Agent- or user-scoped memory                        |
| `routine.read`             | Read routine run history                                  |
| `notification.owner.write` | Create an owner notification                              |
| `inference.generate`       | Generate with an inference model                          |
| `inference.embed`          | Create embeddings                                         |
| `compute.execute`          | Start, inspect, or cancel disposable compute              |
| `network.http`             | Make a raw outbound HTTP request                          |
| `network.tcp`              | Reserved raw outbound TCP authority; no launch socket API |
| `credential.http`          | Make host-mediated HTTP with a vaulted credential         |
| `email.imap.read`          | Read mail through IMAP                                    |
| `email.smtp.send`          | Send mail through SMTP                                    |
| `event.publish`            | Publish an Agent event                                    |
| `agent.call`               | Call another Agent                                        |

Extension effects must use an `x-` prefix. A third-party runtime should publish
which stable and extension effects it records and enforces rather than imply
support for the entire catalog.

## Identity and signed evidence

The protocol keeps different identities separate:

| Identity                   | What changes it                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `source_hash`              | Any authored source path or exact decoded file bytes                                              |
| `document_digest`          | A semantic change to the normalized `galactic.yaml` document                                      |
| `prepared_artifact_digest` | Any named, server-prepared runtime artifact                                                       |
| `executable_digest`        | Any byte of the prepared ESM executable                                                           |
| `release_digest`           | Source, document, prepared artifacts, executable, compiler revision, or runtime-contract revision |
| `report_digest`            | Any field in the full basic-conformance report                                                    |

Normalization parses the restricted YAML document, materializes only the
specified v1alpha1 default (`required: true` where omitted), then serializes the
result with RFC 8785 JSON Canonicalization. Object properties use lexicographic
UTF-16 code-unit order; arrays retain authored order; strings use JSON escaping;
numbers use ECMAScript's finite-number serialization; and lone Unicode
surrogates are rejected. The SHA-256 digest is over those canonical UTF-8 bytes.
Comments and YAML mapping-key order do not change `document_digest`; a semantic
value change does. Implementations should use the examples and parser tests in
this repository as conformance vectors.

Named source-file and prepared-artifact sequences are also sorted by exact
UTF-16 code-unit order before hashing. Locale-aware collation is forbidden in
all v1alpha1/gxt2 digest inputs. Legacy V1 attestations and `gxb1_` staged
bundles retain their historical ordering so an upgrade cannot invalidate an
already-issued identity.

The signed v2 qualification binds the exact `source_hash`, `document_digest`,
`release_digest`, `report_digest`, compiler revision, runtime revision,
conformance-policy revision, and compact case/function/effect counts. The
compact case evidence records total passes and optional failures; a V2
qualification is invalid unless every required case passed and at least one
declared function was exercised. Raw inputs, fixture values, endpoint targets,
and case-level logs do not enter durable version metadata.

At upload, Galactic recompiles the exact source and rejects the attestation if
the compiler cannot reproduce its document and release digests. This closes the
“tested one artifact, deployed another” gap. A source author can still make a
false declaration, which is why observed behavior and live runtime enforcement
remain separate layers.

The replayable `gxt2` bearer is not stored. Instead, the version's platform
signature covers a canonical digest of the non-replayable persisted
qualification record and the SHA-256 hash of the exact retained ESM executable.
This makes later database mutation, proof substitution, and executable
substitution fail closed without retaining an upload credential.

New VersionTrust records use signature-envelope version 2. Its domain-separated
canonical HMAC covers both the complete VersionTrust payload and a protected
header containing the algorithm, signer, signing time, and key hint. A
trust-sensitive product or authorization surface must also bind that verified
record to the exact app ID, current version, and runtime; when `manifest_hash`
is present, it must reproduce that digest from the current compiled manifest.
This prevents a valid record from being transplanted to another release or
paired with a changed manifest. Historical envelopes remain verifiable for
payload compatibility, but their signer, signing time, and key-hint fields were
not authenticated. Those legacy header values must not be displayed or consumed
as signed provenance.

The qualification-record digest is a V2-only marker. Legacy V1 test evidence
does not have a signed proof digest and is therefore historical-only: Galactic
may retain and display it in raw release history, but it cannot make a release
an invitation candidate, satisfy a trust-sensitive project projection, or
authorize guarded promotion. Removing or rewriting a V2 marker invalidates the
platform signature; rewriting a V2 proof fails its signed digest check.

Promotion repeats the release check before any migration or live-pointer write:
Galactic reloads the authored source, runs the current strict compiler, requires
current compiler/runtime/policy revisions, reproduces `release_digest`, and
byte-checks the retained R2 files, interface artifacts, and versioned executable.
The verified compiler result is then the single promotion snapshot used for the
manifest, migrations, exports, and executable; those inputs are not reread after
qualification. A V2 release never uses the legacy “rebuild whatever source
remains” fallback. If any retained byte is missing or changed, the owner must
test and upload the exact release again.

Documentation and semantic-index generation may derive Skills content from the
release, but it may not regenerate a `galactic.yaml` release's compiled
`manifest.json`. If the authored document or compiled manifest cannot be read
and validated, generation fails closed before changing either the stored
manifest or its database projection.

## Parser and resource limits

`galactic.yaml` is a restricted, JSON-compatible YAML 1.2 core document:

- maximum UTF-8 size: 128 KiB;
- exactly one YAML document;
- maximum nesting depth: 32;
- maximum YAML nodes: 10,000;
- mapping keys must be strings;
- duplicate keys, aliases, anchors, merge keys, and explicit tags are rejected;
- non-finite numbers, lone Unicode surrogates, and unsupported scalar types are
  rejected; and
- unknown unprefixed schema fields are rejected.

These restrictions make independent parsing and stable digest reproduction
tractable. They are part of the contract, not an implementation suggestion.

## Legacy compatibility

Existing `manifest.json` Agents remain valid and use the established
single-function `gx.test` behavior and V1 test attestation. V1 results are
diagnostic and historical only; because their proof body was not bound into
signed release trust, they cannot qualify a new invitation candidate or satisfy
a guarded promotion. Agents can migrate by moving the authored manifest fields
under `metadata` and `spec`, replacing authored aggregate permissions with
function-scoped `authority` and `spend`, and declaring one or more `basic`
cases.

Migration must be explicit. Galactic never guesses authority from source code
and never treats generated declarations as proof of behavior.
