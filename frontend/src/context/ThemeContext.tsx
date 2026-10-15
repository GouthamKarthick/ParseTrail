/**
 * @fileoverview Theme context — light/dark toggle with localStorage persistence.
 * Syncs theme to document data-attribute and prefers system setting as fallback.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
} from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Theme = "light" | "dark";

const Ctx = createContext<{ theme: Theme; toggle: () => void } | null>(null);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine initial theme from storage or system preference.
 * @returns Resolved theme value
 * @example const theme = getInitialTheme();
 */
function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";

  const saved = localStorage.getItem("theme");

  if (saved === "light" || saved === "dark") return saved;

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Provides theme state and toggle action.
 * @param children - React subtree
 * @returns Theme provider element
 * @example <ThemeProvider><App /></ThemeProvider>
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggle = useCallback(
    () => setTheme((t) => (t === "light" ? "dark" : "light")),
    [],
  );

  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Consume theme context.
 * @returns Current theme and toggle function
 * @throws When used outside ThemeProvider
 * @example const { theme, toggle } = useTheme();
 */
export function useTheme() {
  const v = useContext(Ctx);
  if (!v) throw new Error("ThemeContext missing");
  return v;
}
