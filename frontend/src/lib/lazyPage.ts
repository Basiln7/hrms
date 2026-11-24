import { lazy, type ComponentType } from 'react';

const KEY = 'delta.hrms.reloadedForUpdate';
/** A reload this recent already tried; failing again means the file is really missing. */
const RECENT_MS = 30_000;

const reloadedRecently = () => {
  try {
    return Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < RECENT_MS;
  } catch {
    return true; // Storage blocked: never risk a reload loop.
  }
};

/**
 * `React.lazy` for a page, safe across releases. Page files are named after their contents,
 * so once a new version is live, a tab opened before it asks for files that no longer exist.
 * Reloading once loads the new version. If the file is still missing straight after that,
 * the error is passed on to the error boundary, which explains and offers a way out.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      return await load();
    } catch (error) {
      if (reloadedRecently()) throw error;
      try {
        sessionStorage.setItem(KEY, String(Date.now()));
      } catch {
        throw error;
      }
      window.location.reload();
      // Keep showing "Loading…" while the browser reloads.
      return new Promise<never>(() => undefined);
    }
  });
}
