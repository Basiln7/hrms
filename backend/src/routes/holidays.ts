import { Router } from 'express';
import { z } from 'zod';
import { HOLIDAY_YEAR_MAX, HOLIDAY_YEAR_MIN, localDateOf, type HolidayType } from '@delta-hrms/shared';
import { clock } from '../clock';
import { contextOf, requirePermission } from '../http/context';
import { id, idList, localDate } from '../http/schemas';
import { calendarDetail, calendarList, copyCalendarYear, createCalendar, createHoliday, deleteCalendar, deleteHoliday, giveCalendar, makeDefaultCalendar, myHolidays, renameCalendar, updateHoliday } from '../services/holidays';
import { loadCompany } from '../services/settings';

const year = z.coerce.number().int().min(HOLIDAY_YEAR_MIN, 'Choose a year from 2000 on.').max(HOLIDAY_YEAR_MAX, 'Choose a year up to 2100.');
const yearQuery = z.strictObject({ year: year.optional() });
/** The year asked for, or this one by the company's calendar. */
const yearOr = async (asked: number | undefined) => asked ?? Number(localDateOf(clock.now(), (await loadCompany()).timeZone).slice(0, 4));

// Only the shape is checked here. Whether the holiday makes sense is decided by the shared
// `validateHoliday`, the same code the form runs while it is being filled in.
const holidayFields = {
  date: z.string().max(10),
  name: z.string().max(200),
  type: z.enum(['public', 'company', 'optional', 'special_working_day'] satisfies HolidayType[]),
  description: z.string().max(1000),
  /** "I have seen what this changes in days that have already begun." */
  confirmPast: z.boolean().optional(),
};

/** Holiday calendars: all of it needs `holidays.manage`. */
export const holidayCalendarRoutes = Router();
holidayCalendarRoutes.use(requirePermission('holidays.manage'));

holidayCalendarRoutes.get('/', async (req, res) => {
  res.json(await calendarList(await yearOr(yearQuery.parse(req.query).year)));
});

holidayCalendarRoutes.post('/', async (req, res) => {
  const input = z.strictObject({ name: z.string().max(200) }).parse(req.body);
  res.status(201).json(await createCalendar(contextOf(req), input.name));
});

/** Puts people on a calendar, or on none, from a date. Before `/:id` so that "assign" is never read as an id. */
holidayCalendarRoutes.post('/assign', async (req, res) => {
  const input = z.strictObject({ calendarId: id.nullable(), employeeIds: idList, effectiveFrom: localDate }).parse(req.body);
  res.json(await giveCalendar(contextOf(req), input));
});

holidayCalendarRoutes.get('/:id', async (req, res) => {
  res.json(await calendarDetail(id.parse(req.params.id), await yearOr(yearQuery.parse(req.query).year)));
});

holidayCalendarRoutes.patch('/:id', async (req, res) => {
  const input = z.strictObject({ name: z.string().max(200) }).parse(req.body);
  res.json(await renameCalendar(contextOf(req), id.parse(req.params.id), input.name));
});

holidayCalendarRoutes.delete('/:id', async (req, res) => {
  await deleteCalendar(contextOf(req), id.parse(req.params.id));
  res.status(204).end();
});

holidayCalendarRoutes.post('/:id/default', async (req, res) => {
  z.strictObject({}).parse(req.body ?? {});
  await makeDefaultCalendar(contextOf(req), id.parse(req.params.id));
  res.status(204).end();
});

holidayCalendarRoutes.post('/:id/copy-year', async (req, res) => {
  const input = z.strictObject({ fromYear: year }).parse(req.body);
  res.json(await copyCalendarYear(contextOf(req), id.parse(req.params.id), input.fromYear));
});

/** Holidays. Everyone may read their own; changing any needs `holidays.manage`. */
export const holidayRoutes = Router();

/** The signed-in person's holidays in a year, each from the calendar they were on at that date. Nobody else's can be asked for. */
holidayRoutes.get('/mine', async (req, res) => {
  res.json(await myHolidays(contextOf(req).employee, await yearOr(yearQuery.parse(req.query).year)));
});

holidayRoutes.post('/', requirePermission('holidays.manage'), async (req, res) => {
  const { calendarId, confirmPast, ...input } = z.strictObject({ calendarId: id, ...holidayFields }).parse(req.body);
  res.status(201).json(await createHoliday(contextOf(req), calendarId, input, confirmPast === true));
});

holidayRoutes.patch('/:id', requirePermission('holidays.manage'), async (req, res) => {
  const { confirmPast, ...input } = z.strictObject(holidayFields).parse(req.body);
  res.json(await updateHoliday(contextOf(req), id.parse(req.params.id), input, confirmPast === true));
});

holidayRoutes.delete('/:id', requirePermission('holidays.manage'), async (req, res) => {
  const query = z.strictObject({ confirmPast: z.literal('1').optional() }).parse(req.query);
  await deleteHoliday(contextOf(req), id.parse(req.params.id), query.confirmPast === '1');
  res.status(204).end();
});
