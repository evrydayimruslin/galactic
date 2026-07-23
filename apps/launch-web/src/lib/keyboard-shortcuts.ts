export const LAUNCH_SHORTCUT_ACTIONS = [
  "search",
  "alerts",
  "settings",
  "agent-1",
  "agent-2",
  "agent-3",
  "agent-4",
  "agent-5",
  "agent-6",
  "agent-7",
  "agent-8",
  "agent-9",
  "agent-10",
  "help",
  "dismiss",
] as const;

export type LaunchShortcutAction = typeof LAUNCH_SHORTCUT_ACTIONS[number];

export type LaunchAgentShortcutPosition =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10;

export interface LaunchShortcutConfiguration {
  enabled: boolean;
  bindings: Readonly<Record<LaunchShortcutAction, string | null>>;
}

export interface LaunchShortcutPreferences {
  enabled?: boolean;
  bindings?: Partial<Record<LaunchShortcutAction, string | null>>;
}

export type LaunchShortcutValidationIssueCode =
  | "invalid_type"
  | "unknown_field"
  | "unknown_action"
  | "invalid_key"
  | "duplicate_key";

export interface LaunchShortcutValidationIssue {
  code: LaunchShortcutValidationIssueCode;
  message: string;
  path: string;
}

export type LaunchShortcutValidationResult =
  | {
    valid: true;
    value: LaunchShortcutConfiguration;
  }
  | {
    valid: false;
    issues: LaunchShortcutValidationIssue[];
  };

export class LaunchShortcutConfigurationError extends Error {
  readonly issues: readonly LaunchShortcutValidationIssue[];

  constructor(issues: readonly LaunchShortcutValidationIssue[]) {
    super("Keyboard shortcut preferences are invalid.");
    this.name = "LaunchShortcutConfigurationError";
    this.issues = issues;
  }
}

export interface LaunchShortcutEventLike {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  metaKey?: boolean;
  repeat?: boolean;
  shiftKey?: boolean;
  target?: unknown;
}

export interface LaunchShortcutResolutionContext {
  activeElement?: unknown;
  config?: LaunchShortcutConfiguration;
  dialogActive?: boolean;
}

const ACTION_SET = new Set<string>(LAUNCH_SHORTCUT_ACTIONS);
const PREFERENCE_KEYS = new Set(["enabled", "bindings"]);
const EDITABLE_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA"]);
const EDITABLE_ROLES = new Set(["combobox", "searchbox", "textbox"]);
const MAX_TARGET_ANCESTORS = 32;

const DEFAULT_BINDINGS: Record<LaunchShortcutAction, string | null> = {
  search: "k",
  alerts: "a",
  settings: "s",
  "agent-1": "1",
  "agent-2": "2",
  "agent-3": "3",
  "agent-4": "4",
  "agent-5": "5",
  "agent-6": "6",
  "agent-7": "7",
  "agent-8": "8",
  "agent-9": "9",
  "agent-10": "0",
  help: "?",
  dismiss: "Escape",
};

export const DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION:
  LaunchShortcutConfiguration = Object.freeze({
    enabled: true,
    bindings: Object.freeze({ ...DEFAULT_BINDINGS }),
  });

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function normalizedShortcutKey(value: unknown): string | null {
  if (typeof value !== "string" || value !== value.trim()) return null;
  if (value === "Escape") return value;

  const characters = [...value];
  if (
    characters.length !== 1 ||
    /\s/u.test(value) ||
    hasControlCharacter(value) ||
    value === "+"
  ) {
    return null;
  }
  return /^[A-Z]$/u.test(value) ? value.toLowerCase() : value;
}

function issue(
  issues: LaunchShortcutValidationIssue[],
  code: LaunchShortcutValidationIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function frozenConfiguration(
  enabled: boolean,
  bindings: Record<LaunchShortcutAction, string | null>,
): LaunchShortcutConfiguration {
  return Object.freeze({
    enabled,
    bindings: Object.freeze({ ...bindings }),
  });
}

/**
 * Strictly validates persisted or user-provided shortcut preferences and
 * returns the fully resolved mapping. Partial bindings override the defaults;
 * `null` disables one action. Ambiguous duplicate keys are never accepted.
 */
export function validateLaunchShortcutPreferences(
  preferences: unknown = {},
): LaunchShortcutValidationResult {
  const issues: LaunchShortcutValidationIssue[] = [];
  if (!isPlainRecord(preferences)) {
    return {
      valid: false,
      issues: [{
        code: "invalid_type",
        path: "$",
        message: "Shortcut preferences must be an object.",
      }],
    };
  }

  for (const key of Object.keys(preferences)) {
    if (!PREFERENCE_KEYS.has(key)) {
      issue(
        issues,
        "unknown_field",
        `$.${key}`,
        `Unknown shortcut preference field: ${key}.`,
      );
    }
  }

  let enabled = true;
  if (Object.prototype.hasOwnProperty.call(preferences, "enabled")) {
    if (typeof preferences.enabled !== "boolean") {
      issue(
        issues,
        "invalid_type",
        "$.enabled",
        "Shortcut enabled state must be a boolean.",
      );
    } else {
      enabled = preferences.enabled;
    }
  }

  const bindings = { ...DEFAULT_BINDINGS };
  if (Object.prototype.hasOwnProperty.call(preferences, "bindings")) {
    if (!isPlainRecord(preferences.bindings)) {
      issue(
        issues,
        "invalid_type",
        "$.bindings",
        "Shortcut bindings must be an object.",
      );
    } else {
      for (const [action, value] of Object.entries(preferences.bindings)) {
        if (!ACTION_SET.has(action)) {
          issue(
            issues,
            "unknown_action",
            `$.bindings.${action}`,
            `Unknown shortcut action: ${action}.`,
          );
          continue;
        }
        if (value === null) {
          bindings[action as LaunchShortcutAction] = null;
          continue;
        }
        const key = normalizedShortcutKey(value);
        if (!key) {
          issue(
            issues,
            "invalid_key",
            `$.bindings.${action}`,
            "A shortcut must be Escape or one visible, non-whitespace key.",
          );
          continue;
        }
        bindings[action as LaunchShortcutAction] = key;
      }
    }
  }

  const actionByKey = new Map<string, LaunchShortcutAction>();
  for (const action of LAUNCH_SHORTCUT_ACTIONS) {
    const key = bindings[action];
    if (key === null) continue;
    const existing = actionByKey.get(key);
    if (existing) {
      issue(
        issues,
        "duplicate_key",
        `$.bindings.${action}`,
        `Shortcut key ${key} is already assigned to ${existing}.`,
      );
    } else {
      actionByKey.set(key, action);
    }
  }

  return issues.length > 0
    ? { valid: false, issues }
    : { valid: true, value: frozenConfiguration(enabled, bindings) };
}

export function createLaunchShortcutConfiguration(
  preferences: unknown = {},
): LaunchShortcutConfiguration {
  const result = validateLaunchShortcutPreferences(preferences);
  if (!result.valid) throw new LaunchShortcutConfigurationError(result.issues);
  return result.value;
}

interface ElementLike {
  getAttribute?: (name: string) => string | null;
  isContentEditable?: boolean;
  parentElement?: unknown;
  tagName?: unknown;
}

function asElementLike(value: unknown): ElementLike | null {
  return value !== null && (typeof value === "object" ||
      typeof value === "function")
    ? value as ElementLike
    : null;
}

function readAttribute(
  element: ElementLike,
  attribute: string,
): string | null {
  if (typeof element.getAttribute !== "function") return null;
  try {
    return element.getAttribute(attribute);
  } catch {
    // A hostile or detached embedded target should suppress global shortcuts,
    // not make them fire unexpectedly.
    return "__unreadable__";
  }
}

/**
 * True when a target is an editable control, inside an editable region, or an
 * iframe. It is structural rather than DOM-global, so it is safe to unit test
 * and to import during SSR.
 */
export function isLaunchShortcutProtectedTarget(target: unknown): boolean {
  let current = asElementLike(target);
  let contentEditableInheritanceBlocked = false;

  for (
    let depth = 0;
    current && depth < MAX_TARGET_ANCESTORS;
    depth += 1
  ) {
    const tagName = typeof current.tagName === "string"
      ? current.tagName.toUpperCase()
      : "";
    if (EDITABLE_TAGS.has(tagName) || tagName === "IFRAME") return true;
    if (!contentEditableInheritanceBlocked && current.isContentEditable) {
      return true;
    }

    const contentEditable = readAttribute(current, "contenteditable");
    if (contentEditable === "__unreadable__") return true;
    if (contentEditable !== null) {
      const normalized = contentEditable.trim().toLowerCase();
      if (normalized === "false") {
        contentEditableInheritanceBlocked = true;
      } else if (!contentEditableInheritanceBlocked) {
        return true;
      }
    }

    const role = readAttribute(current, "role");
    if (role === "__unreadable__") return true;
    if (role && EDITABLE_ROLES.has(role.trim().toLowerCase())) return true;

    const parent = asElementLike(current.parentElement);
    if (parent === current) return true;
    current = parent;
  }

  // Conservatively suppress a cyclic or pathologically deep target tree.
  return current !== null;
}

function eventHasDisallowedModifier(
  event: LaunchShortcutEventLike,
): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return true;
  if (!event.shiftKey) return false;

  // `?` and other printable symbols require Shift on common layouts.
  // KeyboardEvent.key already represents the resulting symbol, so this is
  // still a single-glyph shortcut rather than a Shift chord.
  return event.key === "Escape" || /^[A-Za-z0-9]$/u.test(event.key);
}

function normalizedEventKey(event: LaunchShortcutEventLike): string | null {
  if (event.key === "Esc") return "Escape";
  return normalizedShortcutKey(event.key);
}

/**
 * Resolves one document-level keydown to an action without touching browser
 * globals or preventing the event. Callers remain responsible for navigation
 * and `preventDefault()` after receiving a non-null action.
 */
export function resolveLaunchShortcut(
  event: LaunchShortcutEventLike,
  context: LaunchShortcutResolutionContext = {},
): LaunchShortcutAction | null {
  const config = context.config ?? DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION;
  if (
    !config.enabled ||
    context.dialogActive ||
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.repeat ||
    eventHasDisallowedModifier(event) ||
    isLaunchShortcutProtectedTarget(event.target) ||
    isLaunchShortcutProtectedTarget(context.activeElement)
  ) {
    return null;
  }

  const key = normalizedEventKey(event);
  if (!key) return null;
  for (const action of LAUNCH_SHORTCUT_ACTIONS) {
    if (config.bindings[action] === key) return action;
  }
  return null;
}

export function launchAgentShortcutPosition(
  action: LaunchShortcutAction,
): LaunchAgentShortcutPosition | null {
  const match = /^agent-(10|[1-9])$/u.exec(action);
  return match ? Number(match[1]) as LaunchAgentShortcutPosition : null;
}

export function launchAgentShortcutAction(
  position: number,
): LaunchShortcutAction | null {
  return Number.isInteger(position) && position >= 1 && position <= 10
    ? `agent-${position}` as LaunchShortcutAction
    : null;
}

/**
 * Value for React's `aria-keyshortcuts` prop. Disabled shortcuts return
 * undefined so consumers omit the attribute entirely.
 */
export function launchShortcutAriaKeyShortcuts(
  action: LaunchShortcutAction,
  config: LaunchShortcutConfiguration =
    DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION,
): string | undefined {
  if (!config.enabled) return undefined;
  return config.bindings[action] ?? undefined;
}

export function launchShortcutDisplayLabel(
  action: LaunchShortcutAction,
  config: LaunchShortcutConfiguration =
    DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION,
): string | undefined {
  const key = launchShortcutAriaKeyShortcuts(action, config);
  if (!key) return undefined;
  if (key === "Escape") return "Esc";
  return /^[a-z]$/u.test(key) ? key.toUpperCase() : key;
}
