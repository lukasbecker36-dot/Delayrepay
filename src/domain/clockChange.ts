/**
 * UK clock changes.
 *
 * HSP times are local London clock readings, so on the two nights a year when
 * the clocks move, the difference between two clock readings is not the real
 * elapsed time. A service scheduled 0055 and arriving 0205 on the spring
 * transition looks 70 minutes late and is 10.
 *
 * These journeys are rare enough not to justify a timezone engine and wrong
 * enough not to be scored silently, so they are detected and flagged.
 */

import { parseIsoDate, toIsoDate } from './window.js';

export type ClockChange = 'spring-forward' | 'autumn-back';

const MS_PER_DAY = 86_400_000;

/** Last Sunday of the given month (0-indexed) in the given year, as YYYY-MM-DD. */
function lastSundayOf(year: number, monthIndex: number): string {
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0));
  const offsetToSunday = lastDay.getUTCDay();
  return toIsoDate(lastDay.getTime() - offsetToSunday * MS_PER_DAY);
}

/** Which clock change, if any, falls on this date. */
export function clockChangeOn(date: string): ClockChange | null {
  const year = new Date(parseIsoDate(date)).getUTCFullYear();
  if (date === lastSundayOf(year, 2)) return 'spring-forward';
  if (date === lastSundayOf(year, 9)) return 'autumn-back';
  return null;
}

/**
 * Whether a journey's clock times straddle a transition.
 *
 * The transition happens at 0100 UTC, which is 0100 local in spring and 0200
 * local in autumn. Anything scheduled in the small hours of a transition date
 * is treated as suspect; the window is deliberately wide because being
 * approximately cautious beats being precisely wrong.
 */
export function spansClockChange(
  date: string,
  scheduledMinutes: readonly (number | null)[],
): ClockChange | null {
  const change = clockChangeOn(date);
  if (change === null) return null;

  const SUSPECT_UNTIL = 3 * 60;
  const touchesSmallHours = scheduledMinutes.some(
    (minutes) => minutes !== null && minutes <= SUSPECT_UNTIL,
  );
  return touchesSmallHours ? change : null;
}
