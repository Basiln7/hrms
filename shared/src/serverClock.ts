/*
 * The server's time, kept by a client.
 *
 * A device's own clock can be wrong, or set wrong on purpose, so nothing the HRMS shows may be
 * read from it. Each time the server tells the client its time, the client notes it against a
 * steady timer: one that only counts forward and takes no notice of changes to the device
 * clock (in a browser, `performance.now()`). "Now" is then the server's time plus what the
 * steady timer has counted since.
 *
 * Both readings are passed in, so this file reads no clock itself and can be tested.
 */

export interface ServerClock {
  /** Call with the server's time whenever an answer carries it. Text that is not a moment is ignored. */
  sync(iso: string): void;
  /** The server's time now. */
  now(): Date;
  /** Whether the server has told us its time yet. */
  synced(): boolean;
}

/**
 * @param steady   milliseconds on a timer that only counts forward
 * @param fallback milliseconds since 1970 by the device's clock: used only until the first
 *                 answer arrives, when there is nothing better
 */
export function createServerClock(steady: () => number, fallback: () => number): ServerClock {
  let anchor: { server: number; timer: number } | null = null;
  return {
    sync(iso) {
      const server = Date.parse(iso);
      if (!Number.isNaN(server)) anchor = { server, timer: steady() };
    },
    now: () => new Date(anchor ? anchor.server + (steady() - anchor.timer) : fallback()),
    synced: () => anchor !== null,
  };
}
