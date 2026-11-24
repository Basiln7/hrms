/*
 * Browser storage is used only for this device's display preferences (theme, collapsed
 * sidebar, cards or table). Everything that matters lives on the server.
 */

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked; the preference simply is not remembered.
  }
}
