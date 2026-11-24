import { z } from 'zod';
import { ID_PATTERN, isLocalDate, PASSWORD_MAX, PASSWORD_MIN, ROLES, WEEKDAYS, type Weekday } from '@delta-hrms/shared';

/*
 * Building blocks for validating request bodies. Anything a browser sends is untrusted.
 * Every body schema is built with `z.strictObject`, so a field the route does not expect
 * (a time on a check-in, a role on a profile change) is refused instead of ignored.
 */

export const id = z.string().regex(ID_PATTERN, 'That id is not valid.');
export const text = (max: number) => z.string().trim().max(max, `Keep this to ${max} characters or fewer.`);
export const required = (max: number, message: string) => text(max).min(1, message);
export const personName = text(80).min(2, 'Please enter a name.');
export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(160, 'Keep this to 160 characters or fewer.')
  .regex(/^\S+@\S+\.\S+$/, 'Please enter a valid email address.');
export const password = z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters for the password.`).max(PASSWORD_MAX, 'That password is too long.');
export const role = z.enum(ROLES);
export const phone = text(40).regex(/^[0-9+()\-.\s]*$/, 'Use digits, spaces and + ( ) - only.');

/** A calendar day, 'YYYY-MM-DD', that really exists. */
export const localDate = z.string().refine(isLocalDate, 'That date is not valid.');
export const idList = z.array(id).min(1, 'Choose at least one person.').max(500, 'Choose at most 500 people at a time.');

/**
 * The shape of a set of schedule rules. Only the shape is checked here; whether the rules
 * make sense (times, thresholds, what fits in a day) is decided by the shared `validateRules`,
 * which is the same code the web app runs while the form is being filled in.
 */
const dayHours = z.strictObject({
  start: z.string().max(5).nullable(),
  end: z.string().max(5).nullable(),
  requiredMinutes: z.number(),
  fullDayMinutes: z.number(),
  halfDayMinutes: z.number(),
});
const dayRule = z.union([z.literal('off'), z.literal('standard'), dayHours]);
export const scheduleRules = z.strictObject({
  name: z.string().max(200),
  kind: z.enum(['fixed', 'flexible']),
  timeZone: z.string().max(80),
  standard: dayHours,
  days: z.strictObject(Object.fromEntries(WEEKDAYS.map((day) => [day, dayRule])) as Record<Weekday, typeof dayRule>),
  break: z.strictObject({ mode: z.enum(['none', 'fixed', 'tracked']), minutes: z.number(), appliesAfter: z.number() }),
  lateGraceMinutes: z.number(),
  earlyCheckInMinutes: z.number(),
  earlyLeave: z.strictObject({ tracked: z.boolean(), graceMinutes: z.number() }),
  missingCheckOut: z.strictObject({ closeAfterMinutes: z.number(), countsAs: z.enum(['unresolved', 'half_day', 'absent']) }),
  offDayWork: z.enum(['allowed', 'blocked']),
  corrections: z.strictObject({ windowDays: z.number(), maxPerMonth: z.number().nullable() }),
});
