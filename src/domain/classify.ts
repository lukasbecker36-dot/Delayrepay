/**
 * Turning one HSP service record into one honest answer about one journey.
 *
 * This is the whole product. It is pure: no network, no clock, no UI. `today`
 * is passed in so results are reproducible and the 28-day arithmetic is
 * testable.
 */

import { minutesLate, parseClockTime } from './time.js';
import { claimWindowFor } from './window.js';
import { resolveThreshold, DEFAULT_MINIMUM_DELAY_MINUTES } from './operators.js';
import { spansClockChange } from './clockChange.js';
import type { JourneyAssessment, ServiceCall, ServiceRecord } from './types.js';

/**
 * HSP's ambiguous code. It is attached both to delays and to cancellations, so
 * on its own it never settles which happened.
 */
const AMBIGUOUS_REASON_CODE = '574';

export interface ClassifyInput {
  /** The matched service, or null when HSP returned nothing for this journey. */
  readonly record: ServiceRecord | null;
  /** Origin CRS code. */
  readonly from: string;
  /** Destination CRS code. */
  readonly to: string;
  /** Journey date, YYYY-MM-DD. Used when `record` is null. */
  readonly date: string;
  /** Today's date, YYYY-MM-DD, for the claim window. */
  readonly today: string;
  /** Threshold in minutes, overriding the operator's. */
  readonly thresholdMinutes?: number | null;
}

interface LegCalls {
  readonly origin: ServiceCall;
  readonly destination: ServiceCall;
}

function sameStation(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/**
 * Picks the origin and destination calls for the leg the user actually made.
 *
 * A service can call at the same station twice, so the destination is taken
 * from after the origin rather than from the first match anywhere.
 */
function findLeg(
  calls: readonly ServiceCall[],
  from: string,
  to: string,
): LegCalls | null {
  const originIndex = calls.findIndex((call) => sameStation(call.location, from));
  if (originIndex === -1) return null;

  for (let i = originIndex + 1; i < calls.length; i += 1) {
    const call = calls[i];
    if (call && sameStation(call.location, to)) {
      const origin = calls[originIndex];
      if (!origin) return null;
      return { origin, destination: call };
    }
  }
  return null;
}

export function classifyJourney(input: ClassifyInput): JourneyAssessment {
  const { record, from, to, today } = input;
  const date = record?.date ?? input.date;
  const claimWindow = claimWindowFor(date, today);
  const notes: string[] = [];

  const threshold = resolveThreshold(record?.tocCode, input.thresholdMinutes);
  // Only worth saying when there is a service to score. On a journey we could
  // not find at all, the threshold is beside the point.
  if (!threshold.confirmed && record !== null) {
    notes.push(
      threshold.operator
        ? `${threshold.operator.name}'s Delay Repay threshold has not been confirmed, ` +
          `so ${DEFAULT_MINIMUM_DELAY_MINUTES} minutes was assumed. Some operators only ` +
          `pay from 30 minutes. Check their terms before claiming.`
        : `No Delay Repay threshold on file for this operator, so ` +
          `${DEFAULT_MINIMUM_DELAY_MINUTES} minutes was assumed. Check their terms ` +
          `before claiming.`,
    );
  }

  const base = {
    date,
    from,
    to,
    operator: threshold.operator,
    thresholdMinutes: threshold.minutes,
    thresholdConfirmed: threshold.confirmed,
    claimWindow,
  } as const;

  // HSP never saw this service. That is not the same as the train running
  // fine: a service struck from the day's plan, as happens during industrial
  // action, is simply absent from the data.
  if (record === null) {
    notes.push(
      'No matching service was found in the performance data. That can mean the ' +
        'train ran and was not matched, or that it was removed from the day\'s plan ' +
        'entirely, which is what happens during industrial action. Worth checking ' +
        'yourself.',
    );
    return {
      ...base,
      scheduledDeparture: null,
      scheduledArrival: null,
      actualDeparture: null,
      actualArrival: null,
      delayMinutes: null,
      outcome: 'service-not-found',
      evidence: 'none',
      looksClaimable: false,
      needsManualCheck: true,
      rid: null,
      tocCode: null,
      reasonCode: null,
      notes,
    };
  }

  const leg = findLeg(record.calls, from, to);
  if (leg === null) {
    notes.push(
      `The matched service does not call at ${from} then ${to}, so this journey ` +
        'could not be scored. Worth checking yourself.',
    );
    return {
      ...base,
      scheduledDeparture: null,
      scheduledArrival: null,
      actualDeparture: null,
      actualArrival: null,
      delayMinutes: null,
      outcome: 'service-not-found',
      evidence: 'none',
      looksClaimable: false,
      needsManualCheck: true,
      rid: record.rid,
      tocCode: record.tocCode,
      reasonCode: null,
      notes,
    };
  }

  const { origin, destination } = leg;
  const reasonCode = destination.lateCancReason ?? origin.lateCancReason ?? null;

  const scheduledDepartureMinutes = parseClockTime(origin.scheduledDeparture);
  const scheduledArrivalMinutes = parseClockTime(destination.scheduledArrival);
  const actualArrivalMinutes = parseClockTime(destination.actualArrival);

  const clockChange = spansClockChange(date, [
    scheduledDepartureMinutes,
    scheduledArrivalMinutes,
  ]);
  if (clockChange !== null) {
    notes.push(
      `The clocks changed on ${date}, so the recorded times for this journey may ` +
        'be an hour out either way. Check this one yourself.',
    );
  }

  const shared = {
    ...base,
    scheduledDeparture: origin.scheduledDeparture,
    scheduledArrival: destination.scheduledArrival,
    actualDeparture: origin.actualDeparture,
    actualArrival: destination.actualArrival,
    rid: record.rid,
    tocCode: record.tocCode,
    reasonCode,
  } as const;

  // Scheduled to arrive, but no arrival was ever recorded. HSP does not report
  // cancellations directly - this absence is the strongest signal there is, and
  // cancellations are a large share of real claims.
  if (scheduledArrivalMinutes !== null && actualArrivalMinutes === null) {
    const neverDeparted = parseClockTime(origin.actualDeparture) === null;
    notes.push(
      'No arrival was recorded for this service. The performance data does not ' +
        'report cancellations directly, so a missing arrival is the closest signal ' +
        'there is' +
        (neverDeparted ? ', and no departure was recorded either.' : '.'),
    );
    if (reasonCode === AMBIGUOUS_REASON_CODE) {
      notes.push(
        `Reason code ${AMBIGUOUS_REASON_CODE} was recorded, which is used for both ` +
          'delays and cancellations and so does not settle which happened.',
      );
    }
    return {
      ...shared,
      delayMinutes: null,
      outcome: 'arrival-not-recorded',
      evidence: 'inferred-from-absent-times',
      looksClaimable: true,
      needsManualCheck: true,
      notes,
    };
  }

  // No scheduled arrival to measure against.
  if (scheduledArrivalMinutes === null || actualArrivalMinutes === null) {
    notes.push(
      `The performance data has no timetabled arrival at ${to} for this service, ` +
        'so the delay could not be measured. Worth checking yourself.',
    );
    return {
      ...shared,
      delayMinutes: null,
      outcome: 'service-not-found',
      evidence: 'none',
      looksClaimable: false,
      needsManualCheck: true,
      notes,
    };
  }

  const delayMinutes = minutesLate(scheduledArrivalMinutes, actualArrivalMinutes);
  const delayed = delayMinutes >= threshold.minutes;

  if (!delayed && clockChange === null && delayMinutes >= threshold.minutes - 5) {
    notes.push(
      `This came in ${delayMinutes} minutes late, just inside the ` +
        `${threshold.minutes}-minute threshold. If you remember it differently, ` +
        'trust your memory over this and check.',
    );
  }

  return {
    ...shared,
    delayMinutes,
    outcome: delayed ? 'delayed' : 'within-threshold',
    evidence: 'recorded-times',
    looksClaimable: delayed,
    needsManualCheck: clockChange !== null,
    notes,
  };
}
