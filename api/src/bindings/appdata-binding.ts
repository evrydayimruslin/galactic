// RPC App Data Binding for Dynamic Workers
// Wraps R2 app data operations behind a WorkerEntrypoint.
// The Dynamic Worker sees env.DATA.store() etc. but never has direct R2 access.

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

// ============================================
// TYPES
// ============================================

interface AppDataBindingProps {
  appId: string;
  userId: string;
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

export class AppDataBinding
  extends WorkerEntrypoint<unknown, AppDataBindingProps> {
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

  private async meter(operation: string, key?: string): Promise<void> {
    const { metering, billingConfig } = this.meteringContext();
    if (!metering) {
      return;
    }

    await debitCloudOperation({
      ...metering,
      resource: "r2_operation",
      operation,
      units: 1,
      billingConfig: billingConfig ?? undefined,
      metadata: {
        ...(metering.metadata ?? {}),
        key,
        binding: "AppDataBinding",
      },
    });
  }

  private dataKey(key: string): string {
    const { appId, userId } = this.ctx.props;
    const sanitized = key.replace(/[^a-zA-Z0-9\-_\/]/g, "_");
    return userId
      ? `apps/${appId}/users/${userId}/data/${sanitized}.json`
      : `apps/${appId}/data/${sanitized}.json`;
  }

  async store(
    key: string,
    value: unknown,
    execCtxHandle?: string,
  ): Promise<void> {
    if (execCtxHandle !== undefined) this.execCtxHandle = execCtxHandle;
    assertExecutionContext(this.execCtxHandle, this.ctx.props.requireExecCtx);
    await this.meter("appdata.store", key);
    const bucket = this.getR2Bucket();
    const data = JSON.stringify({
      key,
      value,
      updated_at: new Date().toISOString(),
    });
    await bucket.put(this.dataKey(key), data, {
      httpMetadata: { contentType: "application/json" },
    });
  }

  async load(key: string, execCtxHandle?: string): Promise<unknown> {
    if (execCtxHandle !== undefined) this.execCtxHandle = execCtxHandle;
    assertExecutionContext(this.execCtxHandle, this.ctx.props.requireExecCtx);
    await this.meter("appdata.load", key);
    const bucket = this.getR2Bucket();
    const obj = await bucket.get(this.dataKey(key));
    if (!obj) return null;
    const text = await obj.text();
    try {
      const parsed = JSON.parse(text);
      return parsed.value ?? parsed;
    } catch {
      return text;
    }
  }

  async remove(key: string, execCtxHandle?: string): Promise<void> {
    if (execCtxHandle !== undefined) this.execCtxHandle = execCtxHandle;
    assertExecutionContext(this.execCtxHandle, this.ctx.props.requireExecCtx);
    await this.meter("appdata.remove", key);
    const bucket = this.getR2Bucket();
    await bucket.delete(this.dataKey(key));
  }

  async list(prefix?: string, execCtxHandle?: string): Promise<string[]> {
    if (execCtxHandle !== undefined) this.execCtxHandle = execCtxHandle;
    assertExecutionContext(this.execCtxHandle, this.ctx.props.requireExecCtx);
    await this.meter("appdata.list", prefix);
    const bucket = this.getR2Bucket();
    const { appId, userId } = this.ctx.props;
    const r2Prefix = userId
      ? `apps/${appId}/users/${userId}/data/${prefix || ""}`
      : `apps/${appId}/data/${prefix || ""}`;
    const listed = await bucket.list({ prefix: r2Prefix });
    return listed.objects.map((o) => {
      // Extract the user-facing key from the R2 path
      const fullKey = o.key;
      const dataIdx = fullKey.indexOf("/data/");
      if (dataIdx >= 0) {
        return fullKey.slice(dataIdx + 6).replace(/\.json$/, "");
      }
      return fullKey;
    });
  }
}
