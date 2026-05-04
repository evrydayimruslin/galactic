# GPU Compute Runtime — Full Architecture & Implementation Plan

## Context

Ultralight is a marketplace where developers deploy functions as callable MCP tools. Currently CPU-only via Deno sandbox. We're adding GPU compute as a parallel runtime so developers can publish GPU-native functions (3D rendering, physics simulations, video processing, scientific computing, cryptographic proofs) alongside existing Deno functions. The marketplace mechanics (discovery, micropayments, escrow acquisition) are compute-agnostic and require minimal changes.

---

## Core Architecture Decisions

### Philosophy

- **GPU compute as capability primitive, not infrastructure primitive.** Developers think about functions, not instances. They manage logic, not scaling. They set a price, not build billing.
- **GPU functions are broader than AI.** Primary use cases: 3D rendering, physics simulations, video processing, scientific computing, cryptographic proofs. AI inference on standard models handled by existing `ultralight.ai()` with OpenRouter/BYOK.
- **The marketplace creates a spot market for GPU-native IP.** Per-call revenue while you hold a function, clean sale via escrow when someone wants to own it outright.

### Provider Strategy

- **MVP:** RunPod Serverless. Per-second billing (rounded up), 10-13x markup. Zero idle cost.
- **Growth:** RunPod Active Workers (reserved, 20-30% discount) for high-traffic functions.
- **Scale:** Colocation only at 50+ GPUs, >80% utilization (Series B+ decision).
- **Provider abstraction interface** for future multi-provider support.

### Rate Table (All-in Per-ms, 10-13x Markup)

| GPU | VRAM | RunPod Cost/ms | Platform Rate/ms | Markup |
|-----|------|---------------|-----------------|--------|
| A40 | 48GB | $0.0000001 | $0.000001 | ~10x |
| L40 / RTX 6000 Ada | 48GB | $0.0000002 | $0.000002 | ~10x |
| L40S | 48GB | $0.00000022 | $0.0000022 | ~10x |
| A100 PCIe | 80GB | $0.00000033 | $0.000004 | ~12x |
| A100 SXM | 80GB | $0.00000039 | $0.000005 | ~13x |
| H100 PCIe | 80GB | $0.00000055 | $0.000007 | ~13x |
| H100 SXM | 80GB | $0.00000075 | $0.000009 | ~12x |
| H100 NVL | 94GB | $0.00000072 | $0.000009 | ~12x |
| H200 | 141GB | $0.0000010 | $0.000012 | ~12x |
| B200 | 180GB | $0.0000017 | $0.000020 | ~12x |

### Upload & Packaging

- Small code packages within existing file/request size guardrails (50MB upload, 10MB per file); storage thresholds are soft billing caps.
- Developer uploads: `main.py` + `requirements.txt` + `ultralight.gpu.yaml` + `test_fixture.json`.
- No weight hosting. Pure code. AI model weights stored externally by developer if needed (minority case).

### Config File

```yaml
runtime: gpu
gpu_type: A100-80GB-SXM
python: "3.11"
max_duration_ms: 2000
```

### GPU Selection

- Explicit via `gpu_type` (Option B with guardrails).
- Platform suggests cheaper GPU if benchmark shows VRAM over-provisioning.

### Container Building

- Base image layer caching: pre-built `python+cuda+torch` images. Developer code layered on top.
- Build time ~45s for common case.
- Container harness (Python wrapper) injected at build time for structured error reporting.

### Async Benchmark

- Upload returns immediately with `gpu_status: 'building'`.
- Background job builds container, runs benchmark (5 runs), computes mean/stddev/variance.
- Function goes live when benchmark passes.
- State machine: `building -> benchmarking -> live | build_failed | benchmark_failed`
- Regression detection on version update: adaptive threshold `max(20%, variance_pct * 1.5)`.
- Developer can acknowledge regression and publish anyway.

### max_duration_ms Suggestion

- Formula: `max(benchmark_p95 * 2.0, benchmark_median * 3.0, 1000)`
- Three options: Conservative (1.4x), Recommended (2x), Generous (4x).

### Developer Pricing (Three Primitives)

1. **Per-call flat fee:** Developer sets price, caller knows cost upfront. Self-metering (platform measures).
2. **Per-unit pricing:** Developer sets price per unit, platform counts units via `unit_count_from` JSONPath on input payload.
3. **Per-duration developer fee:** Developer sets an optional fee per billed second and/or flat markup. Requires `max_duration_ms` ceiling.

### Billing & Settlement

- Caller pays: GPU compute cost + developer fee = total.
- GPU compute is always charged as platform pass-through: provider execution time plus provider-reported queue/cold-start delay, rounded to the billing increment.
- Developer earns: developer fee x 0.90 (10% platform fee).
- Platform earns: developer fee x 0.10 + GPU compute margin.
- Before settlement, caller balance is checked against the full actual charge. Compute is debited before developer fee transfer so Ultralight does not pay provider GPU costs without collecting the pass-through.
- Egress absorbed for MVP.

### Failure Policy

**Chargeable** (real GPU resources consumed):
- OOM, unhandled exception, timeout
- Charge actual compute cost. Refund developer fee.

**Non-chargeable** (platform responsibility):
- Container failed to start, network error, validation error
- Full refund.

**Partial results** (batch processing):
- Return completed units, charge proportionally.

### Concurrency Limits

- Per-function, enforced at gateway.
- Over limit: 5s queue -> 429 with `Retry-After` + `X-Queue-Position` + `X-Estimated-Wait-Ms`.

| Tier | Default | Max Configurable |
|------|---------|-----------------|
| Pro | 5 | 20 |
| Scale | 20 | 100 |
| Enterprise | 50 | 500 |

### Warm Pool Strategy

- **Phase 1 (launch):** Pure serverless. Zero idle cost.
- **Phase 2 (data-driven):** Active Workers for functions with >100 calls/hour.
- **Phase 3 (scale):** Reserved capacity for predictable baseline load.
- Always platform-funded, never developer-funded.

### Marketplace Integration

- Existing escrow/sale mechanics are compute-agnostic.
- Transparent listing: developer fee + estimated compute + reliability indicator.
- `weights_included` attribute for acquisitions.
- Reliability: rolling 7-day, green >=99%, yellow >=95%, red <95%.

---

## Execution Flow

```
1. Agent calls GPU function via MCP/HTTP
2. Gateway: auth + balance check + lock estimated cost
3. Concurrency check: under limit -> proceed; over -> 5s queue -> 429
4. Scheduler: warm container -> route; cold -> RunPod Serverless (3-8s)
5. Execution: isolated GPU container with harness
6. Settlement: actual cost deducted, developer credited, excess released
```

---

## Implementation Phases

### Phase 1 (Weeks 1-2): RunPod Integration + GPU Provider Abstraction

**New files:**
- `api/services/gpu/types.ts` — GpuType enum, rate table, all GPU types
- `api/services/gpu/provider.ts` — GPUProvider interface
- `api/services/gpu/runpod.ts` — RunPod Serverless implementation
- `api/services/gpu/index.ts` — Factory/exports

**Modified files:**
- `shared/types/index.ts` — App interface with GPU fields
- `.do/app.yaml` — RUNPOD_API_KEY env var

**Migration:** `migration-gpu-phase1.sql` — GPU columns on apps, gpu_endpoints table, gpu_rate_table

### Phase 2 (Weeks 3-4): Container Builder + Benchmark System

**New files:**
- `api/services/gpu/builder.ts` — Container build service
- `api/services/gpu/benchmark.ts` — Benchmark system (5 runs, stats, regression detection)
- `api/services/gpu/build-processor.ts` — Background job (15s interval)

**Modified files:**
- `api/main.ts` — Start GPU build processor job
- `api/handlers/upload.ts` — GPU upload branching (detect ultralight.gpu.yaml)

**Migration:** `migration-gpu-phase2.sql` — gpu_benchmark_runs, gpu_build_events tables

### Phase 3 (Weeks 5-6): GPU Routing + Billing + Failure Handling

**New files:**
- `api/services/gpu/executor.ts` — executeOnGpu() dispatcher
- `api/services/gpu/concurrency.ts` — Per-function concurrency limiter
- `api/services/gpu/harness.py` — Python container harness
- `api/services/gpu/billing.ts` — Cost computation and settlement

**Modified files:**
- `api/handlers/mcp.ts` — Runtime branching at line 1667
- `api/handlers/run.ts` — Same runtime branch
- `api/handlers/http.ts` — Same runtime branch
- `api/services/call-logger.ts` — GPU metering columns

**Migration:** `migration-gpu-phase3.sql` — Call log GPU columns, balance lock/settle RPCs, concurrency tracking

### Phase 4 (Weeks 7-8): Marketplace Integration + Developer Pricing

**New files:**
- `api/services/gpu/pricing.ts` — Three pricing primitives
- `api/services/gpu/reliability.ts` — Rolling reliability metrics

**Modified files:**
- `shared/types/index.ts` — GpuPricingConfig in AppPricingConfig
- `api/services/marketplace.ts` — GPU marketplace display
- `api/handlers/discover.ts` — Runtime filter
- `api/handlers/mcp.ts` — GPU annotations on tool listings
- `api/services/hosting-billing.ts` — Reliability view refresh

**Migration:** `migration-gpu-phase4.sql` — weights_included, gpu_reliability_7d materialized view

### Phase 5: MCP Upload + Discovery Runtime Metadata

**Modified files:**
- `api/handlers/platform-mcp.ts` — `executeUpload()` GPU branch (detect `ultralight.gpu.yaml`, skip esbuild, fire-and-forget build), `executeDiscoverAppstore()` and `executeDiscoverLibrary()` return `runtime` + `gpu_type`
- `api/handlers/upload.ts` — Export `generateSlug()` for MCP reuse

**No migration needed.**

---

## Complete Inventory

**17 new files:** 13 TypeScript services, 1 Python harness, 4 SQL migrations
**11 modified files:** types, main, upload, platform-mcp, mcp, run, http, call-logger, discover, hosting-billing, app.yaml
**1 new background job:** GPU Build Processor

**What doesn't change:** Escrow/acquisition mechanics, existing Deno sandbox, balance/payout infrastructure, Stripe Connect, semantic search indexing, permission system
