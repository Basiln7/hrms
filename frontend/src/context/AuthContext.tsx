import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PASSWORD_CHANGE_REQUIRED, type CompanySettings, type MePayload, type PermissionId, type SelfEmployee } from '@delta-hrms/shared';
import { api, ApiError, messageOf, setFailureListener } from '../lib/api';
import { syncServerClock } from '../lib/serverClock';
import { useToast } from './ToastContext';

interface AuthCtx {
  /** False until the saved session has been checked, so signed-in people never flash the sign-in page. */
  ready: boolean;
  /** The signed-in person, or null. */
  employee: SelfEmployee | null;
  company: CompanySettings | null;
  /** The work schedule the signed-in person is on today, by name, or null when they have none yet. */
  scheduleName: string | null;
  /** Requests waiting for the signed-in person to decide. */
  approvalsWaiting: number;
  /** Announcements showing for the signed-in person that they have still to read. */
  unreadAnnouncements: number;
  /** The server cannot be reached right now. The app keeps trying by itself. */
  offline: boolean;
  /** Whether the signed-in person's role holds a permission. The API decides again on every request. */
  can: (permission: PermissionId) => boolean;
  /** Signs in. Returns the reason when it fails, or null. */
  login: (email: string, password: string, remember: boolean) => Promise<string | null>;
  logout: () => Promise<void>;
  /** Asks the server again who is signed in and what the company settings are. */
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

const RETRY_MS = 4000;
const RESYNC_AFTER_MS = 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [me, setMe] = useState<MePayload | null>(null);
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false);
  const syncedAt = useRef(0);
  const signedIn = useRef(false);

  /** Who is signed in, according to the server. */
  const load = useCallback(async (): Promise<'in' | 'out' | 'offline'> => {
    try {
      const payload = await api.get<MePayload>('/me', { quiet: true });
      syncServerClock(payload.serverNow);
      syncedAt.current = performance.now();
      signedIn.current = true;
      setMe(payload);
      setOffline(false);
      return 'in';
    } catch (error) {
      if (error instanceof ApiError && error.unreachable) {
        setOffline(true);
        return 'offline';
      }
      signedIn.current = false;
      setMe(null);
      setOffline(false);
      return 'out';
    }
  }, []);

  // The first look for a saved session.
  useEffect(() => {
    let alive = true;
    void load().then((state) => {
      if (alive && state !== 'offline') setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [load]);

  // While the server cannot be reached, keep asking. When it answers, carry on where we were.
  useEffect(() => {
    if (!offline) return;
    const timer = window.setInterval(() => {
      void load().then((state) => {
        if (state !== 'offline') setReady(true);
      });
    }, RETRY_MS);
    return () => window.clearInterval(timer);
  }, [offline, load]);

  // Any request, anywhere in the app, that finds the session ended or the server gone.
  useEffect(() => {
    setFailureListener((error) => {
      if (error.unreachable) setOffline(true);
      else if (error.status === 401 && signedIn.current) {
        signedIn.current = false;
        setMe(null);
        toast('You have been signed out. Please sign in again.', 'error');
      } else if (error.code === PASSWORD_CHANGE_REQUIRED) void load();
    });
    return () => setFailureListener(null);
  }, [load, toast]);

  // Coming back to the tab: check again who is signed in, and set the clock again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && signedIn.current && performance.now() - syncedAt.current > RESYNC_AFTER_MS) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const value = useMemo<AuthCtx>(() => {
    const permissions = new Set(me?.permissions ?? []);
    return {
      ready,
      employee: me?.employee ?? null,
      company: me?.company ?? null,
      scheduleName: me?.scheduleName ?? null,
      approvalsWaiting: me?.approvalsWaiting ?? 0,
      unreadAnnouncements: me?.unreadAnnouncements ?? 0,
      offline,
      can: (permission) => permissions.has(permission),
      login: async (email, password, remember) => {
        try {
          await api.post('/auth/login', { email, password, remember }, { quiet: true });
        } catch (error) {
          return messageOf(error);
        }
        return (await load()) === 'in' ? null : 'Signed in, but the server could not be reached to load your account. Please try again.';
      },
      logout: async () => {
        signedIn.current = false;
        await api.post('/auth/logout', undefined, { quiet: true }).catch(() => undefined);
        setMe(null);
      },
      refresh: async () => {
        await load();
      },
    };
  }, [me, ready, offline, load]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** For pages that only exist for someone signed in: the person and the company, never null. */
export function useMe() {
  const { employee, company, scheduleName } = useAuth();
  if (!employee || !company) throw new Error('This page needs a signed-in person.');
  return { employee, company, scheduleName };
}

// Development only. This module holds live app state behind a React context. Hot-swapping it
// would leave the old provider mounted while screens pick up a new context object, which
// blanks the page. Reloading keeps the two in step; nothing is lost, the state is reloaded.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
