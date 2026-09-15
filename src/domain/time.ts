/**
 * HSP reports clock times as four-digit local (Europe/London) strings: "0715".
 * Everything in this module works in minutes-since-midnight so that the delay
 * arithmetic is a plain integer comparison with one wrap rule.
 */

/** Minutes in a day. */
const DAY = 1440;

/**
 * Largest gap we treat as "same service, later the same day". Anything beyond
 * this is assumed to be a midnight wrap rather than a 13-hour delay.
 */
const WRAP_THRESHOLD = DAY / 2;

/**
 * Parses an HSP "HHMM" clock time into minutes since midnight.
 *
 * HSP uses the empty string for a time that does not apply (an origin has no
 * arrival) and, critically, for a time that was never recorded — see the
 * cancellation caveat in CLAUDE.md. Both arrive here as null; telling them
 * apart is the caller's job, not this function's.
 */
export function parseClockTime(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const value = raw.trim();
  if (value === '') return null;
  if (!/^\d{4}$/.test(value)) return null;

  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(2, 4));
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

/** Formats minutes since midnight back to "HHMM". Wraps at a day boundary. */
export function formatClockTime(minutesSinceMidnight: number): string {
  const wrapped = ((Math.trunc(minutesSinceMidnight) % DAY) + DAY) % DAY;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}`;
}

/**
 * Minutes late, comparing an actual clock time against a scheduled one.
 *
 * Positive means late, negative means early. A service scheduled at 2350 and
 * arriving at 0015 is 25 minutes late, not 1415 minutes early, so a difference
 * larger than half a day is folded across the midnight boundary.
 *
 * Both times are local London clock readings. On the two nights a year when the
 * clocks change, a journey spanning 0100-0200 can be out by 60 minutes. Such
 * services are flagged rather than scored - see `spansClockChange` in
 * classify.ts.
 */
export function minutesLate(scheduled: number, actual: number): number {
  let difference = actual - scheduled;
  if (difference > WRAP_THRESHOLD) difference -= DAY;
  if (difference < -WRAP_THRESHOLD) difference += DAY;
  return difference;
}

/** Convenience wrapper over `parseClockTime` + `minutesLate` for raw HSP fields. */
export function minutesLateFromClockTimes(
  scheduledRaw: string | null | undefined,
  actualRaw: string | null | undefined,
): number | null {
  const scheduled = parseClockTime(scheduledRaw);
  const actual = parseClockTime(actualRaw);
  if (scheduled === null || actual === null) return null;
  return minutesLate(scheduled, actual);
}
