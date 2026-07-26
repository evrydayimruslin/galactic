import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

export const THEME_STORAGE_KEY = "galactic.theme";
export const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;
type ThemeRoot = Pick<HTMLElement, "dataset" | "style">;
type ThemeMediaQueryList = Pick<
  MediaQueryList,
  "matches" | "addEventListener" | "removeEventListener"
> & Partial<Pick<MediaQueryList, "addListener" | "removeListener">>;

const ThemeContext = createContext<ThemeContextValue | null>(null);
const useBrowserLayoutEffect = typeof window === "undefined"
  ? useEffect
  : useLayoutEffect;

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  return preference === "system"
    ? (systemPrefersDark ? "dark" : "light")
    : preference;
}

export function readThemePreference(
  storage: Pick<ThemeStorage, "getItem"> | null = browserStorage(),
): ThemePreference {
  if (!storage) return "system";
  try {
    return parseThemePreference(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function writeThemePreference(
  preference: ThemePreference,
  storage: Pick<ThemeStorage, "setItem"> | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(THEME_STORAGE_KEY, parseThemePreference(preference));
    return true;
  } catch {
    return false;
  }
}

export function themePreferenceFromStorageChange(
  key: string | null,
  newValue: string | null,
  storage: Pick<ThemeStorage, "getItem"> | null = browserStorage(),
): ThemePreference | null {
  if (key !== null && key !== THEME_STORAGE_KEY) return null;
  return key === THEME_STORAGE_KEY
    ? parseThemePreference(newValue)
    : readThemePreference(storage);
}

export function applyResolvedTheme(
  theme: ResolvedTheme,
  root: ThemeRoot = document.documentElement,
): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function subscribeToThemeMediaQuery(
  mediaQuery: ThemeMediaQueryList,
  listener: () => void,
): () => void {
  const onChange = () => listener();
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }

  mediaQuery.addListener?.(onChange);
  return () => mediaQuery.removeListener?.(onChange);
}

export function ThemeProvider(
  { children }: { children: ReactNode },
): ReactElement {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    readThemePreference,
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    readSystemPrefersDark,
  );
  const resolvedTheme = resolveTheme(preference, systemPrefersDark);

  useEffect(() => {
    const mediaQuery = browserMediaQuery();
    if (!mediaQuery) return;

    const synchronize = () => setSystemPrefersDark(mediaQuery.matches);
    synchronize();
    return subscribeToThemeMediaQuery(mediaQuery, synchronize);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onStorage = (event: StorageEvent) => {
      const storage = browserStorage();
      if (event.storageArea && event.storageArea !== storage) return;
      const next = themePreferenceFromStorageChange(
        event.key,
        event.newValue,
        storage,
      );
      if (next) setPreferenceState(next);
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useBrowserLayoutEffect(() => {
    applyResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setPreference = useCallback((nextPreference: ThemePreference) => {
    const next = parseThemePreference(nextPreference);
    writeThemePreference(next);

    // Apply synchronously so controls, native chrome, and the favicon observer
    // all update in the same interaction frame as the preference change.
    if (typeof document !== "undefined") {
      applyResolvedTheme(resolveTheme(next, readSystemPrefersDark()));
    }
    setPreferenceState(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

function browserStorage(): ThemeStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserMediaQuery(): ThemeMediaQueryList | null {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  try {
    return window.matchMedia(THEME_MEDIA_QUERY);
  } catch {
    return null;
  }
}

function readSystemPrefersDark(): boolean {
  return browserMediaQuery()?.matches ?? false;
}
