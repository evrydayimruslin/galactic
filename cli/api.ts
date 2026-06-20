/**
 * API Client for Ultralight Platform MCP
 *
 * Communicates with the platform MCP endpoint using JSON-RPC 2.0
 */

import type { Config } from './config.ts';
import { colors } from './colors.ts';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
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
  private requestId = 0;

  constructor(config: Config) {
    this.apiUrl = config.api_url;
    this.token = config.auth?.token || null;

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

  /**
   * Call a platform MCP tool
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.token) {
      throw new Error('Not logged in. Run: ultralight login');
    }

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.getNextId(),
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    };

    const response = await fetch(`${this.apiUrl}/mcp/platform`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Authentication expired. Run: ultralight login');
      }
      if (response.status === 429) {
        throw new Error('Rate limit exceeded. Please wait and try again.');
      }
      const errBody = await response.text().catch(() => '');
      throw new Error(`API error: ${response.status} ${response.statusText} — ${errBody}`);
    }

    const rpcResponse = await response.json() as JsonRpcResponse;

    if (rpcResponse.error) {
      throw new Error(rpcResponse.error.message);
    }

    if (!rpcResponse.result) {
      throw new Error('No result in response');
    }

    // Check if the tool returned an error
    if (rpcResponse.result.isError) {
      const errorText = rpcResponse.result.content?.[0]?.text || 'Unknown error';
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
      throw new Error('Not logged in. Run: ultralight login');
    }

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.getNextId(),
      method: 'tools/list',
    };

    const response = await fetch(`${this.apiUrl}/mcp/platform`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
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

    return (rpcResponse.result as { tools: Array<{ name: string; description: string }> })?.tools || [];
  }

  /**
   * Initialize connection
   */
  async initialize(): Promise<{ name: string; version: string }> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.getNextId(),
      method: 'initialize',
    };

    const response = await fetch(`${this.apiUrl}/mcp/platform`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { 'Authorization': `Bearer ${this.token}` } : {}),
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
      throw new Error('Not logged in. Run: ultralight login');
    }

    const response = await fetch(`${this.apiUrl}${path}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Authentication expired. Run: ultralight login');
      }
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    return await response.json() as Record<string, unknown>;
  }

  /**
   * Call a per-app MCP endpoint (POST /mcp/{appId})
   */
  async callAppTool(appId: string, toolName: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.token) {
      throw new Error('Not logged in. Run: ultralight login');
    }

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.getNextId(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args || {},
      },
    };

    const response = await fetch(`${this.apiUrl}/mcp/${appId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Authentication expired. Run: ultralight login');
      }
      if (response.status === 429) {
        throw new Error('Rate limit exceeded. Please wait and try again.');
      }
      const errBody = await response.text().catch(() => '');
      throw new Error(`API error: ${response.status} ${response.statusText} — ${errBody}`);
    }

    const rpcResponse = await response.json() as JsonRpcResponse;

    if (rpcResponse.error) {
      throw new Error(rpcResponse.error.message);
    }

    if (!rpcResponse.result) {
      throw new Error('No result in response');
    }

    if (rpcResponse.result.isError) {
      const errorText = rpcResponse.result.content?.[0]?.text || 'Unknown error';
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
  async listAppTools(appId: string): Promise<Array<{ name: string; description: string }>> {
    if (!this.token) {
      throw new Error('Not logged in. Run: ultralight login');
    }

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.getNextId(),
      method: 'tools/list',
    };

    const response = await fetch(`${this.apiUrl}/mcp/${appId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
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

    return (rpcResponse.result as { tools: Array<{ name: string; description: string }> })?.tools || [];
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
}
