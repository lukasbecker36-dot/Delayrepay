/**
 * Every user-facing sentence the checker produces.
 *
 * It lives in one file so the language stays fixed: the tool surfaces
 * candidates, it does not adjudicate. It says a journey "looks claimable". It
 * never says a claim is valid, and it never puts a figure on one - the data
 * cannot support either claim (see the HSP limitations in CLAUDE.md), and copy
 * that implies certainty is a bug in itself.
 *
 * `test/copy.test.ts` asserts that none of the banned constructions can appear.
 */

import type { JourneyAssessment } from './types.js';
import type { ClaimWindow } from './window.js';

/** "HHMM" as "HH:MM", for prose rather than for the times column. */
export function formatClockTime(time: string): string {
  return /^\d{4}$/.test(time) ? `${time.slice(0, 2)}:${time.slice(2)}` : time;
}

/**
 * Lateness in words.
 *
 * A train can arrive early, and "arrived -1 minutes late" both reads as
 * nonsense and quietly undermines every number printed next to it.
 */
export function describeLateness(minutes: number): string {
  if (minutes > 0) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} late`;
  if (minutes === 0) return 'on time';
  const early = Math.abs(minutes);
  return `${early} ${early === 1 ? 'minute' : 'minutes'} early`;
}

/** How a journey reads in a list of results. */
export function describeOutcome(assessment: JourneyAssessment): string {
  switch (assessment.outcome) {
    case 'delayed':
      return (
        `Arrived ${describeLateness(assessment.delayMinutes ?? 0)}, at or over the ` +
        `${assessment.thresholdMinutes}-minute threshold. This looks claimable.`
      );
    case 'arrival-not-recorded':
      return (
        'No arrival recorded, which usually means the service was cancelled. ' +
        'This looks claimable.'
      );
    case 'did-not-call': {
      // Deliberately not phrased as a delay figure for this journey: the train
      // never reached the destination, so there is no arrival to be late for.
      const seen = assessment.lastRecordedCall;
      const where =
        seen === null
          ? ''
          : ` It was last recorded at ${seen.location}` +
            (seen.minutesLate === null
              ? '.'
              : `, ${describeLateness(seen.minutesLate)} there.`);
      return (
        `This train ran but did not call at ${assessment.to}.${where} ` +
        'This looks claimable.'
      );
    }
    case 'within-threshold':
      return (
        `Arrived ${describeLateness(assessment.delayMinutes ?? 0)}, inside the ` +
        `${assessment.thresholdMinutes}-minute threshold.`
      );
    case 'service-not-found':
      return 'This service could not be found in the performance data.';
    case 'awaiting-data':
      return 'Too recent to check - the performance data has not caught up yet.';
  }
}

/** Reminder language, driven by time to expiry rather than by how long it has sat. */
export function describeExpiry(window: ClaimWindow): string {
  const { daysRemaining } = window;
  if (daysRemaining < 0) {
    const ago = Math.abs(daysRemaining);
    return `The 28-day claim window closed ${ago} ${ago === 1 ? 'day' : 'days'} ago.`;
  }
  if (daysRemaining === 0) return 'Expires today.';
  if (daysRemaining === 1) return 'Expires tomorrow.';
  return `Expires in ${daysRemaining} days.`;
}

/** Where to claim, when the operator's page is known. */
export function describeWhereToClaim(assessment: JourneyAssessment): string {
  const { operator } = assessment;
  if (operator?.claimUrl) {
    return `Claim with ${operator.name}: ${operator.claimUrl}`;
  }
  if (operator) {
    return `Claim with ${operator.name}, through their own Delay Repay page.`;
  }
  return 'Claim through the operating company\'s own Delay Repay page.';
}

/**
 * How much of what the scan set out to check it actually managed to check.
 *
 * Passed separately from the assessments because the difference between them is
 * the whole point: an empty result list means "we looked and found nothing" only
 * if we looked.
 */
export interface ScanCoverage {
  /** Journey dates the scan set out to check. */
  readonly expected: number;
  /** How many of those it got performance data for, one way or the other. */
  readonly checked: number;
}

/**
 * The line at the top of a batch of results.
 *
 * One message covering every candidate, never one per journey - four emails
 * about four delays is the behaviour of a product that has stopped being useful.
 *
 * Pass `coverage` wherever it is known. Without it this can only describe the
 * assessments it is given, and a scan that failed outright has no assessments -
 * which reads exactly like a scan that found nothing wrong.
 */
export function summariseScan(
  assessments: readonly JourneyAssessment[],
  coverage?: ScanCoverage,
): string {
  // "No journeys look claimable" is a finding, and a finding has to be earned.
  // Saying it after a scan that read no data at all is how someone lets a
  // 28-day window close believing they had been told there was nothing there.
  if (coverage && coverage.checked === 0) {
    if (coverage.expected === 0) return 'No journeys in this range to check.';
    return (
      `Nothing could be checked. None of the ${coverage.expected} ` +
      `${coverage.expected === 1 ? 'journey' : 'journeys'} in this range could be ` +
      'looked up, so this is not a result - it is a failure to read the data.'
    );
  }

  const claimable = assessments.filter((a) => a.looksClaimable);
  const unchecked = assessments.filter((a) => !a.looksClaimable && a.needsManualCheck);
  const tooRecent = assessments.filter((a) => a.outcome === 'awaiting-data');

  const parts: string[] = [];

  // Leads, rather than trailing as a footnote, because it changes how every
  // sentence after it should be read.
  if (coverage && coverage.checked < coverage.expected) {
    parts.push(
      `Only ${coverage.checked} of ${coverage.expected} journeys in this range could ` +
        'be checked, so this list may be incomplete.',
    );
  }

  if (claimable.length === 0) {
    parts.push('No journeys in this range look claimable.');
  } else {
    const soonest = claimable.reduce((earliest, candidate) =>
      candidate.claimWindow.daysRemaining < earliest.claimWindow.daysRemaining
        ? candidate
        : earliest,
    );
    parts.push(
      `${claimable.length} ${claimable.length === 1 ? 'journey looks' : 'journeys look'} ` +
        `claimable. The first to expire: ${soonest.date}, ` +
        `${describeExpiry(soonest.claimWindow).toLowerCase()}`,
    );
  }

  if (unchecked.length > 0) {
    parts.push(
      `${unchecked.length} ${unchecked.length === 1 ? 'journey' : 'journeys'} could not ` +
        'be checked against the performance data. Those are worth a look yourself.',
    );
  }

  if (tooRecent.length > 0) {
    parts.push(
      `${tooRecent.length} ${tooRecent.length === 1 ? 'journey is' : 'journeys are'} too ` +
        'recent to check yet. Try again in a day or two - there is still time on those.',
    );
  }

  return parts.join(' ');
}
