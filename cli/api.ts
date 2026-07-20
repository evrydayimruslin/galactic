/**
 * API Client for Galactic Platform MCP
 *
 * Communicates with the platform MCP endpoint using JSON-RPC 2.0
 */

import type { Config } from "./config.ts";
import { colors } from "./colors.ts";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export class ApiClient {
  private apiUrl: string;
  private token: string | null;
  private jobMode: boolean;
  private requestId = 0;

  constructor(config: Config) {
    this.apiUrl = config.api_url.replace(/\/+$/, "");
    this.token = config.auth?.token || null;
    this.jobMode = config.runtime?.kind === "compute-job" ||
      config.auth?.is_job_token === true;

    // Check token expiration (skip for API tokens - they handle their own expiry)
    if (config.auth?.expires_at && !config.auth?.is_api_token) {
      const expiresAt = new Date(config.auth.expires_at);
      if (expiresAt < new Date()) {
        this.token = null;
      }
    }
  }

  private getNextId(): number {
    return ++this.requestId;
  }

  private missingAuthMessage(): string {
    return this.jobMode
      ? "Galactic Compute lease authentication is unavailable"
      : "Not logged in. Run: galactic login";
  }

  private expiredAuthMessage(): string {
    return this.jobMode
      ? "Galactic Compute lease token is invalid or expired"
      : "Authentication expired. Run: galactic login";
  }

  /**
   * Call a platform MCP tool
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.token) {
      throw new Error(this.missingAuthMessage());
    }

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.getNextId(),
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    };

    const response = await fetch(`${this.apiUrl}/mcp/platform`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.token}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error(this.expiredAuthMessage());
      }
      if (response.status === 429) {
        throw new Error("Rate limit exceeded. Please wait and try again.");
      }
      const errBody = await response.text().catch(() => "");
      throw new Error(
        `API error: ${response.status} ${response.statusText} — ${errBody}`,
      );
    }

    const rpcResponse = await response.json() as JsonRpcResponse;

    if (rpcResponse.error) {
      throw new Error(rpcResponse.error.message);
    }

    if (!rpcResponse.result) {
      throw new Error("No result in response");
    }

    // Check if the tool returned an error
    if (rpcResponse.result.isError) {
      const errorText = rpcResponse.result.content?.[0]?.text ||
        "Unknown error";
      throw new Error(errorText);
    }

    // Return structured content if available, otherwise parse text
    if (rpcResponse.result.structuredContent !== undefined) {
      return rpcResponse.result.structuredContent as Record<string, unknown>;
    }

    // Try to parse text content as JSON
    const textContent = rpcResponse.result.content?.[0]?.text;
    if (textContent) {
      try {
        return JSON.parse(textContent);
      } catch {
        return { text: textContent };
      }
    }

    return {};
  }

  /**
   * List available tools
   */
  async listTools(): Promise<Array<{ name: string; description: string }>> {
    if (!this.token) {
      throw new Error(this.missingAuthMessage());
    }

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.getNextId(),
      method: "tools/list",
    };

    const response = await fetch(`${this.apiUrl}/mcp/platform`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.token}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const rpcResponse = await response.json() as JsonRpcResponse;

    if (rpcResponse.error) {
      throw new Error(rpcResponse.error.message);
    }

    return (rpcResponse.result as {
      tools: Array<{ name: string; description: string }>;
    })?.tools || [];
  }

  /**
   * Initialize connection
   */
  async initialize(): Promise<{ name: string; version: string }> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.getNextId(),
      method: "initialize",
    };

    const response = await fetch(`${this.apiUrl}/mcp/platform`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { "Authorization": `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const rpcResponse = await response.json() as JsonRpcResponse;

    if (rpcResponse.error) {
      throw new Error(rpcResponse.error.message);
    }

    return rpcResponse.result as { name: string; version: string };
  }

  /**
   * Call a REST API endpoint (GET)
   */
  async restGet(path: string): Promise<Record<string, unknown>> {
    if (!this.token) {
      throw new Error(this.missingAuthMessage());
    }

    const response = await fetch(`${this.apiUrl}${path}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error(this.expiredAuthMessage());
      }
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    return await response.json() as Record<string, unknown>;
  }

  /**
   * Call a per-app MCP endpoint (POST /mcp/{appId})
   */
  async callAppTool(
    appId: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.jobMode) {
      throw new Error(
        "Direct per-app MCP routes are unavailable in compute jobs; use exact-scoped gx.call",
      );
    }
    if (!this.token) {
      throw new Error(this.missingAuthMessage());
    }

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.getNextId(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args || {},
      },
    };

    const response = await fetch(`${this.apiUrl}/mcp/${appId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.token}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error(this.expiredAuthMessage());
      }
      if (response.status === 429) {
        throw new Error("Rate limit exceeded. Please wait and try again.");
      }
      const errBody = await response.text().catch(() => "");
      throw new Error(
        `API error: ${response.status} ${response.statusText} — ${errBody}`,
      );
    }

    const rpcResponse = await response.json() as JsonRpcResponse;

    if (rpcResponse.error) {
      throw new Error(rpcResponse.error.message);
    }

    if (!rpcResponse.result) {
      throw new Error("No result in response");
    }

    if (rpcResponse.result.isError) {
      const errorText = rpcResponse.result.content?.[0]?.text ||
        "Unknown error";
      throw new Error(errorText);
    }

    if (rpcResponse.result.structuredContent !== undefined) {
      return rpcResponse.result.structuredContent as Record<string, unknown>;
    }

    const textContent = rpcResponse.result.content?.[0]?.text;
    if (textContent) {
      try {
        return JSON.parse(textContent);
      } catch {
        return { text: textContent };
      }
    }

    return {};
  }

  /**
   * List tools for a per-app MCP endpoint
   */
  async listAppTools(
    appId: string,
  ): Promise<Array<{ name: string; description: string }>> {
    if (this.jobMode) {
      throw new Error(
        "Direct per-app MCP routes are unavailable in compute jobs; use the scoped platform catalog",
      );
    }
    if (!this.token) {
      throw new Error(this.missingAuthMessage());
    }

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.getNextId(),
      method: "tools/list",
    };

    const response = await fetch(`${this.apiUrl}/mcp/${appId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.token}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const rpcResponse = await response.json() as JsonRpcResponse;

    if (rpcResponse.error) {
      throw new Error(rpcResponse.error.message);
    }

    return (rpcResponse.result as {
      tools: Array<{ name: string; description: string }>;
    })?.tools || [];
  }

  /**
   * Get the API URL (for display)
   */
  getApiUrl(): string {
    return this.apiUrl;
  }

  /**
   * Check if authenticated
   */
  isAuthenticated(): boolean {
    return !!this.token;
  }

  /** True when this client is constrained to a compute lease gateway. */
  isComputeJob(): boolean {
    return this.jobMode;
  }

  async getComputeBudget(): Promise<Record<string, unknown>> {
    if (!this.jobMode) {
      throw new Error(
        "Compute budget is only available inside a Galactic Compute job",
      );
    }
    return await this.restGet("/budget");
  }

  async getCurrentReceipt(): Promise<Record<string, unknown>> {
    if (!this.jobMode) {
      throw new Error(
        "Compute receipts are only available inside a Galactic Compute job",
      );
    }
    return await this.restGet("/receipts/current");
  }

  /** Upload an artifact to the current lease through the private gateway. */
  async putArtifact(
    name: string,
    body: BodyInit,
    options: {
      contentType?: string;
      size: number;
      sha256: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    if (!this.token) throw new Error(this.missingAuthMessage());
    if (!this.jobMode) {
      throw new Error(
        "Lease artifacts are only available inside a Galactic Compute job",
      );
    }
    if (!name.trim()) throw new Error("Artifact name cannot be empty");
    if (!Number.isSafeInteger(options.size) || options.size < 0) {
      throw new Error("Artifact size must be a non-negative safe integer");
    }
    const sha256 = options.sha256.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(
        "Artifact SHA-256 must be 64 lowercase hexadecimal characters",
      );
    }
    const idempotencyKey = options.idempotencyKey.trim().toLowerCase();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        .test(idempotencyKey)
    ) {
      throw new Error("Artifact idempotency key must be a canonical UUID");
    }

    const url = new URL(`${this.apiUrl}/artifacts`);
    url.searchParams.set("name", name);
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": options.contentType || "application/octet-stream",
        "Content-Length": String(options.size),
        "x-galactic-sha256": sha256,
        "x-galactic-idempotency-key": idempotencyKey,
      },
      body,
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error(this.expiredAuthMessage());
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `Artifact upload failed: ${response.status}${
          bodyText ? ` — ${bodyText}` : ""
        }`,
      );
    }
    return await response.json() as Record<string, unknown>;
  }

  /** Open an artifact download response from the current lease. */
  async getArtifact(artifactId: string): Promise<Response> {
    if (!this.token) throw new Error(this.missingAuthMessage());
    if (!this.jobMode) {
      throw new Error(
        "Lease artifacts are only available inside a Galactic Compute job",
      );
    }
    if (!artifactId.trim()) throw new Error("Artifact ID cannot be empty");

    const response = await fetch(
      `${this.apiUrl}/artifacts/${encodeURIComponent(artifactId)}`,
      {
        method: "GET",
        headers: { "Authorization": `Bearer ${this.token}` },
      },
    );
    if (!response.ok) {
      if (response.status === 401) throw new Error(this.expiredAuthMessage());
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `Artifact download failed: ${response.status}${
          bodyText ? ` — ${bodyText}` : ""
        }`,
      );
    }
    return response;
  }
}
