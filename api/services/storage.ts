// R2 Storage Service
// Native Cloudflare R2 bindings — replaces AWS SigV4 HTTP signing.
// All consumer files use createR2Service() and call the same methods as before.

import type { BillingConfig } from "./billing-config.ts";
import {
  type CloudOperationMeteringContext,
  debitCloudOperation,
} from "./cloud-usage.ts";

export interface FileUpload {
  name: string;
  content: Uint8Array;
  contentType: string;
}

export interface R2ServiceOptions {
  metering?: CloudOperationMeteringContext | null;
  billingConfig?: Pick<
    BillingConfig,
    | "version"
    | "cloudUnitLightPer1k"
    | "r2OpsPerCloudUnit"
    | "kvOpsPerCloudUnit"
  >;
  fetchFn?: typeof fetch;
}

export class R2Service {
  private bucket: R2Bucket;
  private options: R2ServiceOptions;

  constructor(options: R2ServiceOptions = {}) {
    this.bucket = globalThis.__env.R2_BUCKET;
    this.options = options;
  }

  async uploadFile(key: string, file: FileUpload): Promise<void> {
    await this.meter("put", key);
    await this.bucket.put(key, file.content, {
      httpMetadata: { contentType: file.contentType },
    });
  }

  async uploadFiles(prefix: string, files: FileUpload[]): Promise<void> {
    await Promise.all(
      files.map((f) => this.uploadFile(`${prefix}${f.name}`, f)),
    );
  }

  async fetchFile(key: string): Promise<Uint8Array> {
    await this.meter("get", key);
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`File not found: ${key}`);
    return new Uint8Array(await obj.arrayBuffer());
  }

  async fetchTextFile(key: string): Promise<string> {
    await this.meter("get", key);
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`File not found: ${key}`);
    return await obj.text();
  }

  async deleteFile(key: string): Promise<void> {
    await this.meter("delete", key);
    await this.bucket.delete(key);
  }

  async listFiles(prefix: string): Promise<string[]> {
    // Paginate: R2 list() returns at most 1000 keys per page. Returning only the
    // first page silently drops files — for open-code verification that would let
    // a >1000-object version's unverified files escape the hash comparison. Each
    // page is a separate R2 list op, so meter once per page.
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      await this.meter("list", prefix);
      const listed = await this.bucket.list(cursor ? { prefix, cursor } : { prefix });
      for (const o of listed.objects) keys.push(o.key);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return keys;
  }

  static getAppStorageKey(appId: string, version: string): string {
    return `apps/${appId}/${version}/`;
  }

  private async meter(operation: string, key: string): Promise<void> {
    if (!this.options.metering) {
      return;
    }

    await debitCloudOperation({
      ...this.options.metering,
      resource: "r2_operation",
      operation,
      units: 1,
      billingConfig: this.options.billingConfig,
      metadata: {
        ...(this.options.metering.metadata ?? {}),
        key,
      },
    }, { fetchFn: this.options.fetchFn });
  }
}

export function createR2Service(options?: R2ServiceOptions): R2Service {
  return new R2Service(options);
}
