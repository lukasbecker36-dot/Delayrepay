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
import { bankHolidayNote } from './bankHolidays.js';
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
export function reasonCodeNotes(reasonCode: string | null): readonly string[] {
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
  /**
   * The first train back to the destination from the station a service was
   * next recorded at after running past it. Supplied, like `onwardConnection`,
   * by the caller on a second pass.
   */
  readonly carriedPastConnection?: OnwardConnection | null;
}

interface LegCalls {
  readonly origin: ServiceCall;
  readonly destination: ServiceCall;
  /** Calls before the origin, in order. */
  readonly before: readonly ServiceCall[];
  /** Calls strictly between the two, in order. The evidence that a service ran. */
  readonly between: readonly ServiceCall[];
  /** Calls after the destination, in order. Where a service that ran past it went. */
  readonly after: readonly ServiceCall[];
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
      return {
        origin,
        destination: call,
        before: calls.slice(0, originIndex),
        between: calls.slice(originIndex + 1, i),
        after: calls.slice(i + 1),
      };
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

/** The first call with a recorded time, and how late it was there. */
function firstRecordedCall(calls: readonly ServiceCall[]): LastRecordedCall | null {
  for (const call of calls) {
    const found = lastRecordedCall([call]);
    if (found !== null) return found;
  }
  return null;
}

function hasRecordedTime(call: ServiceCall): boolean {
  return call.actualArrival !== null || call.actualDeparture !== null;
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
    carriedPast: null,
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
    const holiday = bankHolidayNote(date);
    if (holiday !== null) notes.push(holiday);
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
    const holiday = bankHolidayNote(date);
    if (holiday !== null) notes.push(holiday);
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

  /** "The first train ... reached {to} at ..." and what it assumes. */
  const trainTakenNotes = (
    train: OnwardConnection,
    kind: 'on' | 'back' | 'instead',
  ): readonly string[] => {
    const lines: string[] = [];
    const arrival =
      `reached ${to} at ${displayClockTime(train.arrived)} - ` +
      `${train.totalDelayMinutes} minutes after your booked arrival.`;
    if (kind === 'instead') {
      lines.push(
        `The first train you could have caught instead left ${train.from} at ` +
          `${displayClockTime(train.departed)}, ${train.waitMinutes} ` +
          `${train.waitMinutes === 1 ? 'minute' : 'minutes'} after yours was due to leave, ` +
          `and ${arrival}`,
      );
    } else {
      lines.push(
        `The first train ${kind === 'on' ? 'that could have carried you on' : 'back'} left ` +
          `${train.from} at ${displayClockTime(train.departed)}, ` +
          `${articleFor(train.waitMinutes)} ${train.waitMinutes}-minute wait, and ${arrival}`,
      );
      lines.push(
        train.changeTimeFromTimetable
          ? `That allows the timetable's ${train.changeMinutes}-minute change time ` +
              `at ${train.from}.`
          : `That allows ${train.changeMinutes} minutes to change at ${train.from}, ` +
              "the usual minimum - this station's own change time is not on file.",
      );
      if (train.leftInsideChangeTime !== null) {
        lines.push(
          `A train also left at ${displayClockTime(train.leftInsideChangeTime)}, ` +
            'too soon after you were set down to count as a connection. If you did ' +
            'catch it, claim on that train instead.',
        );
      }
    }
    lines.push(
      'Delay Repay claims are checked against the first train you could have ' +
        'caught, so that is the train this is measured to. If you could not board ' +
        'it - for example because it was too full - say so when you claim.',
    );
    return lines;
  };

  /** The note owed when a measured total came in under the threshold. */
  const promptTrainNote = (train: OnwardConnection): readonly string[] =>
    train.totalDelayMinutes >= threshold.minutes
      ? []
      : [
          `That total is inside the ${threshold.minutes}-minute threshold, but only ` +
            'because a train came along promptly. Check it against what you ' +
            'remember before writing the journey off.',
        ];

  // A train that ran through the origin without calling could not be boarded.
  // Recorded both before and after it is what separates that from a gap in the
  // data at a train's first stop - it cannot skip where it starts.
  if (
    !hasRecordedTime(origin) &&
    leg.before.some(hasRecordedTime) &&
    [...leg.between, destination, ...leg.after].some(hasRecordedTime)
  ) {
    notes.push(
      `This train was recorded before and after ${from} but not at ${from}, which ` +
        'usually means it did not stop there and could not be boarded.',
    );
    notes.push(...reasonCodeNotes(reasonCode));
    const onward = input.onwardConnection ?? null;
    if (onward !== null) {
      notes.push(...trainTakenNotes(onward, 'instead'), ...promptTrainNote(onward));
    }
    return {
      ...shared,
      delayMinutes: onward?.totalDelayMinutes ?? null,
      onwardConnection: onward,
      outcome: 'skipped-origin',
      evidence: onward === null ? 'inferred-from-absent-times' : 'assumed-onward-connection',
      looksClaimable: onward === null || onward.totalDelayMinutes >= threshold.minutes,
      needsManualCheck: true,
      notes,
    };
  }

  // Scheduled to arrive, but no arrival was ever recorded. HSP does not report
  // cancellations directly - this absence is the strongest signal there is, and
  // cancellations are a large share of real claims.
  if (scheduledArrivalMinutes !== null && actualArrivalMinutes === null) {
    // Before calling this a probable cancellation, look at where the train
    // actually got to - before the destination, and after it. A service that
    // stopped short, or ran past without calling, is not a cancellation, and
    // the difference is the difference between a user being told "probably
    // cancelled" and being told how late they really got in.
    const lastSeen = lastRecordedCall(leg.between);
    const carriedTo = firstRecordedCall(leg.after);

    if (lastSeen !== null || carriedTo !== null) {
      if (lastSeen !== null) {
        notes.push(
          `This service ran but never called at ${to}. It was last recorded at ` +
            `${lastSeen.location} at ${displayClockTime(lastSeen.time)}` +
            (lastSeen.minutesLate === null
              ? '.'
              : `, ${describeLateness(lastSeen.minutesLate)} there.`),
        );
      }
      if (carriedTo !== null) {
        notes.push(
          (lastSeen === null
            ? `This service ran past ${to} without calling there, with no stop before it ` +
              'to get off at. '
            : `It ran on past ${to} without calling there. `) +
            `It was next recorded at ${carriedTo.location} at ` +
            `${displayClockTime(carriedTo.time)}.`,
        );
      }

      // Getting off before the destination, or being carried past it: the
      // data cannot say which, because it does not record when the change of
      // plan was announced. Both are measured.
      const gotOff = lastSeen === null ? null : (input.onwardConnection ?? null);
      const carriedBack = carriedTo === null ? null : (input.carriedPastConnection ?? null);
      const over = (train: OnwardConnection | null) =>
        train !== null && train.totalDelayMinutes >= threshold.minutes;

      if (gotOff === null && carriedBack === null) {
        notes.push(
          lastSeen !== null
            ? `That figure is the delay at ${lastSeen.location}, not at ${to}. Your own ` +
                'delay depends on how you completed the journey, which the performance ' +
                'data cannot see - so work it out from when you actually arrived.'
            : `Your own delay depends on how you got back to ${to}, which the ` +
                'performance data cannot see - so work it out from when you actually arrived.',
        );
        notes.push(...reasonCodeNotes(reasonCode));
        return {
          ...shared,
          delayMinutes: null,
          lastRecordedCall: lastSeen,
          carriedPast: carriedTo === null ? null : { call: carriedTo, connection: null, reported: false },
          outcome: 'did-not-call',
          // The absent arrival is still an inference, but one made against
          // recorded times rather than against silence.
          evidence: 'inferred-from-absent-times',
          looksClaimable: true,
          needsManualCheck: true,
          notes,
        };
      }

      // Measured on getting off before, unless only being carried past is
      // over the threshold - a possible claim is not dropped on a guess.
      const reportCarried =
        carriedBack !== null && (gotOff === null || (over(carriedBack) && !over(gotOff)));
      const reported = (reportCarried ? carriedBack : gotOff) as OnwardConnection;
      const other = reportCarried ? gotOff : carriedBack;

      notes.push(...trainTakenNotes(reported, reportCarried ? 'back' : 'on'));
      if (other !== null && lastSeen !== null && carriedTo !== null) {
        notes.push(
          reportCarried
            ? `If the change of plan was announced in time for you to get off at ` +
                `${lastSeen.location} instead, the first train on from there reached ${to} ` +
                `at ${displayClockTime(other.arrived)}, ` +
                `${describeLateness(other.totalDelayMinutes)} - inside the threshold. ` +
                'Which applies depends on whether you could get off there.'
            : `If you could not get off before ${to} and were carried on to ` +
                `${carriedTo.location}, the first train back reached ${to} at ` +
                `${displayClockTime(other.arrived)}, ${describeLateness(other.totalDelayMinutes)}` +
                (over(other) ? '.' : ' - also inside the threshold.'),
        );
      }
      notes.push(...reasonCodeNotes(reasonCode));
      notes.push(...promptTrainNote(reported));

      return {
        ...shared,
        // Now a real delay at the destination, so it belongs in delayMinutes -
        // flagged by `evidence` as resting on the connection assumption.
        delayMinutes: reported.totalDelayMinutes,
        lastRecordedCall: lastSeen,
        onwardConnection: reported,
        carriedPast:
          carriedTo === null
            ? null
            : { call: carriedTo, connection: carriedBack, reported: reportCarried },
        outcome: 'did-not-call',
        evidence: 'assumed-onward-connection',
        looksClaimable: over(reported),
        // Always. The connection is an assumption, so this never becomes a
        // negative result the tool asserts on its own.
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

    // Cancelled: measured on the first train that left the origin after it.
    const instead = neverDeparted ? (input.onwardConnection ?? null) : null;
    if (instead !== null) {
      notes.push(...trainTakenNotes(instead, 'instead'), ...promptTrainNote(instead));
      return {
        ...shared,
        delayMinutes: instead.totalDelayMinutes,
        onwardConnection: instead,
        outcome: 'arrival-not-recorded',
        evidence: 'assumed-onward-connection',
        looksClaimable: instead.totalDelayMinutes >= threshold.minutes,
        needsManualCheck: true,
        notes,
      };
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
