import { describe, expect, it } from 'vitest';
import { createServerClock } from './serverClock';

describe('the server’s time, kept by a client', () => {
  /** A device whose own clock and steady timer the test moves by hand. */
  function device(deviceClock: string) {
    const state = { clock: Date.parse(deviceClock), timer: 5_000 };
    return { state, clock: createServerClock(() => state.timer, () => state.clock) };
  }

  it('uses the device’s clock only until the server has answered', () => {
    const { clock } = device('2020-01-01T00:00:00.000Z');
    expect(clock.synced()).toBe(false);
    expect(clock.now().toISOString()).toBe('2020-01-01T00:00:00.000Z');
    clock.sync('2026-12-07T03:30:00.000Z');
    expect(clock.synced()).toBe(true);
    expect(clock.now().toISOString()).toBe('2026-12-07T03:30:00.000Z');
  });

  it('moves with the steady timer, whatever the device’s clock says or is changed to', () => {
    const { clock, state } = device('2020-01-01T00:00:00.000Z');
    clock.sync('2026-12-07T03:30:00.000Z');

    // Ninety seconds pass. The device's clock is six years behind: it changes nothing.
    state.timer += 90_000;
    expect(clock.now().toISOString()).toBe('2026-12-07T03:31:30.000Z');

    // Someone sets the device's clock five hours ahead, then a year back. Still nothing.
    state.clock = Date.parse('2026-12-07T08:31:30.000Z');
    expect(clock.now().toISOString()).toBe('2026-12-07T03:31:30.000Z');
    state.clock = Date.parse('2025-12-07T03:31:30.000Z');
    state.timer += 30_000;
    expect(clock.now().toISOString()).toBe('2026-12-07T03:32:00.000Z');
  });

  it('takes the server’s newer answer over its own count', () => {
    const { clock, state } = device('2026-12-07T03:30:00.000Z');
    clock.sync('2026-12-07T03:30:00.000Z');
    state.timer += 60_000;
    clock.sync('2026-12-07T03:31:02.000Z');
    expect(clock.now().toISOString()).toBe('2026-12-07T03:31:02.000Z');
  });

  it('ignores an answer that is not a moment', () => {
    const { clock, state } = device('2026-12-07T03:30:00.000Z');
    clock.sync('2026-12-07T03:30:00.000Z');
    state.timer += 1_000;
    clock.sync('not a time');
    expect(clock.now().toISOString()).toBe('2026-12-07T03:30:01.000Z');
  });
});
