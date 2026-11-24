import { isTimeZone } from '@delta-hrms/shared';

/** Older names some devices still report, and the name used today. */
const RENAMED: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Europe/Kiev': 'Europe/Kyiv',
};

const current = (zone: string) => RENAMED[zone] ?? zone;

let cached: string[] | null = null;

/** Every time zone this browser knows, by its current name, for the picker's suggestions. */
export function timeZoneOptions(): string[] {
  if (!cached) {
    let zones: string[] = [];
    try {
      zones = Intl.supportedValuesOf('timeZone');
    } catch {
      // An older browser: the field still takes a typed zone, and the server checks it.
    }
    cached = [...new Set(['UTC', 'Asia/Kolkata', 'Asia/Dubai', ...zones.map(current)])].filter(isTimeZone).sort();
  }
  return cached;
}

/** The time zone this device is set to: only ever a suggestion for a form's first value. */
export function deviceTimeZone(): string {
  try {
    const zone = current(Intl.DateTimeFormat().resolvedOptions().timeZone);
    return isTimeZone(zone) ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}
