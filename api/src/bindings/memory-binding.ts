// RPC Memory Binding for Dynamic Workers
// Wraps user memory (Memory.md) read/write behind a WorkerEntrypoint.

import { WorkerEntrypoint } from "cloudflare:workers";
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

export type { MemoryScope };
export { normalizeMemoryScope, resolveMemoryKey };

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
}


// ============================================
// RPC BINDING
// ============================================

export class MemoryBinding
  extends WorkerEntrypoint<unknown, MemoryBindingProps> {
  private getR2Bucket(): R2Bucket {
    return globalThis.__env.R2_BUCKET;
  }

  private async meter(
    operation: string,
    memKey: string,
    units = 1,
  ): Promise<void> {
    const metering = this.ctx.props.operationMetering;
    if (!metering) {
      return;
    }

    await debitCloudOperation({
      ...metering,
      resource: "r2_operation",
      operation,
      units,
      billingConfig: this.ctx.props.operationBillingConfig ?? undefined,
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
  ): Promise<void> {
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

  async recall(key: string, scope?: MemoryScope): Promise<unknown> {
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
