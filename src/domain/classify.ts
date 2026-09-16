/**
 * Turning one HSP service record into one honest answer about one journey.
 *
 * This is the whole product. It is pure: no network, no clock, no UI. `today`
 * is passed in so results are reproducible and the 28-day arithmetic is
 * testable.
 */

import { minutesLate, parseClockTime } from './time.js';
import { articleFor, describeLateness, displayClockTime } from './copy.js';
import { claimWindowFor } from './window.js';
import {
  resolveThreshold,
  DEFAULT_MINIMUM_DELAY_MINUTES,
  type ResolvedThreshold,
} from './operators.js';
import { spansClockChange } from './clockChange.js';
import type { OnwardConnection } from './onward.js';
import type {
  JourneyAssessment,
  LastRecordedCall,
  ServiceCall,
  ServiceRecord,
} from './types.js';

/**
 * HSP's ambiguous code. It is attached both to delays and to cancellations, so
 * on its own it never settles which happened.
 */
const AMBIGUOUS_REASON_CODE = '574';

/**
 * What to say about a reason code.
 *
 * Only 574 used to be mentioned, so every other code - 911 and 824 both turn up
 * on real terminated-short services - was dropped silently. A code the tool
 * cannot interpret is still worth handing over: the operator can read it, and
 * the user is the one making the claim.
 */
function reasonCodeNotes(reasonCode: string | null): readonly string[] {
  if (reasonCode === null) return [];
  if (reasonCode === AMBIGUOUS_REASON_CODE) {
    return [
      `Reason code ${AMBIGUOUS_REASON_CODE} was recorded, which is used for both ` +
        'delays and cancellations and so does not settle which happened.',
    ];
  }
  return [
    `Reason code ${reasonCode} was recorded against this service. This tool does ` +
      'not interpret the code; the operator can.',
  ];
}


/**
 * What a user must be told about the threshold: that it was assumed, or the
 * operator's own caveat when it was not.
 */
export function thresholdNotes(threshold: ResolvedThreshold): readonly string[] {
  if (threshold.confirmed) {
    return threshold.operator?.caveat ? [threshold.operator.caveat] : [];
  }
  return [
    threshold.operator
      ? `${threshold.operator.name}'s Delay Repay threshold has not been confirmed, ` +
        `so ${DEFAULT_MINIMUM_DELAY_MINUTES} minutes was assumed. Some operators only ` +
        `pay from 30 minutes. Check their terms before claiming.`
      : `No Delay Repay threshold on file for this operator, so ` +
        `${DEFAULT_MINIMUM_DELAY_MINUTES} minutes was assumed. Check their terms ` +
        `before claiming.`,
  ];
}

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
  /**
   * True when this date is recent enough that HSP may simply not have the data
   * yet. An absent service then means nothing, and must not be reported as a
   * train that vanished.
   */
  readonly dataMayBeIncomplete?: boolean;
  /**
   * The train the user is assumed to have caught after their own stopped short.
   *
   * Supplied by the caller on a second pass: which onward services ran is a
   * question for HSP, and this function stays pure. Given one, the journey can
   * finally be scored on the delay that actually decides a claim - the one at
   * the destination - instead of on a figure measured somewhere else.
   */
  readonly onwardConnection?: OnwardConnection | null;
}

interface LegCalls {
  readonly origin: ServiceCall;
  readonly destination: ServiceCall;
  /** Calls strictly between the two, in order. The evidence that a service ran. */
  readonly between: readonly ServiceCall[];
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
      return { origin, destination: call, between: calls.slice(originIndex + 1, i) };
    }
  }
  return null;
}

/**
 * The last call before the destination where the railway actually recorded the
 * train, and how late it was there.
 *
 * This is what separates "the train ran and abandoned your journey" from "we
 * have no idea what happened to this train". Both look identical at the
 * destination - an absent arrival - and only the calls in between tell them
 * apart.
 */
function lastRecordedCall(between: readonly ServiceCall[]): LastRecordedCall | null {
  for (let i = between.length - 1; i >= 0; i -= 1) {
    const call = between[i];
    if (!call) continue;

    // Prefer the arrival: it is the time a passenger at that station experienced.
    const time = call.actualArrival ?? call.actualDeparture;
    if (time === null) continue;

    const scheduled =
      call.actualArrival !== null ? call.scheduledArrival : call.scheduledDeparture;
    const scheduledMinutes = parseClockTime(scheduled);
    const actualMinutes = parseClockTime(time);

    return {
      location: call.location,
      time,
      minutesLate:
        scheduledMinutes === null || actualMinutes === null
          ? null
          : minutesLate(scheduledMinutes, actualMinutes),
    };
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
  if (record !== null) notes.push(...thresholdNotes(threshold));

  const base = {
    date,
    from,
    to,
    // Defaults for the fields only a stopped-short journey or a journey with a
    // change sets. Declared once here so a new outcome cannot forget them.
    lastRecordedCall: null,
    onwardConnection: null,
    change: null,
    via: null,
    operator: threshold.operator,
    thresholdMinutes: threshold.minutes,
    thresholdConfirmed: threshold.confirmed,
    claimWindow,
  } as const;

  // Nothing found, and the date is too recent to read anything into that. The
  // train may not have run yet, and the data lags the railway by a day or so.
  // "We cannot see this service" would be a claim about the railway; the truth
  // is only that we cannot see it yet.
  if (record === null && input.dataMayBeIncomplete === true) {
    notes.push(
      'This journey is too recent for the performance data to have caught up. ' +
        'Check again in a day or two.',
    );
    return {
      ...base,
      scheduledDeparture: null,
      scheduledArrival: null,
      actualDeparture: null,
      actualArrival: null,
      delayMinutes: null,
      outcome: 'awaiting-data',
      evidence: 'none',
      looksClaimable: false,
      needsManualCheck: false,
      rid: null,
      tocCode: null,
      reasonCode: null,
      notes,
    };
  }

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
    // Before calling this a probable cancellation, look at where the train
    // actually got to. A service that ran most of the route and then stopped
    // short is not a cancellation, and the difference is the difference between
    // a user being told "probably cancelled" and being told how late the train
    // that abandoned them was.
    const lastSeen = lastRecordedCall(leg.between);

    if (lastSeen !== null) {
      notes.push(
        `This service ran but never called at ${to}. It was last recorded at ` +
          `${lastSeen.location} at ${displayClockTime(lastSeen.time)}` +
          (lastSeen.minutesLate === null
            ? '.'
            : `, ${describeLateness(lastSeen.minutesLate)} there.`),
      );

      const onward = input.onwardConnection ?? null;

      if (onward !== null) {
        notes.push(
          `The first train that could have carried you on left ${onward.from} at ` +
            `${displayClockTime(onward.departed)}, ` +
            `${articleFor(onward.waitMinutes)} ${onward.waitMinutes}-minute wait, and ` +
            `reached ${to} at ${displayClockTime(onward.arrived)} - ` +
            `${onward.totalDelayMinutes} minutes after your booked arrival.`,
        );
        notes.push(
          onward.changeTimeFromTimetable
            ? `That allows the timetable's ${onward.changeMinutes}-minute change time ` +
                `at ${onward.from}.`
            : `That allows ${onward.changeMinutes} minutes to change at ${onward.from}, ` +
                "the usual minimum - this station's own change time is not on file.",
        );
        if (onward.leftInsideChangeTime !== null) {
          notes.push(
            `A train also left at ${displayClockTime(onward.leftInsideChangeTime)}, ` +
              'too soon after you were set down to count as a connection. If you did ' +
              'catch it, claim on that train instead.',
          );
        }
        notes.push(
          'Delay Repay claims are checked against the first train you could have ' +
            'caught, so that is the train this is measured to. If you could not board ' +
            'it - for example because it was too full - say so when you claim.',
        );
        notes.push(...reasonCodeNotes(reasonCode));

        const overThreshold = onward.totalDelayMinutes >= threshold.minutes;
        if (!overThreshold) {
          notes.push(
            `That total is inside the ${threshold.minutes}-minute threshold, but only ` +
              'because a train came along promptly. Check it against what you ' +
              'remember before writing the journey off.',
          );
        }
        return {
          ...shared,
          // Now a real delay at the destination, so it belongs in delayMinutes -
          // flagged by `evidence` as resting on the connection assumption.
          delayMinutes: onward.totalDelayMinutes,
          lastRecordedCall: lastSeen,
          onwardConnection: onward,
          outcome: 'did-not-call',
          evidence: 'assumed-onward-connection',
          looksClaimable: overThreshold,
          // Always. The connection is an assumption, so this never becomes a
          // negative result the tool asserts on its own.
          needsManualCheck: true,
          notes,
        };
      }

      notes.push(
        `That figure is the delay at ${lastSeen.location}, not at ${to}. Your own ` +
          'delay depends on how you completed the journey, which the performance ' +
          'data cannot see - so work it out from when you actually arrived.',
      );
      notes.push(...reasonCodeNotes(reasonCode));
      return {
        ...shared,
        delayMinutes: null,
        lastRecordedCall: lastSeen,
        outcome: 'did-not-call',
        // The absent arrival is still an inference, but one made against
        // recorded times rather than against silence.
        evidence: 'inferred-from-absent-times',
        looksClaimable: true,
        needsManualCheck: true,
        notes,
      };
    }

    const neverDeparted = parseClockTime(origin.actualDeparture) === null;
    notes.push(
      'No arrival was recorded for this service. The performance data does not ' +
        'report cancellations directly, so a missing arrival is the closest signal ' +
        'there is' +
        (neverDeparted ? ', and no departure was recorded either.' : '.'),
    );
    notes.push(...reasonCodeNotes(reasonCode));
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
