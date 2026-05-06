import { getEnv } from '../lib/env.ts';
import type { ChatMessage, ChatTool, InferenceBillingMode } from '../../shared/contracts/ai.ts';
import {
  getAnalyticsIdentity,
  isExplicitlyDisabled,
  sha256Text,
  utf8ByteLength,
} from './analytics-identity.ts';
import { storeTextArtifact } from './artifact-store.ts';
import { createServerLogger } from './logging.ts';

type JsonRecord = Record<string, unknown>;
type InvocationStatus = 'started' | 'success' | 'error' | 'aborted' | 'timeout';

export interface LlmInvocationTelemetryInit {
  userId: string;
  userEmail?: string;
  invocationId: string;
  traceId: string;
  conversationId?: string;
  source: string;
  phase: string;
  provider?: string;
  requestedModel?: string;
  resolvedModel?: string;
  billingMode?: InferenceBillingMode;
  keySource?: string;
  requestParams?: JsonRecord;
  messages: ChatMessage[] | Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }>;
  tools?: ChatTool[] | object[];
  startedAt?: string;
  metadata?: JsonRecord;
}

export interface LlmInvocationFinishInput {
  status: InvocationStatus;
  finishReason?: string | null;
  usage?: unknown;
  costLight?: number | null;
  errorType?: string | null;
  errorMessage?: string | null;
  metadata?: JsonRecord;
  responseSnapshot?: {
    value: unknown;
    snapshotType?: string;
    metadata?: JsonRecord;
  };
}

export interface ToolInvocationTelemetryInput {
  userId: string;
  invocationId: string;
  traceId?: string;
  conversationId?: string;
  parentLlmInvocationId?: string;
  source: string;
  toolCallId?: string;
  toolName: string;
  toolKind?: string;
  appId?: string;
  mcpId?: string;
  functionName?: string;
  schemaSnapshot?: unknown;
  args?: unknown;
  result?: unknown;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  status: InvocationStatus;
  errorType?: string | null;
  errorMessage?: string | null;
  metadata?: JsonRecord;
}

export interface ExecutionFailureInput {
  userId?: string;
  anonUserId?: string;
  failureId?: string;
  traceId?: string;
  conversationId?: string;
  invocationId?: string;
  source: string;
  phase: string;
  failureType: string;
  severity?: 'info' | 'warn' | 'error' | 'critical';
  message?: string | null;
  retryable?: boolean | null;
  abortedBy?: string | null;
  metadata?: JsonRecord;
}

interface ArtifactSnapshot {
  artifactId: string | null;
  sha256: string;
  bytes: number;
  preview: unknown;
}

const telemetryLogger = createServerLogger('INVOCATION-TELEMETRY');

function telemetryEnabled(): boolean {
  return !isExplicitlyDisabled(getEnv('CHAT_CAPTURE_ENABLED'));
}

function supabaseReady(): boolean {
  return !!getEnv('SUPABASE_URL') && !!getEnv('SUPABASE_SERVICE_ROLE_KEY');
}

function asUuid(value?: string): string | null {
  if (!value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
    ? value
    : null;
}

function dbHeaders(prefer = 'return=minimal'): Record<string, string> {
  const key = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Prefer': prefer,
  };
}

async function postRows(
  table: string,
  rows: unknown,
  opts: { prefer?: string; onConflict?: string } = {},
): Promise<unknown[]> {
  const url = new URL(`${getEnv('SUPABASE_URL')}/rest/v1/${table}`);
  if (opts.onConflict) url.searchParams.set('on_conflict', opts.onConflict);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: dbHeaders(opts.prefer),
    body: JSON.stringify(rows),
  });

  if (!response.ok) {
    throw new Error(`Failed to insert ${table}: ${response.status} ${await response.text()}`);
  }
  if ((opts.prefer || '').includes('return=representation')) {
    return await response.json().catch(() => []) as unknown[];
  }
  return [];
}

async function patchRows(
  table: string,
  filter: string,
  update: unknown,
): Promise<void> {
  const response = await fetch(`${getEnv('SUPABASE_URL')}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: dbHeaders('return=minimal'),
    body: JSON.stringify(update),
  });

  if (!response.ok) {
    throw new Error(`Failed to update ${table}: ${response.status} ${await response.text()}`);
  }
}

async function analyticsIdentityFor(userId: string): Promise<{
  anonUserId: string;
  pepperVersion: string;
}> {
  const identity = await getAnalyticsIdentity(userId);
  await postRows('capture_subjects', {
    anon_user_id: identity.anonUserId,
    user_id: userId,
    pepper_version: identity.pepperVersion,
    last_seen_at: new Date().toISOString(),
    metadata: {},
  }, {
    prefer: 'return=minimal,resolution=merge-duplicates',
    onConflict: 'anon_user_id',
  });
  return identity;
}

function safeJson(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {
      _serialization_error: true,
      preview: String(value).slice(0, 1000),
    };
  }
}

function jsonText(value: unknown): string {
  return JSON.stringify(safeJson(value), null, 2);
}

function previewJson(value: unknown, maxChars = 4000): unknown {
  const safe = safeJson(value);
  const text = JSON.stringify(safe);
  if (text.length <= maxChars) return safe;
  return {
    _truncated: true,
    _original_bytes: utf8ByteLength(text),
    _preview: text.slice(0, maxChars),
  };
}

async function storeJsonSnapshot(input: {
  anonUserId: string;
  conversationId?: string;
  source: string;
  relationship: string;
  value: unknown;
  filename: string;
  metadata?: JsonRecord;
}): Promise<ArtifactSnapshot> {
  const text = jsonText(input.value);
  const sha256 = await sha256Text(text);
  const bytes = utf8ByteLength(text);
  const artifact = await storeTextArtifact({
    anonUserId: input.anonUserId,
    source: input.source,
    relationship: input.relationship,
    text,
    originalFilename: input.filename,
    mimeType: 'application/json; charset=utf-8',
    metadata: {
      ...(input.metadata || {}),
      conversation_id: input.conversationId || null,
      sha256,
      bytes,
    },
  }).catch((err) => {
    telemetryLogger.warn('Failed to store invocation telemetry artifact', {
      source: input.source,
      relationship: input.relationship,
      error: err,
    });
    return null;
  });

  return {
    artifactId: artifact?.artifactId || null,
    sha256,
    bytes,
    preview: previewJson(input.value),
  };
}

export class LlmInvocationTelemetrySession {
  private readonly init: LlmInvocationTelemetryInit;
  private started: Promise<void> | null = null;
  private anonUserId = '';
  private startTime = 0;
  private finished = false;

  constructor(init: LlmInvocationTelemetryInit) {
    this.init = init;
  }

  start(): void {
    if (!telemetryEnabled() || !supabaseReady()) return;
    if (!this.started) {
      this.startTime = Date.now();
      this.started = this.startInner().catch((err) => {
        telemetryLogger.warn('Failed to start LLM invocation telemetry', {
          invocation_id: this.init.invocationId,
          source: this.init.source,
          phase: this.init.phase,
          error: err,
        });
      });
    }
  }

  async finish(input: LlmInvocationFinishInput): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (!telemetryEnabled() || !supabaseReady()) return;
    if (this.started) await this.started;
    if (!this.anonUserId) return;

    const completedAt = new Date().toISOString();
    const durationMs = this.startTime > 0 ? Date.now() - this.startTime : null;
    try {
      await patchRows(
        'llm_invocations',
        `invocation_id=eq.${encodeURIComponent(this.init.invocationId)}`,
        {
          completed_at: completedAt,
          duration_ms: durationMs,
          status: input.status,
          finish_reason: input.finishReason || null,
          usage: safeJson(input.usage) || {},
          cost_light: input.costLight ?? null,
          error_type: input.errorType || null,
          error_message: input.errorMessage || null,
          metadata: {
            ...(this.init.metadata || {}),
            ...(input.metadata || {}),
          },
        },
      );

      if (input.responseSnapshot) {
        await this.storeResponseSnapshot(input).catch((err) => {
          telemetryLogger.warn('Failed to store LLM response snapshot', {
            invocation_id: this.init.invocationId,
            source: this.init.source,
            phase: this.init.phase,
            error: err,
          });
        });
      }

      if (input.status !== 'success') {
        await recordExecutionFailure({
          userId: this.init.userId,
          anonUserId: this.anonUserId,
          traceId: this.init.traceId,
          conversationId: this.init.conversationId,
          invocationId: this.init.invocationId,
          source: this.init.source,
          phase: this.init.phase,
          failureType: input.errorType || input.status,
          message: input.errorMessage || null,
          metadata: input.metadata,
        });
      }
    } catch (err) {
      telemetryLogger.warn('Failed to finish LLM invocation telemetry', {
        invocation_id: this.init.invocationId,
        error: err,
      });
    }
  }

  private async storeResponseSnapshot(input: LlmInvocationFinishInput): Promise<void> {
    if (!input.responseSnapshot) return;
    const snapshotType = input.responseSnapshot.snapshotType || 'llm_response';
    const responseValue = {
      status: input.status,
      finish_reason: input.finishReason || null,
      usage: safeJson(input.usage) || {},
      error_type: input.errorType || null,
      error_message: input.errorMessage || null,
      value: safeJson(input.responseSnapshot.value),
    };
    const responseText = jsonText(responseValue);
    const snapshot = await storeJsonSnapshot({
      anonUserId: this.anonUserId,
      conversationId: this.init.conversationId,
      source: 'llm_response_snapshot',
      relationship: 'llm_response_snapshot',
      value: responseValue,
      filename: `${this.init.source}-${this.init.phase}-${this.init.invocationId}-response.json`,
      metadata: {
        invocation_id: this.init.invocationId,
        trace_id: this.init.traceId,
        source: this.init.source,
        phase: this.init.phase,
        snapshot_type: snapshotType,
        status: input.status,
        ...(input.responseSnapshot.metadata || {}),
      },
    });

    await postRows('llm_context_snapshots', {
      invocation_id: this.init.invocationId,
      trace_id: asUuid(this.init.traceId),
      conversation_id: this.init.conversationId || null,
      anon_user_id: this.anonUserId,
      source: this.init.source,
      snapshot_type: snapshotType,
      message_count: 0,
      tool_schema_count: 0,
      artifact_id: snapshot.artifactId,
      sha256: snapshot.sha256,
      size_bytes: snapshot.bytes,
      text_preview: responseText.slice(0, 4000),
      metadata: {
        source: this.init.source,
        phase: this.init.phase,
        status: input.status,
        ...(input.responseSnapshot.metadata || {}),
      },
    });
  }

  private async startInner(): Promise<void> {
    const identity = await analyticsIdentityFor(this.init.userId);
    this.anonUserId = identity.anonUserId;
    const startedAt = this.init.startedAt || new Date().toISOString();
    const contextValue = {
      messages: safeJson(this.init.messages),
      tools: safeJson(this.init.tools || []),
      request_params: safeJson(this.init.requestParams || {}),
      metadata: safeJson(this.init.metadata || {}),
    };
    const contextText = jsonText(contextValue);
    const contextSha256 = await sha256Text(contextText);
    const contextBytes = utf8ByteLength(contextText);

    await postRows('llm_invocations', {
      invocation_id: this.init.invocationId,
      trace_id: asUuid(this.init.traceId),
      conversation_id: this.init.conversationId || null,
      anon_user_id: this.anonUserId,
      source: this.init.source,
      phase: this.init.phase,
      provider: this.init.provider || null,
      requested_model: this.init.requestedModel || null,
      resolved_model: this.init.resolvedModel || null,
      billing_mode: this.init.billingMode || null,
      key_source: this.init.keySource || null,
      request_params: safeJson(this.init.requestParams || {}),
      context_sha256: contextSha256,
      context_bytes: contextBytes,
      context_message_count: this.init.messages.length,
      tool_schema_count: this.init.tools?.length || 0,
      started_at: startedAt,
      status: 'started',
      metadata: {
        user_email_present: !!this.init.userEmail,
        ...(this.init.metadata || {}),
      },
    }, {
      prefer: 'return=minimal,resolution=merge-duplicates',
      onConflict: 'invocation_id',
    });

    const snapshot = await storeJsonSnapshot({
      anonUserId: this.anonUserId,
      conversationId: this.init.conversationId,
      source: 'llm_context_snapshot',
      relationship: 'llm_context_snapshot',
      value: contextValue,
      filename: `${this.init.source}-${this.init.phase}-${this.init.invocationId}.json`,
      metadata: {
        invocation_id: this.init.invocationId,
        trace_id: this.init.traceId,
        source: this.init.source,
        phase: this.init.phase,
      },
    });

    const rows = await postRows('llm_context_snapshots', {
      invocation_id: this.init.invocationId,
      trace_id: asUuid(this.init.traceId),
      conversation_id: this.init.conversationId || null,
      anon_user_id: this.anonUserId,
      source: this.init.source,
      snapshot_type: 'llm_request',
      message_count: this.init.messages.length,
      tool_schema_count: this.init.tools?.length || 0,
      artifact_id: snapshot.artifactId,
      sha256: snapshot.sha256,
      size_bytes: snapshot.bytes,
      text_preview: contextText.slice(0, 4000),
      metadata: {
        request_params: safeJson(this.init.requestParams || {}),
        source: this.init.source,
        phase: this.init.phase,
      },
    }, {
      prefer: 'return=representation',
    }) as Array<{ id?: string }>;

    const snapshotId = rows[0]?.id;
    if (snapshotId) {
      await patchRows(
        'llm_invocations',
        `invocation_id=eq.${encodeURIComponent(this.init.invocationId)}`,
        { context_snapshot_id: snapshotId },
      );
    }
  }
}

export function createLlmInvocationTelemetrySession(
  init: LlmInvocationTelemetryInit,
): LlmInvocationTelemetrySession | null {
  if (!telemetryEnabled() || !supabaseReady()) return null;
  return new LlmInvocationTelemetrySession(init);
}

export async function recordToolInvocationTelemetry(
  input: ToolInvocationTelemetryInput,
): Promise<void> {
  if (!telemetryEnabled() || !supabaseReady()) return;

  try {
    const identity = await analyticsIdentityFor(input.userId);
    const argsSnapshot = await storeJsonSnapshot({
      anonUserId: identity.anonUserId,
      conversationId: input.conversationId,
      source: 'tool_args',
      relationship: 'tool_args',
      value: input.args ?? {},
      filename: `${input.toolName}-${input.invocationId}-args.json`,
      metadata: {
        invocation_id: input.invocationId,
        parent_llm_invocation_id: input.parentLlmInvocationId || null,
        trace_id: input.traceId || null,
      },
    });
    const resultSnapshot = await storeJsonSnapshot({
      anonUserId: identity.anonUserId,
      conversationId: input.conversationId,
      source: 'tool_result',
      relationship: 'tool_result',
      value: input.result ?? null,
      filename: `${input.toolName}-${input.invocationId}-result.json`,
      metadata: {
        invocation_id: input.invocationId,
        parent_llm_invocation_id: input.parentLlmInvocationId || null,
        trace_id: input.traceId || null,
        status: input.status,
      },
    });

    await postRows('tool_invocations', {
      invocation_id: input.invocationId,
      trace_id: asUuid(input.traceId),
      conversation_id: input.conversationId || null,
      parent_llm_invocation_id: input.parentLlmInvocationId || null,
      anon_user_id: identity.anonUserId,
      source: input.source,
      tool_call_id: input.toolCallId || null,
      tool_name: input.toolName,
      tool_kind: input.toolKind || 'function',
      app_id: input.appId || null,
      mcp_id: input.mcpId || null,
      function_name: input.functionName || input.toolName,
      schema_snapshot: safeJson(input.schemaSnapshot || {}),
      args_preview: argsSnapshot.preview,
      args_artifact_id: argsSnapshot.artifactId,
      args_sha256: argsSnapshot.sha256,
      args_bytes: argsSnapshot.bytes,
      result_preview: resultSnapshot.preview,
      result_artifact_id: resultSnapshot.artifactId,
      result_sha256: resultSnapshot.sha256,
      result_bytes: resultSnapshot.bytes,
      started_at: input.startedAt || new Date().toISOString(),
      completed_at: input.completedAt || null,
      duration_ms: input.durationMs ?? null,
      status: input.status,
      error_type: input.errorType || null,
      error_message: input.errorMessage || null,
      metadata: safeJson(input.metadata || {}),
    }, {
      prefer: 'return=minimal,resolution=merge-duplicates',
      onConflict: 'invocation_id',
    });

    if (input.status !== 'success') {
      await recordExecutionFailure({
        userId: input.userId,
        anonUserId: identity.anonUserId,
        traceId: input.traceId,
        conversationId: input.conversationId,
        invocationId: input.invocationId,
        source: input.source,
        phase: 'tool_invocation',
        failureType: input.errorType || input.status,
        message: input.errorMessage || null,
        metadata: {
          tool_name: input.toolName,
          tool_call_id: input.toolCallId || null,
          ...(input.metadata || {}),
        },
      });
    }
  } catch (err) {
    telemetryLogger.warn('Failed to record tool invocation telemetry', {
      invocation_id: input.invocationId,
      tool_name: input.toolName,
      error: err,
    });
  }
}

export async function recordExecutionFailure(input: ExecutionFailureInput): Promise<void> {
  if (!telemetryEnabled() || !supabaseReady()) return;

  try {
    let anonUserId = input.anonUserId || '';
    if (!anonUserId && input.userId) {
      anonUserId = (await analyticsIdentityFor(input.userId)).anonUserId;
    }

    await postRows('execution_failures', {
      failure_id: input.failureId || crypto.randomUUID(),
      trace_id: asUuid(input.traceId),
      conversation_id: input.conversationId || null,
      invocation_id: input.invocationId || null,
      anon_user_id: anonUserId || null,
      source: input.source,
      phase: input.phase,
      failure_type: input.failureType,
      severity: input.severity || 'error',
      message: input.message || null,
      retryable: input.retryable ?? null,
      aborted_by: input.abortedBy || null,
      metadata: safeJson(input.metadata || {}),
    }, {
      prefer: 'return=minimal,resolution=ignore-duplicates',
      onConflict: 'failure_id',
    });
  } catch (err) {
    telemetryLogger.warn('Failed to record execution failure telemetry', {
      failure_type: input.failureType,
      source: input.source,
      phase: input.phase,
      error: err,
    });
  }
}
