import { config } from './config';

/*
 * The one clock. Every time the HRMS records (a check-in, a decision, "today") is read from
 * here on the server, never taken from a browser. The automated tests can set it, to try a
 * late arrival or a month end; that door exists only when NODE_ENV is "test".
 */

let pinned: number | null = null;

export const clock = {
  now: (): Date => new Date(pinned ?? Date.now()),
  nowIso: (): string => new Date(pinned ?? Date.now()).toISOString(),
};

/** Tests only: fixes the clock at a moment, or lets it run again with null. */
export function setTestNow(moment: Date | string | null) {
  if (!config.isTest) throw new Error('The clock can only be set by the automated tests.');
  pinned = moment === null ? null : new Date(moment).getTime();
}
