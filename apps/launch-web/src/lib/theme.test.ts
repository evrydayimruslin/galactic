import { describe, expect, it, vi } from "vitest";

import {
  applyResolvedTheme,
  parseThemePreference,
  readThemePreference,
  resolveTheme,
  subscribeToThemeMediaQuery,
  THEME_STORAGE_KEY,
  themePreferenceFromStorageChange,
  writeThemePreference,
} from "./theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  };
}

describe("theme preference", () => {
  it("defaults missing and invalid values to System", () => {
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("sepia")).toBe("system");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
  });

  it("resolves System from the current color-scheme preference", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("reads and persists a stable local preference", () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: "dark" });

    expect(readThemePreference(storage)).toBe("dark");
    expect(writeThemePreference("light", storage)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "light");
    expect(readThemePreference(storage)).toBe("light");
  });

  it("falls back safely when browser storage is unavailable", () => {
    const unavailable = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    };

    expect(readThemePreference(unavailable)).toBe("system");
    expect(writeThemePreference("dark", unavailable)).toBe(false);
  });

  it("maps cross-tab writes and clears while ignoring unrelated keys", () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: "light" });

    expect(themePreferenceFromStorageChange(
      THEME_STORAGE_KEY,
      "dark",
      storage,
    )).toBe("dark");
    expect(themePreferenceFromStorageChange(
      THEME_STORAGE_KEY,
      "invalid",
      storage,
    )).toBe("system");
    expect(themePreferenceFromStorageChange(null, null, storage)).toBe("light");
    expect(themePreferenceFromStorageChange("another.key", "dark", storage))
      .toBeNull();
  });
});

describe("resolved theme application", () => {
  it("sets both the CSS selector hook and native color scheme", () => {
    const root = {
      dataset: {} as DOMStringMap,
      style: {} as CSSStyleDeclaration,
    };

    applyResolvedTheme("dark", root);

    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("subscribes and unsubscribes from live system-theme changes", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const listener = vi.fn();

    const unsubscribe = subscribeToThemeMediaQuery({
      matches: false,
      addEventListener,
      removeEventListener,
    }, listener);

    expect(addEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
    const onChange = addEventListener.mock.calls[0]?.[1];
    onChange?.();
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    expect(removeEventListener).toHaveBeenCalledWith("change", onChange);
  });
});
