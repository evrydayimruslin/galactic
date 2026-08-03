/**
 * Display-name hints for Agents, so the Studio header can show the real
 * name during its first load instead of a placeholder. Session-scoped and
 * advisory only: the authoritative name always arrives with the Agent
 * snapshot and overwrites whatever is remembered here.
 */

const STORAGE_KEY = "galactic.agent-name-hints";
const MAX_ENTRIES = 200;

type NameHintStorage = Pick<Storage, "getItem" | "setItem">;

export interface AgentNameHint {
  id?: string | null;
  slug?: string | null;
  name?: string | null;
}

function browserStorage(): NameHintStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readStore(storage: NameHintStorage): Record<string, string> {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const store: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") store[key] = value;
    }
    return store;
  } catch {
    return {};
  }
}

export function rememberAgentNames(
  hints: readonly AgentNameHint[],
  storage: NameHintStorage | null = browserStorage(),
): void {
  if (!storage) return;
  const store = readStore(storage);
  let changed = false;
  for (const hint of hints) {
    const name = hint.name?.trim();
    if (!name) continue;
    for (const key of [hint.id, hint.slug]) {
      if (!key) continue;
      if (store[key] !== name) {
        // Re-insert so the entry moves to the newest end of key order.
        delete store[key];
        store[key] = name;
        changed = true;
      }
    }
  }
  if (!changed) return;
  const keys = Object.keys(store);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) {
    delete store[stale];
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // A full or denied store only costs the hint, never the page.
  }
}

export function recallAgentName(
  idOrSlug: string | null | undefined,
  storage: NameHintStorage | null = browserStorage(),
): string | null {
  if (!idOrSlug || !storage) return null;
  return readStore(storage)[idOrSlug] ?? null;
}
