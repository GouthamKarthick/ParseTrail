/**
 * @fileoverview Authentication context — session state, login/register/logout actions.
 * Wraps API calls in React context for global auth access.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
} from "react";
import {
  me,
  login as apiLogin,
  logout as apiLogout,
  register as apiRegister,
  getAvatar,
} from "../api/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Authenticated user shape (text profile only; avatar lives in separate API). */
interface AuthState {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  phone?: string | null;
  email_verified: number | boolean;
  verification_email_sent?: boolean;
}

/** Context value — null when used outside provider. */
const Ctx = createContext<{
  user: AuthState | null;
  loading: boolean;
  avatar: string | null;
  login: (e: string, p: string) => Promise<void>;
  register: (
    f: string,
    l: string,
    e: string,
    p: string,
  ) => Promise<AuthState>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setAvatarState: (s: string | null) => void;
} | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Provides authentication state and actions to descendants.
 * @param children - React subtree requiring auth
 * @returns Context provider element
 * @example <AuthProvider><App /></AuthProvider>
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthState | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAvatarQuiet = useCallback(async () => {
    try {
      const a = await getAvatar();
      setAvatar(a?.avatar_base64 ?? null);
    } catch {
      setAvatar(null);
    }
  }, []);

  useEffect(() => {
    me()
      .then((u) => {
        setUser(u);
        fetchAvatarQuiet();
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [fetchAvatarQuiet]);

  const login = useCallback(
    async (email: string, password: string) => {
      const u = await apiLogin(email, password);
      setUser(u);
      await fetchAvatarQuiet();
    },
    [fetchAvatarQuiet],
  );

  const register = useCallback(
    async (
      first_name: string,
      last_name: string,
      email: string,
      password: string,
    ) => {
      const u = await apiRegister(first_name, last_name, email, password);
      setUser(u);
      setAvatar(null);
      return u;
    },
    [],
  );

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setAvatar(null);
  }, []);

  const refresh = useCallback(async () => {
    const u = await me();
    setUser(u);
  }, []);

  const setAvatarState = useCallback((s: string | null) => setAvatar(s), []);

  const value = useMemo(
    () => ({
      user,
      loading,
      avatar,
      login,
      register,
      logout,
      refresh,
      setAvatarState,
    }),
    [user, loading, avatar, login, register, logout, refresh, setAvatarState],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Consume authentication context.
 * @returns Auth state and actions
 * @throws When used outside AuthProvider
 * @example const { user, login } = useAuth();
 */
export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("AuthContext missing");
  return v;
}
