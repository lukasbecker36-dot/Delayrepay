/**
 * Bank holidays, because trains run to a different timetable on them.
 *
 * On a bank holiday an operator often runs a Saturday or special timetable, so
 * the train someone catches every working day may simply not exist. On Monday
 * 31 August 2026, the summer bank holiday in England and Wales, the 07:03 from
 * Hassocks ran as a 07:02 - and a scan for the 07:03 found nothing.
 *
 * England and Wales and Scotland keep different lists. In 2026 the summer bank
 * holiday was 31 August in one and 3 August in the other, so both are checked
 * and the result names which one applies. A route's own country is not known
 * here, so a holiday in either is worth mentioning.
 *
 * Dates come from GOV.UK via scripts/import-bank-holidays.mjs.
 *
 * Pure. No network, no clock.
 */

import { ENGLAND_AND_WALES, SCOTLAND } from './bankHolidays.data.js';

export interface BankHoliday {
  readonly region: 'England and Wales' | 'Scotland';
  readonly title: string;
}

/** Every bank holiday falling on `date` (YYYY-MM-DD), in England and Wales then Scotland. */
export function bankHolidaysOn(date: string): readonly BankHoliday[] {
  const holidays: BankHoliday[] = [];
  const englandAndWales = ENGLAND_AND_WALES[date];
  if (englandAndWales !== undefined) holidays.push({ region: 'England and Wales', title: englandAndWales });
  const scotland = SCOTLAND[date];
  if (scotland !== undefined) holidays.push({ region: 'Scotland', title: scotland });
  return holidays;
}

/**
 * The sentence to add to a result when a train was not where the timetable
 * usually puts it, or null when `date` was not a bank holiday.
 */
export function bankHolidayNote(date: string): string | null {
  const holidays = bankHolidaysOn(date);
  if (holidays.length === 0) return null;

  const where =
    holidays.length === 2 && holidays[0]?.title === holidays[1]?.title
      ? `a bank holiday in England, Wales and Scotland (${holidays[0]?.title})`
      : `a bank holiday in ${holidays.map((h) => `${h.region} (${h.title})`).join(' and in ')}`;

  return (
    `${date} was ${where}. Trains often run to a different timetable on bank ` +
    'holidays, so your usual train may not have been in it - look for one at a ' +
    'similar time that day.'
  );
}
