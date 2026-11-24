import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  HOUR,
  isLocalDate,
  isLocalTime,
  isTimeZone,
  localDateOf,
  localParts,
  minutesBetween,
  minutesOfDay,
  offsetMinutes,
  startOfDay,
  truncateToMinute,
  weekdayOf,
  zonedToInstant,
} from './dates';

const iso = (date: Date) => date.toISOString();

describe('reading a moment in a time zone', () => {
  it('reads India, which is half an hour off the hour', () => {
    const p = localParts('2026-11-23T06:52:41Z', 'Asia/Kolkata');
    expect(p.date).toBe('2026-11-23');
    expect(p.time).toBe('12:22');
    expect(p.second).toBe(41);
    expect(p.weekday).toBe('mon');
  });

  it('turns the day at local midnight, not at UTC midnight', () => {
    expect(localParts('2026-01-01T18:29:59Z', 'Asia/Kolkata')).toMatchObject({ date: '2026-01-01', time: '23:59' });
    expect(localParts('2026-01-01T18:30:00Z', 'Asia/Kolkata')).toMatchObject({ date: '2026-01-02', time: '00:00' });
    expect(localDateOf('2026-06-30T19:59:59Z', 'Asia/Dubai')).toBe('2026-06-30');
    expect(localDateOf('2026-06-30T20:00:00Z', 'Asia/Dubai')).toBe('2026-07-01');
  });

  it('gives two people in two countries different days at the same moment', () => {
    const moment = '2026-03-10T19:30:00Z';
    expect(localDateOf(moment, 'Asia/Kolkata')).toBe('2026-03-11');
    expect(localDateOf(moment, 'Asia/Dubai')).toBe('2026-03-10');
    expect(localDateOf(moment, 'America/New_York')).toBe('2026-03-10');
  });

  it('writes midnight as 00, never 24', () => {
    expect(localParts('2026-05-04T18:30:00Z', 'Asia/Kolkata').hour).toBe(0);
  });

  it('knows each zone’s offset, winter and summer', () => {
    expect(offsetMinutes('2026-01-15T12:00:00Z', 'Asia/Kolkata')).toBe(330);
    expect(offsetMinutes('2026-01-15T12:00:00Z', 'Asia/Dubai')).toBe(240);
    expect(offsetMinutes('2026-01-15T12:00:00Z', 'UTC')).toBe(0);
    expect(offsetMinutes('2026-01-15T12:00:00Z', 'Europe/London')).toBe(0);
    expect(offsetMinutes('2026-07-15T12:00:00Z', 'Europe/London')).toBe(60);
    expect(offsetMinutes('2026-01-15T12:00:00Z', 'America/New_York')).toBe(-300);
    expect(offsetMinutes('2026-07-15T12:00:00Z', 'America/New_York')).toBe(-240);
  });

  it('refuses something that is not a moment', () => {
    expect(() => localParts('not a date', 'Asia/Kolkata')).toThrow(RangeError);
  });
});

describe('finding the moment a wall clock shows a time', () => {
  it('works where clocks never change', () => {
    expect(iso(zonedToInstant('2026-11-23', '09:00', 'Asia/Kolkata'))).toBe('2026-11-23T03:30:00.000Z');
    expect(iso(zonedToInstant('2026-11-23', '09:00', 'Asia/Dubai'))).toBe('2026-11-23T05:00:00.000Z');
    expect(iso(zonedToInstant('2026-11-23', '00:00', 'Asia/Kolkata'))).toBe('2026-11-22T18:30:00.000Z');
    expect(iso(zonedToInstant('2026-11-23', '23:59', 'UTC'))).toBe('2026-11-23T23:59:00.000Z');
  });

  it('works either side of a clock change', () => {
    expect(iso(zonedToInstant('2026-03-28', '09:00', 'Europe/London'))).toBe('2026-03-28T09:00:00.000Z');
    expect(iso(zonedToInstant('2026-03-29', '09:00', 'Europe/London'))).toBe('2026-03-29T08:00:00.000Z');
    expect(iso(zonedToInstant('2026-10-25', '09:00', 'Europe/London'))).toBe('2026-10-25T09:00:00.000Z');
    expect(iso(zonedToInstant('2026-11-01', '09:00', 'America/New_York'))).toBe('2026-11-01T14:00:00.000Z');
  });

  it('moves a time that does not exist forward by the size of the jump', () => {
    // London, 29 March 2026: 01:00 becomes 02:00, so 01:30 never happens. It is read as 02:30.
    const london = zonedToInstant('2026-03-29', '01:30', 'Europe/London');
    expect(iso(london)).toBe('2026-03-29T01:30:00.000Z');
    expect(localParts(london, 'Europe/London').time).toBe('02:30');
    // New York, 8 March 2026: 02:00 becomes 03:00.
    const newYork = zonedToInstant('2026-03-08', '02:30', 'America/New_York');
    expect(iso(newYork)).toBe('2026-03-08T07:30:00.000Z');
    expect(localParts(newYork, 'America/New_York').time).toBe('03:30');
  });

  it('takes the first of a time that happens twice', () => {
    // London, 25 October 2026: 02:00 becomes 01:00, so 01:30 happens at 00:30Z and again at 01:30Z.
    expect(iso(zonedToInstant('2026-10-25', '01:30', 'Europe/London'))).toBe('2026-10-25T00:30:00.000Z');
    // New York, 1 November 2026: 01:30 happens at 05:30Z and again at 06:30Z.
    expect(iso(zonedToInstant('2026-11-01', '01:30', 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z');
  });

  it('undoes localParts for every hour of a year', () => {
    for (const zone of ['Asia/Kolkata', 'Asia/Dubai', 'UTC', 'Australia/Lord_Howe', 'Asia/Kathmandu']) {
      const start = Date.UTC(2026, 0, 1);
      for (let hour = 0; hour < 366 * 24; hour += 1) {
        const moment = start + hour * HOUR;
        const p = localParts(moment, zone);
        const back = zonedToInstant(p.date, p.time, zone).getTime();
        // Only Lord Howe changes its clocks here (by half an hour). The half hour that happens twice
        // reads as the first of the two; everywhere else the round trip is exact.
        if (zone === 'Australia/Lord_Howe' && back !== moment) expect(localParts(back, zone).time).toBe(p.time);
        else expect(back, `${zone} ${new Date(moment).toISOString()}`).toBe(moment);
      }
    }
  });

  it('starts a day at its local midnight', () => {
    expect(iso(startOfDay('2026-11-23', 'Asia/Kolkata'))).toBe('2026-11-22T18:30:00.000Z');
  });

  it('refuses a bad day or time', () => {
    expect(() => zonedToInstant('2026-02-30', '09:00', 'Asia/Kolkata')).toThrow(RangeError);
    expect(() => zonedToInstant('2026-02-03', '9am', 'Asia/Kolkata')).toThrow(RangeError);
  });
});

describe('calendar days', () => {
  it('adds and subtracts across months, years and leap days', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-11-23', 0)).toBe('2026-11-23');
    expect(addDays('2026-11-23', 365)).toBe('2027-11-23');
  });

  it('counts the days between two days', () => {
    expect(daysBetween('2026-11-23', '2026-11-23')).toBe(0);
    expect(daysBetween('2026-11-23', '2026-12-01')).toBe(8);
    expect(daysBetween('2026-12-01', '2026-11-23')).toBe(-8);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });

  it('names the weekday', () => {
    expect(weekdayOf('2026-11-23')).toBe('mon');
    expect(weekdayOf('2026-11-29')).toBe('sun');
    expect(weekdayOf('2028-02-29')).toBe('tue');
  });

  it('tells a real day from a shape that looks like one', () => {
    expect(isLocalDate('2026-11-23')).toBe(true);
    expect(isLocalDate('2028-02-29')).toBe(true);
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2026-02-30')).toBe(false);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('2026-2-3')).toBe(false);
    expect(isLocalDate('2026-11-23T00:00:00Z')).toBe(false);
    expect(isLocalDate(20261123)).toBe(false);
  });

  it('tells a real time of day', () => {
    expect(isLocalTime('00:00')).toBe(true);
    expect(isLocalTime('23:59')).toBe(true);
    expect(isLocalTime('24:00')).toBe(false);
    expect(isLocalTime('09:5')).toBe(false);
    expect(isLocalTime('9:05')).toBe(false);
    expect(minutesOfDay('09:05')).toBe(545);
  });

  it('accepts real time zones only', () => {
    expect(isTimeZone('Asia/Kolkata')).toBe(true);
    expect(isTimeZone('Asia/Dubai')).toBe(true);
    expect(isTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Phobos')).toBe(false);
    expect(isTimeZone('+05:30')).toBe(false);
    expect(isTimeZone('IST')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone(null)).toBe(false);
  });
});

describe('whole minutes', () => {
  it('drops the seconds of a moment', () => {
    expect(iso(truncateToMinute('2026-11-23T03:40:59.999Z'))).toBe('2026-11-23T03:40:00.000Z');
    expect(iso(truncateToMinute('2026-11-23T03:40:00.000Z'))).toBe('2026-11-23T03:40:00.000Z');
  });

  it('measures what the screen shows: 09:00:50 to 17:30:10 is 8 h 30', () => {
    expect(minutesBetween('2026-11-23T03:30:50Z', '2026-11-23T12:00:10Z')).toBe(510);
    expect(minutesBetween('2026-11-23T03:30:59Z', '2026-11-23T03:31:00Z')).toBe(1);
    expect(minutesBetween('2026-11-23T03:30:00Z', '2026-11-23T03:30:59Z')).toBe(0);
  });
});
