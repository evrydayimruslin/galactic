import { getEnv } from '../lib/env.ts';
import type { ChatMessage, ChatTool, InferenceBillingMode } from '../../shared/contracts/ai.ts';
import type { ActiveWidgetContext } from '../../shared/contracts/widget.ts';
import {
  getAnalyticsIdentity,
  isExplicitlyDisabled,
  sha256Text,
  utf8ByteLength,
} from './analytics-identity.ts';
import { createServerLogger } from './logging.ts';
import {
  decodeDataUrlOrBase64,
  storeCaptureArtifact,
  storeTextArtifact,
} from './artifact-store.ts';

const captureLogger = createServerLogger('CHAT-CAPTURE');

type JsonRecord = Record<string, unknown>;

export interface ChatCaptureFile {
  name: string;
  size: number;
  mimeType: string;
  content: string;
}

export interface OrchestrateCaptureInit {
  userId: string;
  userEmail?: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  traceId: string;
  message: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  interpreterModel?: string;
  heavyModel?: string;
  inference?: unknown;
  scope?: unknown;
  systemAgentContext?: unknown;
  projectContext?: string;
  activeWidgetContexts?: ActiveWidgetContext[];
  files?: ChatCaptureFile[];
}

export interface ChatStreamCaptureInit {
  userId: string;
  userEmail?: string;
  conversationId: string;
  assistantMessageId: string;
  traceId: string;
  source?: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  requestedModel: string;
  resolvedModel: string;
  provider: string;
  billingMode: InferenceBillingMode;
  keySource: string;
  inference?: unknown;
  temperature?: number;
  maxTokens?: number;
}

interface PendingCaptureEvent {
  id: string;
  type: string;
  sequence: number;
  payload: unknown;
  messageId?: string;
  createdAt: string;
}

interface PreparedMessageContent {
  content: string;
  sha256: string;
  bytes: number;
  metadata: Record<string, unknown>;
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

function captureEnabled(): boolean {
  return !isExplicitlyDisabled(getEnv('CHAT_CAPTURE_ENABLED'));
}

function maxInlineBytes(): number {
  const raw = Number(getEnv('CHAT_CAPTURE_MAX_INLINE_BYTES'));
  return Number.isFinite(raw) && raw > 0 ? raw : 64_000;
}

function supabaseReady(): boolean {
  return !!getEnv('SUPABASE_URL') && !!getEnv('SUPABASE_SERVICE_ROLE_KEY');
}

function asUuid(value: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
    ? value
    : crypto.randomUUID();
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

function previewText(value: string, maxChars = 4000): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated; raw content stored as artifact]`;
}

function safeJsonBytes(value: unknown): number {
  try {
    return utf8ByteLength(JSON.stringify(safeJson(value)) || '');
  } catch {
    return 0;
  }
}

function summarizeActiveWidgetContexts(
  contexts: ActiveWidgetContext[] | undefined,
): JsonRecord[] {
  if (!contexts?.length) return [];
  return contexts.slice(0, 8).map((context) => ({
    surface_id: context.surfaceId,
    kind: context.kind || null,
    status: context.status || null,
    app_id: context.appId,
    app_slug: context.appSlug,
    app_name: context.appName,
    widget_id: context.widgetId,
    widget_name: context.widgetName || null,
    title: context.snapshot?.title || context.title || null,
    current_view: context.snapshot?.current_view || null,
    visible_component_count: context.snapshot?.visible_components?.length || 0,
    visible_data_ref_count: context.snapshot?.visible_data_refs?.length || 0,
    selected_entity_count: context.snapshot?.selected_entities?.length || 0,
    pending_edit_count: context.snapshot?.pending_edits?.length || 0,
    declared_action_count: context.actions?.length || 0,
    recent_event_count: context.recentEventCount ?? context.recentEvents?.length ?? 0,
    recent_event_summary: context.recentEventSummary || null,
    has_latest_data_payload: !!context.latestDataPayload,
    updated_at: context.updatedAt || null,
  }));
}

async function postRows(
  table: string,
  rows: unknown,
  opts: { prefer?: string; onConflict?: string } = {},
): Promise<void> {
  const base = getEnv('SUPABASE_URL');
  const url = new URL(`${base}/rest/v1/${table}`);
  if (opts.onConflict) url.searchParams.set('on_conflict', opts.onConflict);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: dbHeaders(opts.prefer),
    body: JSON.stringify(rows),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Failed to insert ${table}: ${response.status} ${detail}`);
  }
}

function eventMessageId(
  type: string,
  userMessageId: string,
  assistantMessageId: string,
): string | null {
  if (type === 'orchestrate_request') return userMessageId;
  if (
    type === 'heavy_text' ||
    type === 'flash_direct' ||
    type === 'text' ||
    type === 'result' ||
    type === 'usage' ||
    type === 'done' ||
    type === 'error'
  ) {
    return assistantMessageId;
  }
  return null;
}

async function prepareCapturedContent(input: {
  anonUserId: string;
  conversationId: string;
  messageId: string;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
  logContext: Record<string, unknown>;
}): Promise<PreparedMessageContent> {
  const bytes = utf8ByteLength(input.content);
  const sha256 = await sha256Text(input.content);
  if (!input.content || bytes <= maxInlineBytes()) {
    return {
      content: input.content,
      sha256,
      bytes,
      metadata: { content_storage: 'inline' },
    };
  }

  let artifact: Awaited<ReturnType<typeof storeTextArtifact>> = null;
  try {
    artifact = await storeTextArtifact({
      anonUserId: input.anonUserId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      source: 'message_content',
      relationship: 'raw_message_content',
      text: input.content,
      originalFilename: `${input.role}-${input.messageId}.txt`,
      metadata: {
        ...input.metadata,
        role: input.role,
        sha256,
        content_bytes: bytes,
      },
    });
  } catch (err) {
    captureLogger.warn('Failed to store oversized message artifact', {
      ...input.logContext,
      message_id: input.messageId,
      role: input.role,
      error: err,
    });
  }

  return {
    content: artifact ? previewText(input.content) : input.content,
    sha256,
    bytes,
    metadata: {
      content_storage: artifact ? 'artifact' : 'inline_fallback',
      content_artifact_id: artifact?.artifactId || null,
      content_storage_key: artifact?.storageKey || null,
      content_preview_truncated: !!artifact,
    },
  };
}

export function scheduleCaptureTask(task: Promise<void>): void {
  const ctx = globalThis.__ctx;
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(task.catch((err) => {
      captureLogger.warn('Scheduled capture task failed', { error: err });
    }));
    return;
  }
  task.catch((err) => {
    captureLogger.warn('Capture task failed', { error: err });
  });
}

export class OrchestrateCaptureSession {
  private readonly init: OrchestrateCaptureInit;
  private anonUserId = '';
  private pepperVersion = '';
  private started: Promise<void> | null = null;
  private sequence = 0;
  private events: PendingCaptureEvent[] = [];
  private assistantContent = '';
  private usage: unknown = null;
  private readonly traceUuid: string;

  constructor(init: OrchestrateCaptureInit) {
    this.init = init;
    this.traceUuid = asUuid(init.traceId);
  }

  start(): void {
    if (!captureEnabled() || !supabaseReady()) return;
    if (!this.started) {
      this.started = this.startInner().catch((err) => {
        captureLogger.warn('Failed to start chat capture', {
          conversation_id: this.init.conversationId,
          error: err,
        });
      });
    }
  }

  observeEvent(
    event: {
      type?: string;
      content?: string;
      message?: string;
      data?: unknown;
      flash?: unknown;
      heavy?: unknown;
      [key: string]: unknown;
    },
  ): void {
    if (!captureEnabled()) return;
    const type = typeof event.type === 'string' ? event.type : 'unknown';

    if (type === 'heavy_text' || type === 'flash_direct' || type === 'text') {
      this.assistantContent += typeof event.content === 'string' ? event.content : '';
    } else if (type === 'result' && event.data !== undefined) {
      const resultText = typeof event.data === 'string'
        ? event.data
        : JSON.stringify(event.data, null, 2);
      if (resultText && resultText !== 'null') {
        this.assistantContent += `\n\`\`\`json\n${resultText}\n\`\`\``;
      }
    } else if (type === 'error' && typeof event.message === 'string') {
      this.assistantContent += `\n\n**Error:** ${event.message}`;
    } else if (type === 'usage') {
      this.usage = { flash: event.flash || {}, heavy: event.heavy || {} };
    }

    this.events.push({
      id: crypto.randomUUID(),
      type,
      sequence: this.sequence++,
      payload: safeJson(event),
      messageId: eventMessageId(
        type,
        this.init.userMessageId,
        this.init.assistantMessageId,
      ) || undefined,
      createdAt: new Date().toISOString(),
    });
  }

  async finish(reason: string): Promise<void> {
    if (!captureEnabled() || !supabaseReady()) return;
    if (this.started) await this.started;
    if (!this.anonUserId) return;

    try {
      const preparedContent = await this.prepareMessageContent(
        'assistant',
        this.init.assistantMessageId,
        this.assistantContent,
        {
          trace_id: this.traceUuid,
          finish_reason: reason,
        },
      );
      await postRows('chat_messages', {
        message_id: this.init.assistantMessageId,
        conversation_id: this.init.conversationId,
        anon_user_id: this.anonUserId,
        role: 'assistant',
        content: preparedContent.content,
        content_sha256: preparedContent.sha256,
        content_bytes: preparedContent.bytes,
        sort_order: null,
        model: this.init.heavyModel || null,
        usage: safeJson(this.usage) || {},
        source: 'orchestrate',
        metadata: {
          trace_id: this.traceUuid,
          finish_reason: reason,
          capture_version: 'v1',
          ...preparedContent.metadata,
        },
      }, {
        prefer: 'return=minimal,resolution=ignore-duplicates',
        onConflict: 'message_id',
      });

      const rows = await Promise.all(
        this.events.map((event) => this.eventRow(event)),
      );
      if (rows.length > 0) {
        await postRows('chat_events', rows, {
          prefer: 'return=minimal,resolution=ignore-duplicates',
          onConflict: 'trace_id,event_sequence',
        });
      }
    } catch (err) {
      captureLogger.warn('Failed to finish chat capture', {
        conversation_id: this.init.conversationId,
        trace_id: this.traceUuid,
        error: err,
      });
    }
  }

  private async startInner(): Promise<void> {
    const identity = await getAnalyticsIdentity(this.init.userId);
    this.anonUserId = identity.anonUserId;
    this.pepperVersion = identity.pepperVersion;

    const now = new Date().toISOString();
    await postRows('capture_subjects', {
      anon_user_id: this.anonUserId,
      user_id: this.init.userId,
      pepper_version: this.pepperVersion,
      last_seen_at: now,
      metadata: {},
    }, {
      prefer: 'return=minimal,resolution=merge-duplicates',
      onConflict: 'anon_user_id',
    });

    await postRows('chat_threads', {
      conversation_id: this.init.conversationId,
      anon_user_id: this.anonUserId,
      source: 'orchestrate',
      capture_region: 'us',
      trace_id: this.traceUuid,
      model_route: {
        interpreter_model: this.init.interpreterModel || null,
        heavy_model: this.init.heavyModel || null,
        inference: safeJson(this.init.inference),
      },
      scope: safeJson(this.init.scope) || {},
      metadata: {
        system_agent_context: safeJson(this.init.systemAgentContext),
        has_project_context: !!this.init.projectContext,
        active_widget_context_count: this.init.activeWidgetContexts?.length || 0,
        active_widget_contexts: summarizeActiveWidgetContexts(
          this.init.activeWidgetContexts,
        ),
        file_count: this.init.files?.length || 0,
        capture_version: 'v1',
      },
      updated_at: now,
      last_captured_at: now,
    }, {
      prefer: 'return=minimal,resolution=merge-duplicates',
      onConflict: 'conversation_id',
    });

    const preparedContent = await this.prepareMessageContent(
      'user',
      this.init.userMessageId,
      this.init.message,
      { trace_id: this.traceUuid },
    );
    await postRows('chat_messages', {
      message_id: this.init.userMessageId,
      conversation_id: this.init.conversationId,
      anon_user_id: this.anonUserId,
      role: 'user',
      content: preparedContent.content,
      content_sha256: preparedContent.sha256,
      content_bytes: preparedContent.bytes,
      sort_order: null,
      model: this.init.interpreterModel || null,
      usage: {},
      source: 'orchestrate',
      metadata: {
        trace_id: this.traceUuid,
        conversation_history_count: this.init.conversationHistory?.length || 0,
        active_widget_context_count: this.init.activeWidgetContexts?.length || 0,
        capture_version: 'v1',
        ...preparedContent.metadata,
      },
    }, {
      prefer: 'return=minimal,resolution=ignore-duplicates',
      onConflict: 'message_id',
    });

    await this.storeRequestArtifacts();
    this.observeEvent({
      type: 'orchestrate_request',
      message: this.init.message,
      conversationHistory: this.init.conversationHistory || [],
      interpreterModel: this.init.interpreterModel || null,
      heavyModel: this.init.heavyModel || null,
      inference: safeJson(this.init.inference),
      scope: safeJson(this.init.scope),
      systemAgentContext: safeJson(this.init.systemAgentContext),
      projectContextBytes: this.init.projectContext ? utf8ByteLength(this.init.projectContext) : 0,
      activeWidgetContextCount: this.init.activeWidgetContexts?.length || 0,
      activeWidgetContextBytes: safeJsonBytes(this.init.activeWidgetContexts || []),
      activeWidgetContexts: summarizeActiveWidgetContexts(
        this.init.activeWidgetContexts,
      ),
      files: (this.init.files || []).map((f) => ({
        name: f.name,
        size: f.size,
        mimeType: f.mimeType,
      })),
    });
  }

  private async storeRequestArtifacts(): Promise<void> {
    if (this.init.projectContext) {
      try {
        await storeTextArtifact({
          anonUserId: this.anonUserId,
          conversationId: this.init.conversationId,
          messageId: this.init.userMessageId,
          source: 'project_context',
          relationship: 'project_context',
          text: this.init.projectContext,
          originalFilename: 'project-context.txt',
          metadata: { trace_id: this.traceUuid },
        });
      } catch (err) {
        captureLogger.warn('Failed to store project context artifact', {
          conversation_id: this.init.conversationId,
          trace_id: this.traceUuid,
          error: err,
        });
      }
    }

    if (this.init.activeWidgetContexts?.length) {
      try {
        await storeTextArtifact({
          anonUserId: this.anonUserId,
          conversationId: this.init.conversationId,
          messageId: this.init.userMessageId,
          source: 'active_widget_context',
          relationship: 'active_widget_context',
          text: JSON.stringify(safeJson(this.init.activeWidgetContexts), null, 2),
          originalFilename: 'active-widget-contexts.json',
          metadata: { trace_id: this.traceUuid },
        });
      } catch (err) {
        captureLogger.warn('Failed to store active widget context artifact', {
          conversation_id: this.init.conversationId,
          trace_id: this.traceUuid,
          error: err,
        });
      }
    }

    for (const file of this.init.files || []) {
      const decoded = decodeDataUrlOrBase64(
        file.content,
        file.mimeType || 'application/octet-stream',
      );
      try {
        await storeCaptureArtifact({
          anonUserId: this.anonUserId,
          conversationId: this.init.conversationId,
          messageId: this.init.userMessageId,
          source: 'upload',
          relationship: 'uploaded_file',
          bytes: decoded.bytes,
          mimeType: decoded.mimeType || file.mimeType,
          originalFilename: file.name,
          metadata: {
            trace_id: this.traceUuid,
            claimed_size: file.size,
            claimed_mime_type: file.mimeType,
            encoding: decoded.encoding,
          },
        });
      } catch (err) {
        captureLogger.warn('Failed to store uploaded file artifact', {
          conversation_id: this.init.conversationId,
          trace_id: this.traceUuid,
          filename: file.name,
          error: err,
        });
      }
    }
  }

  private prepareMessageContent(
    role: 'user' | 'assistant',
    messageId: string,
    content: string,
    metadata: Record<string, unknown>,
  ): Promise<PreparedMessageContent> {
    return prepareCapturedContent({
      anonUserId: this.anonUserId,
      conversationId: this.init.conversationId,
      messageId,
      role,
      content,
      metadata,
      logContext: {
        conversation_id: this.init.conversationId,
        trace_id: this.traceUuid,
      },
    });
  }

  private async eventRow(event: PendingCaptureEvent): Promise<JsonRecord> {
    const payload = safeJson(event.payload) as JsonRecord;
    const payloadText = JSON.stringify(payload);
    const payloadHash = await sha256Text(payloadText);
    let storedPayload: unknown = payload;

    try {
      await this.storeEventArtifacts(event, payload, payloadHash);
    } catch (err) {
      captureLogger.warn('Failed to store event artifact', {
        conversation_id: this.init.conversationId,
        trace_id: this.traceUuid,
        event_id: event.id,
        event_type: event.type,
        error: err,
      });
    }

    if (utf8ByteLength(payloadText) > maxInlineBytes()) {
      const artifact = await storeTextArtifact({
        anonUserId: this.anonUserId,
        conversationId: this.init.conversationId,
        messageId: event.messageId,
        eventId: event.id,
        source: 'event_payload',
        relationship: 'raw_event_payload',
        text: payloadText,
        originalFilename: `${event.type}-${event.sequence}.json`,
        mimeType: 'application/json',
        metadata: {
          trace_id: this.traceUuid,
          event_type: event.type,
          event_sequence: event.sequence,
        },
      }).catch((err) => {
        captureLogger.warn('Failed to spill oversized event payload', {
          conversation_id: this.init.conversationId,
          trace_id: this.traceUuid,
          event_id: event.id,
          event_type: event.type,
          error: err,
        });
        return null;
      });
      if (artifact) {
        storedPayload = {
          _spilled_to_artifact: true,
          sha256: payloadHash,
          artifact_id: artifact.artifactId,
          storage_key: artifact.storageKey,
          size_bytes: utf8ByteLength(payloadText),
          preview: payloadText.slice(0, 1000),
        };
      }
    }

    return {
      id: event.id,
      trace_id: this.traceUuid,
      conversation_id: this.init.conversationId,
      message_id: event.messageId || null,
      anon_user_id: this.anonUserId,
      event_type: event.type,
      event_sequence: event.sequence,
      payload: storedPayload,
      payload_sha256: payloadHash,
      created_at: event.createdAt,
    };
  }

  private async storeEventArtifacts(
    event: PendingCaptureEvent,
    payload: JsonRecord,
    payloadHash: string,
  ): Promise<void> {
    if (event.type === 'plan_ready') {
      const plan = payload.plan as JsonRecord | undefined;
      const recipe = typeof plan?.recipe === 'string' ? plan.recipe : '';
      if (recipe) {
        await storeTextArtifact({
          anonUserId: this.anonUserId,
          conversationId: this.init.conversationId,
          messageId: event.messageId,
          eventId: event.id,
          source: 'execution_recipe',
          relationship: 'execution_recipe',
          text: recipe,
          originalFilename: `plan-${String(plan?.id || event.id)}.js`,
          mimeType: 'text/javascript',
          metadata: {
            trace_id: this.traceUuid,
            event_sequence: event.sequence,
            plan_id: plan?.id || null,
            tools_used: safeJson(plan?.tools_used),
            total_cost_light: plan?.total_cost_light ?? null,
          },
        });
      }
    }

    if (event.type === 'heavy_recipe' && typeof payload.code === 'string') {
      await storeTextArtifact({
        anonUserId: this.anonUserId,
        conversationId: this.init.conversationId,
        messageId: event.messageId,
        eventId: event.id,
        source: 'heavy_recipe',
        relationship: 'execution_recipe',
        text: payload.code,
        originalFilename: `heavy-recipe-${event.sequence}.js`,
        mimeType: 'text/javascript',
        metadata: {
          trace_id: this.traceUuid,
          event_sequence: event.sequence,
        },
      });
    }

    if (
      (event.type === 'exec_result' || event.type === 'result') &&
      payload.data !== undefined
    ) {
      const output = typeof payload.data === 'string'
        ? payload.data
        : JSON.stringify(payload.data, null, 2);
      await storeTextArtifact({
        anonUserId: this.anonUserId,
        conversationId: this.init.conversationId,
        messageId: event.messageId,
        eventId: event.id,
        source: 'tool_output',
        relationship: 'tool_output',
        text: output,
        originalFilename: `${event.type}-${event.sequence}.json`,
        mimeType: typeof payload.data === 'string' ? 'text/plain' : 'application/json',
        metadata: {
          trace_id: this.traceUuid,
          event_sequence: event.sequence,
          payload_sha256: payloadHash,
        },
      });
    }
  }
}

export function createOrchestrateCaptureSession(
  init: OrchestrateCaptureInit,
): OrchestrateCaptureSession | null {
  if (!captureEnabled()) return null;
  if (!supabaseReady()) {
    captureLogger.warn(
      'Chat capture is enabled but Supabase is not configured',
      {
        conversation_id: init.conversationId,
      },
    );
    return null;
  }
  return new OrchestrateCaptureSession(init);
}

type ProviderUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  total_cost?: number;
};

type ProviderStreamChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: unknown;
    };
    finish_reason?: string | null;
  }>;
  usage?: ProviderUsage;
  [key: string]: unknown;
};

export class ChatStreamCaptureSession {
  private readonly init: ChatStreamCaptureInit;
  private anonUserId = '';
  private pepperVersion = '';
  private started: Promise<void> | null = null;
  private sequence = 0;
  private events: PendingCaptureEvent[] = [];
  private assistantContent = '';
  private usage: ProviderUsage | null = null;
  private chunkCount = 0;
  private finishReason: string | null = null;
  private toolCallChunks: unknown[] = [];
  private finished = false;
  private readonly traceUuid: string;
  private readonly source: string;

  constructor(init: ChatStreamCaptureInit) {
    this.init = init;
    this.traceUuid = asUuid(init.traceId);
    this.source = init.source || 'chat_stream';
  }

  start(): void {
    if (!captureEnabled() || !supabaseReady()) return;
    if (!this.started) {
      this.started = this.startInner().catch((err) => {
        captureLogger.warn('Failed to start chat stream capture', {
          conversation_id: this.init.conversationId,
          trace_id: this.traceUuid,
          error: err,
        });
      });
    }
  }

  observeProviderChunk(chunk: ProviderStreamChunk): void {
    if (!captureEnabled()) return;
    this.chunkCount += 1;

    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (typeof delta?.content === 'string') {
      this.assistantContent += delta.content;
    }
    if (delta?.tool_calls !== undefined) {
      this.toolCallChunks.push(safeJson(delta.tool_calls));
    }
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      this.finishReason = choice.finish_reason;
    }
    if (chunk.usage) {
      this.setUsage(chunk.usage);
      this.recordEvent('chat_stream_usage', {
        usage: safeJson(chunk.usage),
        model: chunk.model || null,
        chunk_id: chunk.id || null,
      }, this.init.assistantMessageId);
    }
  }

  setUsage(usage: ProviderUsage): void {
    this.usage = usage;
  }

  observeError(message: string, metadata: Record<string, unknown> = {}): void {
    if (!captureEnabled()) return;
    this.recordEvent('chat_stream_error', {
      message,
      ...metadata,
    }, this.init.assistantMessageId);
    if (!this.assistantContent) {
      this.assistantContent = `**Error:** ${message}`;
    }
  }

  async finish(reason: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (!captureEnabled() || !supabaseReady()) return;
    if (this.started) await this.started;
    if (!this.anonUserId) return;

    try {
      this.recordEvent('chat_stream_done', {
        reason,
        finish_reason: this.finishReason,
        chunk_count: this.chunkCount,
        usage: safeJson(this.usage),
      }, this.init.assistantMessageId);

      const preparedContent = await prepareCapturedContent({
        anonUserId: this.anonUserId,
        conversationId: this.init.conversationId,
        messageId: this.init.assistantMessageId,
        role: 'assistant',
        content: this.assistantContent,
        metadata: {
          trace_id: this.traceUuid,
          finish_reason: this.finishReason,
          source: this.source,
        },
        logContext: {
          conversation_id: this.init.conversationId,
          trace_id: this.traceUuid,
        },
      });

      await postRows('chat_messages', {
        message_id: this.init.assistantMessageId,
        conversation_id: this.init.conversationId,
        anon_user_id: this.anonUserId,
        role: 'assistant',
        content: preparedContent.content,
        content_sha256: preparedContent.sha256,
        content_bytes: preparedContent.bytes,
        sort_order: this.init.messages.length,
        model: this.init.resolvedModel,
        usage: safeJson(this.usage) || {},
        source: this.source,
        metadata: {
          trace_id: this.traceUuid,
          finish_reason: this.finishReason,
          provider_chunk_count: this.chunkCount,
          tool_call_chunks: safeJson(this.toolCallChunks),
          capture_version: 'v1',
          ...preparedContent.metadata,
        },
      }, {
        prefer: 'return=minimal,resolution=ignore-duplicates',
        onConflict: 'message_id',
      });

      if (this.events.length > 0) {
        const rows = await Promise.all(this.events.map((event) => this.eventRow(event)));
        await postRows('chat_events', rows, {
          prefer: 'return=minimal,resolution=ignore-duplicates',
          onConflict: 'trace_id,event_sequence',
        });
      }
    } catch (err) {
      captureLogger.warn('Failed to finish chat stream capture', {
        conversation_id: this.init.conversationId,
        trace_id: this.traceUuid,
        error: err,
      });
    }
  }

  private async startInner(): Promise<void> {
    const identity = await getAnalyticsIdentity(this.init.userId);
    this.anonUserId = identity.anonUserId;
    this.pepperVersion = identity.pepperVersion;

    const now = new Date().toISOString();
    await postRows('capture_subjects', {
      anon_user_id: this.anonUserId,
      user_id: this.init.userId,
      pepper_version: this.pepperVersion,
      last_seen_at: now,
      metadata: {},
    }, {
      prefer: 'return=minimal,resolution=merge-duplicates',
      onConflict: 'anon_user_id',
    });

    await postRows('chat_threads', {
      conversation_id: this.init.conversationId,
      anon_user_id: this.anonUserId,
      source: this.source,
      capture_region: 'us',
      trace_id: this.traceUuid,
      model_route: {
        requested_model: this.init.requestedModel,
        resolved_model: this.init.resolvedModel,
        provider: this.init.provider,
        billing_mode: this.init.billingMode,
        key_source: this.init.keySource,
        inference: safeJson(this.init.inference),
      },
      scope: {},
      metadata: {
        user_email_present: !!this.init.userEmail,
        message_count: this.init.messages.length,
        tool_count: this.init.tools?.length || 0,
        temperature: this.init.temperature ?? null,
        max_tokens: this.init.maxTokens ?? null,
        capture_version: 'v1',
      },
      updated_at: now,
      last_captured_at: now,
    }, {
      prefer: 'return=minimal,resolution=merge-duplicates',
      onConflict: 'conversation_id',
    });

    const rows = await Promise.all(
      this.init.messages.map((message, index) => this.messageRow(message, index)),
    );
    if (rows.length > 0) {
      await postRows('chat_messages', rows, {
        prefer: 'return=minimal,resolution=ignore-duplicates',
        onConflict: 'message_id',
      });
    }

    this.recordEvent('chat_stream_request', {
      requested_model: this.init.requestedModel,
      resolved_model: this.init.resolvedModel,
      provider: this.init.provider,
      billing_mode: this.init.billingMode,
      key_source: this.init.keySource,
      message_count: this.init.messages.length,
      tool_count: this.init.tools?.length || 0,
      tools: safeJson(this.init.tools || []),
    });
  }

  private async messageRow(message: ChatMessage, index: number): Promise<JsonRecord> {
    const messageId = `${this.traceUuid}:input:${index}`;
    const content = message.content || '';
    const preparedContent = await prepareCapturedContent({
      anonUserId: this.anonUserId,
      conversationId: this.init.conversationId,
      messageId,
      role: message.role,
      content,
      metadata: {
        trace_id: this.traceUuid,
        source: this.source,
        request_message_index: index,
      },
      logContext: {
        conversation_id: this.init.conversationId,
        trace_id: this.traceUuid,
      },
    });

    return {
      message_id: messageId,
      conversation_id: this.init.conversationId,
      anon_user_id: this.anonUserId,
      role: message.role,
      content: preparedContent.content,
      content_sha256: preparedContent.sha256,
      content_bytes: preparedContent.bytes,
      sort_order: index,
      model: index === this.init.messages.length - 1 ? this.init.requestedModel : null,
      usage: {},
      source: this.source,
      metadata: {
        trace_id: this.traceUuid,
        request_message_index: index,
        name: message.name || null,
        tool_call_id: message.tool_call_id || null,
        tool_calls: safeJson(message.tool_calls || []),
        capture_version: 'v1',
        ...preparedContent.metadata,
      },
    };
  }

  private recordEvent(
    type: string,
    payload: unknown,
    messageId?: string,
  ): void {
    this.events.push({
      id: crypto.randomUUID(),
      type,
      sequence: this.sequence++,
      payload: safeJson(payload),
      messageId,
      createdAt: new Date().toISOString(),
    });
  }

  private async eventRow(event: PendingCaptureEvent): Promise<JsonRecord> {
    const payload = safeJson(event.payload) as JsonRecord;
    const payloadText = JSON.stringify(payload);
    const payloadHash = await sha256Text(payloadText);
    let storedPayload: unknown = payload;

    if (utf8ByteLength(payloadText) > maxInlineBytes()) {
      const artifact = await storeTextArtifact({
        anonUserId: this.anonUserId,
        conversationId: this.init.conversationId,
        messageId: event.messageId,
        eventId: event.id,
        source: 'event_payload',
        relationship: 'raw_event_payload',
        text: payloadText,
        originalFilename: `${event.type}-${event.sequence}.json`,
        mimeType: 'application/json',
        metadata: {
          trace_id: this.traceUuid,
          event_type: event.type,
          event_sequence: event.sequence,
          source: this.source,
        },
      }).catch((err) => {
        captureLogger.warn('Failed to spill oversized chat stream event payload', {
          conversation_id: this.init.conversationId,
          trace_id: this.traceUuid,
          event_id: event.id,
          event_type: event.type,
          error: err,
        });
        return null;
      });
      if (artifact) {
        storedPayload = {
          _spilled_to_artifact: true,
          sha256: payloadHash,
          artifact_id: artifact.artifactId,
          storage_key: artifact.storageKey,
          size_bytes: utf8ByteLength(payloadText),
          preview: payloadText.slice(0, 1000),
        };
      }
    }

    return {
      id: event.id,
      trace_id: this.traceUuid,
      conversation_id: this.init.conversationId,
      message_id: event.messageId || null,
      anon_user_id: this.anonUserId,
      event_type: event.type,
      event_sequence: event.sequence,
      payload: storedPayload,
      payload_sha256: payloadHash,
      created_at: event.createdAt,
    };
  }
}

export function createChatStreamCaptureSession(
  init: ChatStreamCaptureInit,
): ChatStreamCaptureSession | null {
  if (!captureEnabled()) return null;
  if (!supabaseReady()) {
    captureLogger.warn(
      'Chat stream capture is enabled but Supabase is not configured',
      {
        conversation_id: init.conversationId,
      },
    );
    return null;
  }
  return new ChatStreamCaptureSession(init);
}
