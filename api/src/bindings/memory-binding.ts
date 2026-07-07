// RPC Memory Binding for Dynamic Workers
// Wraps user memory (Memory.md) read/write behind a WorkerEntrypoint.

import { WorkerEntrypoint } from "cloudflare:workers";
import {
  assertExecutionContext,
  resolveExecutionContext,
} from "../../services/execution-context-registry.ts";
import type { BillingConfig } from "../../services/billing-config.ts";
import {
  type CloudOperationMeteringContext,
  debitCloudOperation,
} from "../../services/cloud-usage.ts";
import {
  type MemoryScope,
  normalizeMemoryScope,
  resolveMemoryKey,
} from "./memory-scope.ts";

// ============================================
// TYPES
// ============================================

interface MemoryBindingProps {
  userId: string;
  // When present, remember/recall default to AGENT scope — a per-(app,user)
  // notebook isolated from every other agent. Absent (or scope:"user") falls
  // back to the shared per-user notebook the person carries between agents.
  appId?: string | null;
  operationMetering?: CloudOperationMeteringContext | null;
  operationBillingConfig?:
    | Pick<
      BillingConfig,
      | "version"
      | "cloudUnitLightPer1k"
      | "r2OpsPerCloudUnit"
      | "kvOpsPerCloudUnit"
    >
    | null;
  // Set for bindings loaded into a REUSABLE isolate (loader.get): every public
  // method then refuses to run without a resolvable per-call context handle,
  // so a direct-binding bypass can never ride the stale frozen props.
  requireExecCtx?: boolean;
}


// ============================================
// RPC BINDING
// ============================================

export class MemoryBinding
  extends WorkerEntrypoint<unknown, MemoryBindingProps> {
  // Per-RPC-call context handle. A fresh binding instance is created per RPC
  // (Cloudflare WorkerEntrypoint contract), so this is call-scoped. Set at each
  // public method entry; meter() resolves the CURRENT metering context from it,
  // so a warm-reused isolate never meters against a stale baked hold.
  private execCtxHandle?: string;

  private getR2Bucket(): R2Bucket {
    return globalThis.__env.R2_BUCKET;
  }

  private meteringContext() {
    // Handle threaded (even if it resolves to null) → resolve-or-FAIL-CLOSED:
    // never fall back to props, which are frozen at load and go STALE under a
    // warm get() reuse. Handle NOT threaded (undefined: legacy/direct-call
    // path) → props fallback preserves pre-registry behavior. No-op under
    // load(); safety linchpin under get() reuse. See database-binding.ts.
    if (this.execCtxHandle !== undefined) {
      const resolved = resolveExecutionContext(this.execCtxHandle);
      return {
        metering: resolved?.cloudOperationMetering ?? null,
        billingConfig: resolved?.cloudOperationBillingConfig ?? null,
      };
    }
    return {
      metering: this.ctx.props.operationMetering,
      billingConfig: this.ctx.props.operationBillingConfig,
    };
  }

  private async meter(
    operation: string,
    memKey: string,
    units = 1,
  ): Promise<void> {
    const { metering, billingConfig } = this.meteringContext();
    if (!metering) {
      return;
    }

    await debitCloudOperation({
      ...metering,
      resource: "r2_operation",
      operation,
      units,
      billingConfig: billingConfig ?? undefined,
      metadata: {
        ...(metering.metadata ?? {}),
        key: memKey,
        binding: "MemoryBinding",
      },
    });
  }

  private memoryKey(scope: MemoryScope): string {
    return resolveMemoryKey(scope, this.ctx.props.userId, this.ctx.props.appId);
  }

  async remember(
    key: string,
    value: unknown,
    scope?: MemoryScope,
    execCtxHandle?: string,
  ): Promise<void> {
    if (execCtxHandle !== undefined) this.execCtxHandle = execCtxHandle;
    assertExecutionContext(this.execCtxHandle, this.ctx.props.requireExecCtx);
    const memKey = this.memoryKey(normalizeMemoryScope(scope));
    await this.meter("memory.remember", memKey, 2);
    const bucket = this.getR2Bucket();

    // Load existing memory
    let memory = "";
    try {
      const obj = await bucket.get(memKey);
      if (obj) memory = await obj.text();
    } catch { /* No existing memory */ }

    // Append or update the key
    const valueStr = typeof value === "string" ? value : JSON.stringify(value);
    const keyPattern = new RegExp(`^## ${key}$[\\s\\S]*?(?=^## |\\Z)`, "gm");

    if (keyPattern.test(memory)) {
      // Update existing section
      memory = memory.replace(keyPattern, `## ${key}\n${valueStr}\n\n`);
    } else {
      // Append new section
      memory += `\n## ${key}\n${valueStr}\n\n`;
    }

    await bucket.put(memKey, memory.trim() + "\n", {
      httpMetadata: { contentType: "text/markdown" },
    });
  }

  async recall(
    key: string,
    scope?: MemoryScope,
    execCtxHandle?: string,
  ): Promise<unknown> {
    if (execCtxHandle !== undefined) this.execCtxHandle = execCtxHandle;
    assertExecutionContext(this.execCtxHandle, this.ctx.props.requireExecCtx);
    const memKey = this.memoryKey(normalizeMemoryScope(scope));
    await this.meter("memory.recall", memKey);
    const bucket = this.getR2Bucket();

    try {
      const obj = await bucket.get(memKey);
      if (!obj) return null;
      const memory = await obj.text();

      // Find section by key
      const keyPattern = new RegExp(`^## ${key}$([\\s\\S]*?)(?=^## |$)`, "m");
      const match = memory.match(keyPattern);
      if (!match) return null;

      const value = match[1].trim();
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    } catch {
      return null;
    }
  }
}
