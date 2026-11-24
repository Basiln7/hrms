import { useCallback, useEffect, useRef, useState } from 'react';
import { api, messageOf } from './api';

export interface Loaded<T> {
  /** What the server last answered. Kept on screen while a newer answer is on its way. */
  data: T | null;
  /** Why the last attempt failed, in the server's own words. */
  error: string | null;
  /** Nothing to show yet: the first answer has not arrived. */
  loading: boolean;
  /** Ask again, for instance after a change. */
  reload: () => void;
}

/**
 * Fetches a page's data from the API and keeps the three states every page shows: loading,
 * failed (with the reason and a way to try again), and loaded. Pass null to fetch nothing.
 * Only the newest request's answer is used, so a slow old one never overwrites a newer one.
 */
export function useLoad<T>(path: string | null): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [attempt, setAttempt] = useState(0);
  const newest = useRef(0);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setLoading(false);
      return;
    }
    const mine = ++newest.current;
    setError(null);
    api
      .get<T>(path)
      .then((answer) => {
        if (mine !== newest.current) return;
        setData(answer);
        setLoading(false);
      })
      .catch((failure) => {
        if (mine !== newest.current) return;
        setError(messageOf(failure));
        setLoading(false);
      });
  }, [path, attempt]);

  // A different address means different data: what is on screen belongs to the old one.
  const shown = useRef(path);
  if (shown.current !== path) {
    shown.current = path;
    if (data !== null) setData(null);
    if (!loading && path !== null) setLoading(true);
  }

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, error, loading, reload };
}

/** "a=1&b=2" from the values that are set. */
export function queryOf(values: Record<string, string | number | undefined | null | false>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== false && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
