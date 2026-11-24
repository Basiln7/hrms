import { createHash, timingSafeEqual } from 'node:crypto';

/*
 * First-run setup creates the company's first Admin, so on a fresh installation whoever
 * reaches it first owns the HRMS. In production that must not be "whoever finds the address":
 * setup asks for a code from the server's settings, and is switched off until one is set.
 */

export type SetupGate = 'open' | 'code' | 'disabled';

/** How first-run setup is protected on a server with these settings. */
export function setupGate(settings: { isProduction: boolean; setupCode: string | null }): SetupGate {
  if (settings.setupCode) return 'code';
  return settings.isProduction ? 'disabled' : 'open';
}

/** Compares two secrets without the time taken giving away how much of a guess was right. */
export function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}
