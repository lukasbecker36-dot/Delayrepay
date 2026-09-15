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

/** How a journey reads in a list of results. */
export function describeOutcome(assessment: JourneyAssessment): string {
  switch (assessment.outcome) {
    case 'delayed':
      return (
        `Arrived ${assessment.delayMinutes} minutes late, at or over the ` +
        `${assessment.thresholdMinutes}-minute threshold. This looks claimable.`
      );
    case 'arrival-not-recorded':
      return (
        'No arrival recorded, which usually means the service was cancelled. ' +
        'This looks claimable.'
      );
    case 'within-threshold':
      return (
        `Arrived ${assessment.delayMinutes} minutes late, inside the ` +
        `${assessment.thresholdMinutes}-minute threshold.`
      );
    case 'service-not-found':
      return 'This service could not be found in the performance data.';
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
 * The line at the top of a batch of results.
 *
 * One message covering every candidate, never one per journey - four emails
 * about four delays is the behaviour of a product that has stopped being useful.
 */
export function summariseScan(assessments: readonly JourneyAssessment[]): string {
  const claimable = assessments.filter((a) => a.looksClaimable);
  const unchecked = assessments.filter((a) => !a.looksClaimable && a.needsManualCheck);

  const parts: string[] = [];

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

  return parts.join(' ');
}
