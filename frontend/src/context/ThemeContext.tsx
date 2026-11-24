import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeMode = 'dark' | 'light' | 'system';
type Resolved = 'dark' | 'light';

const KEY = 'delta.hrms.theme';

interface ThemeCtx {
  mode: ThemeMode;
  resolved: Resolved;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

function readMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light' || saved === 'system') return saved;
  } catch {
    // ignore
  }
  // Nothing chosen yet: follow the device.
  return 'system';
}

const systemPrefersLight = () => window.matchMedia('(prefers-color-scheme: light)').matches;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [systemLight, setSystemLight] = useState(systemPrefersLight);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setSystemLight(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: Resolved = mode === 'system' ? (systemLight ? 'light' : 'dark') : mode;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', resolved === 'dark' ? '#171821' : '#eef2f1');
  }, [resolved]);

  const value = useMemo<ThemeCtx>(() => {
    const setMode = (next: ThemeMode) => {
      setModeState(next);
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // ignore
      }
    };
    return { mode, resolved, setMode, toggle: () => setMode(resolved === 'dark' ? 'light' : 'dark') };
  }, [mode, resolved]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}

// Development only. This module holds live app state behind a React context. Hot-swapping it
// would leave the old provider mounted while screens pick up a new context object, which
// blanks the page. Reloading keeps the two in step; nothing is lost, the state is reloaded.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
