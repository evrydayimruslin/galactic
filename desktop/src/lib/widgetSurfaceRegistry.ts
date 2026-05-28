import type {
  WidgetActionDeclaration,
  WidgetActionInvocation,
  WidgetActionResult,
  WidgetStateSnapshot,
  WidgetSurfaceEvent,
} from '../../../shared/contracts/widget.ts';
import type {
  ActiveAgenticSurface,
  ActiveGeneratedInterfaceSurface,
  ActiveWidgetSurface,
  AgenticSurfaceListener,
  RegisterWidgetSurfaceInput,
  RegisterGeneratedInterfaceSurfaceInput,
  WidgetBridgeMessage,
  WidgetSurfaceCommand,
  WidgetSurfaceCommandListener,
  WidgetSurfaceListener,
  WidgetSurfaceStatus,
} from './widgetAgentTypes';
import {
  agenticInterfaceActionsToWidgetActions,
  isGeneratedInterfaceSurface,
  isWidgetSurface,
} from './widgetAgentTypes';

const CHANNEL_NAME = 'ul-widget-surface-registry';
const STORAGE_KEY = 'ul_widget_surface_registry_v1';
const SURFACE_CHANGED_EVENT = 'ul-widget-surfaces-changed';
export const WIDGET_SURFACE_COMMAND_EVENT = 'ul-widget-surface-command';
export const WIDGET_SURFACE_MAX_EVENTS = 50;

const registryId = randomId('registry');
const surfaces = new Map<string, ActiveAgenticSurface>();
const widgetListeners = new Set<WidgetSurfaceListener>();
const agenticListeners = new Set<AgenticSurfaceListener>();
const commandListeners = new Set<WidgetSurfaceCommandListener>();
const actionWaiters = new Map<string, {
  resolve: (result: WidgetActionResult) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}>();
let channel: BroadcastChannel | null | undefined;
let initialized = false;

type RegistryBroadcastMessage =
  | { originId: string; type: 'upsert'; surface: ActiveAgenticSurface }
  | { originId: string; type: 'remove'; surfaceId: string }
  | { originId: string; type: 'command'; command: WidgetSurfaceCommand };

type RegistryBroadcastPayload =
  | { type: 'upsert'; surface: ActiveAgenticSurface }
  | { type: 'remove'; surfaceId: string }
  | { type: 'command'; command: WidgetSurfaceCommand };

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function hasLocalStorage(): boolean {
  return typeof globalThis !== 'undefined' && 'localStorage' in globalThis;
}

function randomId(prefix: string): string {
  const cryptoLike = globalThis.crypto;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') {
    return `${prefix}-${cryptoLike.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createWidgetSurfaceId(kind: string, appUuid: string, widgetName: string): string {
  const appPart = appUuid ? appUuid.slice(0, 8) : 'app';
  const widgetPart = widgetName || 'widget';
  return `widget-${kind}-${appPart}-${widgetPart}-${randomId('surface').slice(8)}`;
}

export function createGeneratedInterfaceSurfaceId(interfaceId: string): string {
  const interfacePart = interfaceId || 'interface';
  return `generated-interface-${interfacePart}-${randomId('surface').slice(8)}`;
}

function normalizeSurface(surface: ActiveAgenticSurface): ActiveAgenticSurface {
  const surfaceType = surface.surfaceType || (isRecord((surface as { source?: unknown }).source)
    ? 'widget'
    : 'generated_interface');
  const normalized = {
    ...surface,
    surfaceType,
    snapshot: surface.snapshot ?? null,
    actions: Array.isArray(surface.actions) ? surface.actions : [],
    events: Array.isArray(surface.events) ? surface.events : [],
  } as ActiveAgenticSurface;
  normalized.events = normalized.events
    .slice(-WIDGET_SURFACE_MAX_EVENTS)
    .map((event) => normalizeSurfaceEvent(normalized, event));
  return normalized;
}

function readStoredSurfaces(): ActiveAgenticSurface[] {
  if (!hasLocalStorage()) return [];
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((surface): surface is ActiveAgenticSurface =>
        surface &&
        typeof surface === 'object' &&
        typeof surface.surfaceId === 'string' &&
        ((surface.source && typeof surface.source === 'object') ||
          (surface.generatedInterface && typeof surface.generatedInterface === 'object'))
      )
      .map(normalizeSurface);
  } catch {
    return [];
  }
}

function writeStoredSurfaces(): void {
  if (!hasLocalStorage()) return;
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(getActiveAgenticSurfaces()));
  } catch {
    // Best effort only; the in-memory registry remains canonical in this window.
  }
}

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (typeof BroadcastChannel === 'undefined') {
    channel = null;
    return channel;
  }

  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<RegistryBroadcastMessage>) => {
      const message = event.data;
      if (!message || message.originId === registryId) return;
      applyBroadcastMessage(message);
    };
  } catch {
    channel = null;
  }
  return channel;
}

function postBroadcast(message: RegistryBroadcastPayload): void {
  const fullMessage = { ...message, originId: registryId } as RegistryBroadcastMessage;
  getChannel()?.postMessage(fullMessage);
}

function dispatchChanged(): void {
  const snapshot = getActiveAgenticSurfaces();
  const widgetSnapshot = snapshot.filter(isWidgetSurface);
  for (const listener of widgetListeners) listener(widgetSnapshot);
  for (const listener of agenticListeners) listener(snapshot);
  if (hasWindow() && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent(SURFACE_CHANGED_EVENT, { detail: { surfaces: snapshot } }));
  }
}

function upsertSurface(
  surface: ActiveAgenticSurface,
  options: { broadcast?: boolean } = {},
): ActiveAgenticSurface {
  const normalized = normalizeSurface(surface);
  surfaces.set(normalized.surfaceId, normalized);
  writeStoredSurfaces();
  if (options.broadcast !== false) {
    postBroadcast({ type: 'upsert', surface: normalized });
  }
  dispatchChanged();
  return normalized;
}

function applyBroadcastMessage(message: RegistryBroadcastMessage): void {
  if (message.type === 'upsert') {
    surfaces.set(message.surface.surfaceId, normalizeSurface(message.surface));
    writeStoredSurfaces();
    dispatchChanged();
    return;
  }

  if (message.type === 'remove') {
    surfaces.delete(message.surfaceId);
    writeStoredSurfaces();
    dispatchChanged();
    return;
  }

  if (message.type === 'command') {
    dispatchCommandLocally(message.command);
  }
}

function setupRegistry(): void {
  if (initialized) return;
  initialized = true;

  for (const surface of readStoredSurfaces()) {
    surfaces.set(surface.surfaceId, surface);
  }

  getChannel();

  if (hasWindow()) {
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY) return;
      surfaces.clear();
      for (const surface of readStoredSurfaces()) {
        surfaces.set(surface.surfaceId, surface);
      }
      dispatchChanged();
    });
  }
}

function resolveSurfaceId(data: { surfaceId?: unknown; surface_id?: unknown }, fallbackSurfaceId?: string): string | null {
  if (typeof data.surfaceId === 'string' && data.surfaceId.trim()) return data.surfaceId.trim();
  if (typeof data.surface_id === 'string' && data.surface_id.trim()) return data.surface_id.trim();
  return fallbackSurfaceId ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function actionWaiterKey(surfaceId: string, actionId: string, turnId: string): string {
  return `${surfaceId}:${actionId}:${turnId}`;
}

function normalizeCommandTurnId(command: WidgetActionInvocation): WidgetSurfaceCommand {
  if (command.turn_id) return command;
  return { ...command, turn_id: randomId('turn') };
}

function normalizeSurfaceEvent(
  surface: ActiveAgenticSurface,
  event: WidgetSurfaceEvent,
): WidgetSurfaceEvent {
  const widgetId = isWidgetSurface(surface)
    ? surface.source.widgetName
    : surface.generatedInterface.id;
  return {
    ...event,
    id: event.id || randomId('event'),
    surface_id: event.surface_id || surface.surfaceId,
    widget_id: event.widget_id || widgetId,
    interface_id: event.interface_id ||
      (isGeneratedInterfaceSurface(surface) ? surface.generatedInterface.id : undefined),
    created_at: event.created_at || new Date().toISOString(),
  };
}

export function registerWidgetSurface(input: RegisterWidgetSurfaceInput): ActiveWidgetSurface {
  setupRegistry();
  const now = Date.now();
  const surfaceId = input.surfaceId ||
    createWidgetSurfaceId(input.kind, input.source.appUuid, input.source.widgetName);
  const existing = surfaces.get(surfaceId);
  const widgetExisting = existing && isWidgetSurface(existing) ? existing : null;

  return upsertSurface({
    surfaceId,
    kind: input.kind,
    surfaceType: 'widget',
    source: input.source,
    context: input.context,
    status: widgetExisting?.status ?? 'opening',
    snapshot: widgetExisting?.snapshot ?? null,
    actions: widgetExisting?.actions ?? [],
    events: widgetExisting?.events ?? [],
    latestDataPayload: input.latestDataPayload ?? widgetExisting?.latestDataPayload ?? null,
    registeredAt: widgetExisting?.registeredAt ?? now,
    updatedAt: now,
  }) as ActiveWidgetSurface;
}

export function registerGeneratedInterfaceSurface(
  input: RegisterGeneratedInterfaceSurfaceInput,
): ActiveGeneratedInterfaceSurface {
  setupRegistry();
  const now = Date.now();
  const surfaceId = input.surfaceId || createGeneratedInterfaceSurfaceId(input.spec.id);
  const existing = surfaces.get(surfaceId);
  const generatedExisting = existing && isGeneratedInterfaceSurface(existing)
    ? existing
    : null;

  return upsertSurface({
    surfaceId,
    kind: 'generated_interface',
    surfaceType: 'generated_interface',
    generatedInterface: {
      id: input.spec.id,
      title: input.spec.title,
      description: input.spec.description,
      mode: input.spec.mode,
    },
    status: input.status ?? generatedExisting?.status ?? 'ready',
    snapshot: input.snapshot ?? generatedExisting?.snapshot ?? null,
    actions: agenticInterfaceActionsToWidgetActions(input.spec.actions),
    events: generatedExisting?.events ?? [],
    latestDataPayload: generatedExisting?.latestDataPayload ?? null,
    registeredAt: generatedExisting?.registeredAt ?? now,
    updatedAt: now,
  }) as ActiveGeneratedInterfaceSurface;
}

export function unregisterWidgetSurface(surfaceId: string): void {
  setupRegistry();
  surfaces.delete(surfaceId);
  writeStoredSurfaces();
  postBroadcast({ type: 'remove', surfaceId });
  dispatchChanged();
}

export const unregisterAgenticSurface = unregisterWidgetSurface;

export function updateWidgetSurfaceStatus(surfaceId: string, status: WidgetSurfaceStatus): ActiveWidgetSurface | null {
  setupRegistry();
  const surface = surfaces.get(surfaceId);
  if (!surface || !isWidgetSurface(surface)) return null;
  return upsertSurface({ ...surface, status, updatedAt: Date.now() }) as ActiveWidgetSurface;
}

export function updateGeneratedInterfaceSurfaceStatus(
  surfaceId: string,
  status: WidgetSurfaceStatus,
): ActiveGeneratedInterfaceSurface | null {
  setupRegistry();
  const surface = surfaces.get(surfaceId);
  if (!surface || !isGeneratedInterfaceSurface(surface)) return null;
  return upsertSurface({ ...surface, status, updatedAt: Date.now() }) as ActiveGeneratedInterfaceSurface;
}

export function updateWidgetSurfaceSnapshot(
  surfaceId: string,
  snapshot: WidgetStateSnapshot,
): ActiveWidgetSurface | null {
  setupRegistry();
  const surface = surfaces.get(surfaceId);
  if (!surface || !isWidgetSurface(surface)) return null;
  return upsertSurface({
    ...surface,
    snapshot,
    status: surface.status === 'opening' ? 'ready' : surface.status,
    updatedAt: Date.now(),
  }) as ActiveWidgetSurface;
}

export function updateGeneratedInterfaceSurfaceSnapshot(
  surfaceId: string,
  snapshot: WidgetStateSnapshot,
): ActiveGeneratedInterfaceSurface | null {
  setupRegistry();
  const surface = surfaces.get(surfaceId);
  if (!surface || !isGeneratedInterfaceSurface(surface)) return null;
  return upsertSurface({
    ...surface,
    snapshot,
    status: surface.status === 'opening' ? 'ready' : surface.status,
    updatedAt: Date.now(),
  }) as ActiveGeneratedInterfaceSurface;
}

export function updateWidgetSurfaceActions(
  surfaceId: string,
  actions: WidgetActionDeclaration[],
): ActiveWidgetSurface | null {
  setupRegistry();
  const surface = surfaces.get(surfaceId);
  if (!surface || !isWidgetSurface(surface)) return null;
  return upsertSurface({
    ...surface,
    actions: Array.isArray(actions) ? actions : [],
    updatedAt: Date.now(),
  }) as ActiveWidgetSurface;
}

export function appendWidgetSurfaceEvent(
  surfaceId: string,
  event: WidgetSurfaceEvent,
): ActiveWidgetSurface | null {
  setupRegistry();
  const surface = surfaces.get(surfaceId);
  if (!surface || !isWidgetSurface(surface)) return null;
  const normalizedEvent = normalizeSurfaceEvent(surface, event);
  return upsertSurface({
    ...surface,
    events: [...surface.events, normalizedEvent].slice(-WIDGET_SURFACE_MAX_EVENTS),
    updatedAt: Date.now(),
  }) as ActiveWidgetSurface;
}

export function appendGeneratedInterfaceSurfaceEvent(
  surfaceId: string,
  event: WidgetSurfaceEvent,
): ActiveGeneratedInterfaceSurface | null {
  setupRegistry();
  const surface = surfaces.get(surfaceId);
  if (!surface || !isGeneratedInterfaceSurface(surface)) return null;
  const normalizedEvent = normalizeSurfaceEvent(surface, event);
  return upsertSurface({
    ...surface,
    events: [...surface.events, normalizedEvent].slice(-WIDGET_SURFACE_MAX_EVENTS),
    updatedAt: Date.now(),
  }) as ActiveGeneratedInterfaceSurface;
}

export function recordWidgetActionResult(
  surfaceId: string,
  result: WidgetActionResult,
): ActiveWidgetSurface | null {
  setupRegistry();
  const surface = surfaces.get(surfaceId);
  if (!surface || !isWidgetSurface(surface)) return null;
  const normalizedResult: WidgetActionResult = {
    ...result,
    surface_id: result.surface_id ?? surfaceId,
    widget_id: result.widget_id ?? surface.source.widgetName,
  };

  const event = {
    ...(normalizedResult.event ?? {}),
    kind: normalizedResult.event?.kind ?? (normalizedResult.ok ? 'agent' : 'error'),
    action_id: normalizedResult.event?.action_id ?? normalizedResult.action_id,
    turn_id: normalizedResult.event?.turn_id ?? normalizedResult.turn_id,
    result: normalizedResult.event?.result ?? normalizedResult.data,
    error: normalizedResult.event?.error ?? normalizedResult.error,
    snapshot: normalizedResult.event?.snapshot ?? normalizedResult.snapshot,
    created_at: normalizedResult.event?.created_at ?? new Date().toISOString(),
  } satisfies WidgetSurfaceEvent;
  const normalizedEvent = normalizeSurfaceEvent(surface, event);

  const updatedSurface = upsertSurface({
    ...surface,
    snapshot: normalizedResult.snapshot ?? surface.snapshot,
    events: [...surface.events, normalizedEvent].slice(-WIDGET_SURFACE_MAX_EVENTS),
    updatedAt: Date.now(),
  });

  if (normalizedResult.turn_id) {
    const key = actionWaiterKey(surfaceId, normalizedResult.action_id, normalizedResult.turn_id);
    const waiter = actionWaiters.get(key);
    if (waiter) {
      clearTimeout(waiter.timeoutId);
      actionWaiters.delete(key);
      waiter.resolve(normalizedResult);
    }
  }

  return updatedSurface as ActiveWidgetSurface;
}

export function handleWidgetBridgeMessage(data: unknown, fallbackSurfaceId?: string): boolean {
  setupRegistry();
  if (!isRecord(data) || typeof data.type !== 'string') return false;
  const message = data as WidgetBridgeMessage;
  const surfaceId = resolveSurfaceId(message, fallbackSurfaceId);
  if (!surfaceId) return false;

  if (message.type === 'ul-widget-state') {
    const snapshot = message.snapshot ?? message.state;
    if (isRecord(snapshot)) {
      updateWidgetSurfaceSnapshot(surfaceId, snapshot as WidgetStateSnapshot);
      return true;
    }
  }

  if (message.type === 'ul-widget-actions') {
    if (Array.isArray(message.actions)) {
      updateWidgetSurfaceActions(surfaceId, message.actions);
      return true;
    }
  }

  if (message.type === 'ul-widget-event') {
    if (isRecord(message.event)) {
      appendWidgetSurfaceEvent(surfaceId, message.event as WidgetSurfaceEvent);
      return true;
    }
  }

  if (message.type === 'ul-widget-action-result') {
    if (isRecord(message.result)) {
      recordWidgetActionResult(surfaceId, message.result as WidgetActionResult);
      return true;
    }
  }

  return false;
}

export function getWidgetSurface(surfaceId: string): ActiveWidgetSurface | null {
  setupRegistry();
  const surface = surfaces.get(surfaceId);
  return surface && isWidgetSurface(surface) ? surface : null;
}

export function getActiveWidgetSurfaces(): ActiveWidgetSurface[] {
  setupRegistry();
  return [...surfaces.values()]
    .filter(isWidgetSurface)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getGeneratedInterfaceSurface(
  surfaceId: string,
): ActiveGeneratedInterfaceSurface | null {
  setupRegistry();
  const surface = surfaces.get(surfaceId);
  return surface && isGeneratedInterfaceSurface(surface) ? surface : null;
}

export function getActiveAgenticSurfaces(): ActiveAgenticSurface[] {
  setupRegistry();
  return [...surfaces.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function subscribeWidgetSurfaces(listener: WidgetSurfaceListener): () => void {
  setupRegistry();
  widgetListeners.add(listener);
  listener(getActiveWidgetSurfaces());
  return () => {
    widgetListeners.delete(listener);
  };
}

export function subscribeAgenticSurfaces(listener: AgenticSurfaceListener): () => void {
  setupRegistry();
  agenticListeners.add(listener);
  listener(getActiveAgenticSurfaces());
  return () => {
    agenticListeners.delete(listener);
  };
}

function dispatchCommandLocally(command: WidgetSurfaceCommand): void {
  for (const listener of commandListeners) listener(command);
  if (hasWindow() && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent(WIDGET_SURFACE_COMMAND_EVENT, { detail: command }));
  }
}

export function dispatchWidgetSurfaceCommand(command: WidgetActionInvocation): void {
  setupRegistry();
  dispatchCommandLocally(command);
  postBroadcast({ type: 'command', command });
}

export function buildWidgetSurfaceCommandMessage(command: WidgetSurfaceCommand): Record<string, unknown> {
  const message: Record<string, unknown> = {
    type: 'ul-widget-command',
    surface_id: command.surface_id,
    surfaceId: command.surface_id,
    widget_id: command.widget_id,
    widgetId: command.widget_id,
    action_id: command.action_id,
    actionId: command.action_id,
    args: command.args || {},
    turn_id: command.turn_id,
    turnId: command.turn_id,
    source: command.source,
  };
  if (command.agentic_surface_id) {
    message.agentic_surface_id = command.agentic_surface_id;
    message.agenticSurfaceId = command.agentic_surface_id;
  }
  if (command.agentic_interface_id) {
    message.agentic_interface_id = command.agentic_interface_id;
    message.agenticInterfaceId = command.agentic_interface_id;
  }
  if (command.agentic_action_id) {
    message.agentic_action_id = command.agentic_action_id;
    message.agenticActionId = command.agentic_action_id;
  }
  if (command.agentic_component_id) {
    message.agentic_component_id = command.agentic_component_id;
    message.agenticComponentId = command.agentic_component_id;
  }
  return message;
}

export function invokeWidgetSurfaceAction(
  command: WidgetActionInvocation,
  timeoutMs = 30_000,
): Promise<WidgetActionResult> {
  setupRegistry();
  const normalizedCommand = normalizeCommandTurnId(command);
  const turnId = normalizedCommand.turn_id as string;
  const surface = surfaces.get(normalizedCommand.surface_id);
  if (!surface || !isWidgetSurface(surface)) {
    return Promise.resolve({
      surface_id: normalizedCommand.surface_id,
      widget_id: normalizedCommand.widget_id,
      action_id: normalizedCommand.action_id,
      turn_id: turnId,
      ok: false,
      error: 'Widget surface is not active.',
    });
  }

  const key = actionWaiterKey(
    normalizedCommand.surface_id,
    normalizedCommand.action_id,
    turnId,
  );

  const resultPromise = new Promise<WidgetActionResult>((resolve) => {
    const timeoutId = setTimeout(() => {
      if (!actionWaiters.delete(key)) return;
      const timeoutResult: WidgetActionResult = {
        surface_id: normalizedCommand.surface_id,
        widget_id: normalizedCommand.widget_id,
        action_id: normalizedCommand.action_id,
        turn_id: turnId,
        ok: false,
        error: 'Widget action timed out.',
      };
      recordWidgetActionResult(normalizedCommand.surface_id, timeoutResult);
      resolve(timeoutResult);
    }, timeoutMs);

    actionWaiters.set(key, { resolve, timeoutId });
  });

  appendWidgetSurfaceEvent(normalizedCommand.surface_id, {
    kind: normalizedCommand.source === 'user' ? 'user' : 'agent',
    action_id: normalizedCommand.action_id,
    turn_id: turnId,
    input: normalizedCommand.args,
    label: `Invoked ${normalizedCommand.action_id}`,
    created_at: new Date().toISOString(),
  });
  dispatchWidgetSurfaceCommand(normalizedCommand);

  return resultPromise;
}

export function subscribeWidgetSurfaceCommands(listener: WidgetSurfaceCommandListener): () => void {
  setupRegistry();
  commandListeners.add(listener);
  return () => {
    commandListeners.delete(listener);
  };
}

export function clearWidgetSurfaceRegistryForTests(): void {
  surfaces.clear();
  widgetListeners.clear();
  agenticListeners.clear();
  commandListeners.clear();
  for (const waiter of actionWaiters.values()) {
    clearTimeout(waiter.timeoutId);
  }
  actionWaiters.clear();
  writeStoredSurfaces();
}
