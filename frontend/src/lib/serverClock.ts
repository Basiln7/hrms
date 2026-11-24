import { useEffect, useState } from 'react';
import { createServerClock } from '@delta-hrms/shared';

/*
 * The time, as the server knows it.
 *
 * The device's own clock is never used for anything the HRMS shows: it can be wrong, or set
 * wrong on purpose. Each time the server tells us its time we note it against the browser's
 * steady timer (which only counts forward and ignores changes to the device clock), and work
 * out "now" from the two. The arithmetic is `createServerClock` in shared, where it is tested.
 */
const clock = createServerClock(
  () => performance.now(),
  // Before the first answer arrives there is nothing better than the device's clock.
  () => Date.now(),
);

/** Call with the server's time whenever an answer carries it. */
export const syncServerClock = (iso: string) => clock.sync(iso);

/** The server's time now. */
export const serverNow = (): Date => clock.now();

/** The server's time, kept fresh: the component is drawn again every `everyMs`. */
export function useServerNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const tick = () => setNow(serverNow());
    const timer = window.setInterval(tick, everyMs);
    // A tab that was in the background may have had its timers slowed: catch up when it returns.
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [everyMs]);
  return now;
}
