/**
 * The 28-day claim window.
 *
 * Delay Repay claims must be made within 28 days of the journey, which is why
 * the free scan covers exactly 28 days and why reminders are phrased as time to
 * expiry rather than as a fixed schedule.
 *
 * All arithmetic here is on calendar dates in UTC. Dates are handled as
 * date-only strings so that British Summer Time never shifts a day count.
 */

/** Days a claim stays open, counting the journey date as day zero. */
export const CLAIM_WINDOW_DAYS = 28;

/** Days remaining at or below which a claim is worth chasing now. */
export const EXPIRING_SOON_DAYS = 3;

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ClaimWindowStatus = 'open' | 'expiring-soon' | 'expired';

export interface ClaimWindow {
  /** Journey date, YYYY-MM-DD. */
  readonly journeyDate: string;
  /** Last date a claim can be made, YYYY-MM-DD. */
  readonly expiresOn: string;
  /** Whole days left to claim. Zero means the window closes today. */
  readonly daysRemaining: number;
  readonly status: ClaimWindowStatus;
}

/** Parses a YYYY-MM-DD string to a UTC-midnight epoch. Throws on bad input. */
export function parseIsoDate(date: string): number {
  if (!ISO_DATE.test(date)) {
    throw new RangeError(`Expected a YYYY-MM-DD date, received "${date}"`);
  }
  const epoch = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(epoch)) {
    throw new RangeError(`"${date}" is not a real date`);
  }
  // Date.parse accepts 2026-02-30 on some engines by rolling it forward; a
  // round trip catches that.
  if (toIsoDate(epoch) !== date) {
    throw new RangeError(`"${date}" is not a real date`);
  }
  return epoch;
}

/** Formats a UTC epoch as YYYY-MM-DD. */
export function toIsoDate(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to`. Negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseIsoDate(to) - parseIsoDate(from)) / MS_PER_DAY);
}

/** Shifts a YYYY-MM-DD date by a whole number of days. */
export function addDays(date: string, days: number): string {
  return toIsoDate(parseIsoDate(date) + days * MS_PER_DAY);
}

/** Where a journey sits in its 28-day claim window, as of `today`. */
export function claimWindowFor(
  journeyDate: string,
  today: string,
  windowDays: number = CLAIM_WINDOW_DAYS,
): ClaimWindow {
  const expiresOn = addDays(journeyDate, windowDays);
  const daysRemaining = daysBetween(today, expiresOn);

  let status: ClaimWindowStatus;
  if (daysRemaining < 0) status = 'expired';
  else if (daysRemaining <= EXPIRING_SOON_DAYS) status = 'expiring-soon';
  else status = 'open';

  return { journeyDate, expiresOn, daysRemaining, status };
}

/**
 * The date range the free scan covers: the full claimable window ending today.
 *
 * Nothing is being withheld beyond this - a journey older than the window has
 * nothing left to claim.
 */
export function scanRange(
  today: string,
  windowDays: number = CLAIM_WINDOW_DAYS,
): { readonly from: string; readonly to: string } {
  return { from: addDays(today, -windowDays), to: today };
}
