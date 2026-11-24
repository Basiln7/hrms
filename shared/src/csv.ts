/*
 * Writing CSV for spreadsheets.
 *
 * A spreadsheet treats a cell that starts with =, +, - or @ as a formula and runs it. A
 * person's name, a department or a reason can be typed by anyone, so text that starts that
 * way is written with an apostrophe in front, which makes it plain text and is not shown as
 * part of the value. Numbers are written as numbers and need none of this.
 */

export type CsvCell = string | number | null | undefined;

/** What a spreadsheet would read as the start of a formula, or use to smuggle one in. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell as it is written into the file. */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  // Quoted when it holds a comma, a quote or a line break, or has space at an end that would otherwise be lost.
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Rows as a CSV file. It starts with a byte-order mark, so that spreadsheets read it as
 * UTF-8 and names in any script come out right, and ends every row with CRLF, as the
 * format asks.
 */
export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
