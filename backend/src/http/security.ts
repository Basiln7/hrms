import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { forbidden, tooManyRequests } from './errors';

/**
 * Cross-site request forgery guard. The session is a cookie, so a page on another site
 * could otherwise make the browser send state-changing requests. Browsers always send an
 * Origin header on those; we only accept our own.
 */
export function sameOriginOnly(req: Request, _res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  // No Origin header means this is not a browser page (curl, a script, a server-side job).
  if (!origin) return next();
  const self = `${req.protocol}://${req.get('host')}`;
  if (origin === self || config.webOrigins.includes(origin)) return next();
  throw forbidden('This request came from a site that is not allowed.');
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

/**
 * Slows down password guessing: ten tries per address and email, then a 15-minute wait. A
 * successful sign-in clears the count. The same limit, counted per person, guards the
 * "current password" asked for when changing it, and per address guards the setup code.
 *
 * Each attempt is counted when it arrives, before the (deliberately slow) password check.
 * Counting only after a wrong answer would let a burst of parallel guesses all be checked
 * before the first one was recorded.
 *
 * Kept in memory, which is right for one server; several servers would need a shared store.
 */
export const loginLimiter = {
  /** Records an attempt, or refuses it when this address and email have used up their tries. */
  attempt(key: string) {
    const now = Date.now();
    let entry = attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      attempts.set(key, entry);
    }
    if (entry.count >= MAX_ATTEMPTS) throw tooManyRequests('Too many sign-in attempts. Please wait a few minutes and try again.');
    entry.count += 1;
    // Opportunistic clean-up so the map cannot grow without bound.
    if (attempts.size > 5000) for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
  },
  succeed(key: string) {
    attempts.delete(key);
  },
};
