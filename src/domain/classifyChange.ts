/**
 * One honest answer about one journey with a change.
 *
 * The first train is judged by the single-train rules in classify.ts, as far as
 * the change station. If it got there, connection.ts works out the rest, and
 * this file turns that into the same JourneyAssessment every other result uses,
 * scored against the threshold of the operator responsible for the delay.
 *
 * If it never got there, the journey is not over. Under the same rule used
 * everywhere else - operators check a claim against the first train that could
 * have been caught - the passenger is measured on the first train that actually
 * left for the change station from where they were left:
 *
 * - cancelled (no departure recorded at the origin), or ran through the origin
 *   without stopping: from the origin, at the first train's booked departure,
 *   with no change time - they were already on the platform;
 * - stopped short: from the last station it was recorded at, at the time it was
 *   recorded there, allowing that station's change time;
 * - ran past the change station without calling: from the next station it was
 *   recorded at, back to the change station.
 *
 * A train that ran past the change station raises a question the data cannot
 * answer: was the change of plan announced in time to get off before it, or
 * were they carried on? Where both are possible both are measured. The result
 * is measured on getting off before, unless only being carried on is over the
 * threshold - a possible claim is not dropped on a guess - and names the other.
 *
 * That train's arrival then goes through the connection as normal, against the
 * original plan. Whatever the connection shows, the delay began with the first
 * train, so its operator answers for it if the plan was broken. The result is
 * always flagged to check: a cancellation is inferred, and which train was
 * caught is not something the data can see.
 *
 * Pure. No network, no clock.
 */

import { classifyJourney, reasonCodeNotes, thresholdNotes } from './classify.js';
import {
  assessChange,
  type AssessChangeInput,
  type ChangeAssessment,
  type ReplacementLeg,
} from './connection.js';
import { pickOnwardConnection } from './onward.js';
import { resolveChangeTime, type ResolvedChangeTime } from './changeTimes.js';
import { findOperator, resolveThreshold } from './operators.js';
import { spansClockChange } from './clockChange.js';
import { bankHolidayNote } from './bankHolidays.js';
import { minutesLate, parseClockTime } from './time.js';
import { articleFor, describeLateness, displayClockTime } from './copy.js';
import type { JourneyAssessment, ServiceRecord } from './types.js';

export interface ClassifyChangeInput {
  /** The first train, or null when HSP returned nothing for it. */
  readonly record: ServiceRecord | null;
  readonly from: string;
  /** The change station. */
  readonly via: string;
  /** The final destination. */
  readonly to: string;
  readonly date: string;
  readonly today: string;
  readonly thresholdMinutes?: number | null;
  readonly dataMayBeIncomplete?: boolean;
  /** Every train seen running from `via` to `to` across the scan range. */
  readonly timetable: AssessChangeInput['timetable'];
  /** This day's records of trains from `via` to `to`. */
  readonly onward: readonly ServiceRecord[];
  readonly changeTimeFor: AssessChangeInput['changeTimeFor'];
  /**
   * TOC codes whose trains are left out of the connection entirely: never the
   * planned connection, never the way on, never counted as missing. The result
   * says so whenever the timetable had one to leave out.
   */
  readonly leaveOutOperators?: readonly string[];
  /**
   * This day's records of trains from wherever the first train left the user
   * to `via`, for when it never got there. Null or absent when they were not
   * looked up - the journey is then reported without a delay figure.
   */
  readonly replacementCandidates?: readonly ServiceRecord[] | null;
  /** The change time at any station, for changing onto a replacement train. */
  readonly changeTimeAt?: (
    station: string,
    arrivingToc: string | null,
    departingToc: string | null,
  ) => ResolvedChangeTime;
}

/** Where a first train that never reached the change station left the user, and from when. */
export interface ReplacementStart {
  readonly reason: ReplacementLeg['reason'];
  readonly station: string;
  readonly readyAt: string;
}

/**
 * Where to look for a way to the change station, most likely first: none when
 * the first train got there, or when what happened to it is too unclear to
 * follow - it left the origin but was recorded nowhere after, for instance. Two
 * when it ran past the change station and either getting off before or being
 * carried on is possible.
 */
export function replacementStarts(
  record: ServiceRecord,
  from: string,
  via: string,
  date: string,
  today: string,
): readonly ReplacementStart[] {
  const firstLeg = classifyJourney({ record, from, to: via, date, today });
  if (firstLeg.outcome === 'skipped-origin' && firstLeg.scheduledDeparture !== null) {
    return [{ reason: 'skipped-origin', station: from, readyAt: firstLeg.scheduledDeparture }];
  }
  if (firstLeg.outcome === 'did-not-call') {
    const starts: ReplacementStart[] = [];
    if (firstLeg.lastRecordedCall !== null) {
      starts.push({
        reason: 'stopped-short',
        station: firstLeg.lastRecordedCall.location,
        readyAt: firstLeg.lastRecordedCall.time,
      });
    }
    if (firstLeg.carriedPast !== null) {
      starts.push({
        reason: 'carried-past',
        station: firstLeg.carriedPast.call.location,
        readyAt: firstLeg.carriedPast.call.time,
      });
    }
    return starts;
  }
  if (
    firstLeg.outcome === 'arrival-not-recorded' &&
    firstLeg.actualDeparture === null &&
    firstLeg.scheduledDeparture !== null
  ) {
    return [{ reason: 'cancelled', station: from, readyAt: firstLeg.scheduledDeparture }];
  }
  return [];
}

/** The first train that actually left `start.station` for `via`, as a replacement leg. */
export function pickReplacement(input: {
  readonly start: ReplacementStart;
  readonly candidates: readonly ServiceRecord[];
  readonly via: string;
  /** When the first train was due at `via`, "HHMM". */
  readonly bookedArrivalAtVia: string;
  readonly firstTocCode: string | null;
  readonly changeTimeAt: NonNullable<ClassifyChangeInput['changeTimeAt']>;
}): ReplacementLeg | null {
  const { start, candidates, via } = input;
  const train = pickOnwardConnection({
    candidates,
    from: start.station,
    to: via,
    setDownAt: start.readyAt,
    bookedArrival: input.bookedArrivalAtVia,
    // Someone whose train never left is already on the platform.
    changeTimeFor: (departingToc) =>
      start.reason === 'cancelled' || start.reason === 'skipped-origin'
        ? { minutes: 0, fromTimetable: true }
        : input.changeTimeAt(start.station, input.firstTocCode, departingToc),
  });
  if (train === null) return null;
  const tocCode = candidates.find((record) => record.rid === train.rid)?.tocCode ?? null;
  return { ...start, tocCode, train };
}

function operatorName(tocCode: string | null): string {
  return findOperator(tocCode)?.name ?? (tocCode ? `operator ${tocCode}` : 'an unknown operator');
}

function changeAllowance(minutes: number, fromTimetable: boolean): string {
  return fromTimetable
    ? `the timetable's ${minutes}-minute change time`
    : `${minutes} minutes to change, the usual minimum`;
}

export function classifyJourneyWithChange(input: ClassifyChangeInput): JourneyAssessment {
  const { record, from, via, to, date, today } = input;

  // The first train, judged as far as the change station.
  const firstLeg = classifyJourney({
    record,
    from,
    to: via,
    date,
    today,
    ...(input.thresholdMinutes == null ? {} : { thresholdMinutes: input.thresholdMinutes }),
    ...(input.dataMayBeIncomplete === undefined
      ? {}
      : { dataMayBeIncomplete: input.dataMayBeIncomplete }),
  });

  const leftOut = new Set((input.leaveOutOperators ?? []).map((code) => code.trim().toUpperCase()));
  const kept = (toc: string | null) => !leftOut.has((toc ?? '').trim().toUpperCase());
  const leftOutNames = [
    ...new Set(input.timetable.filter((slot) => !kept(slot.tocCode)).map((slot) => operatorName(slot.tocCode))),
  ];

  // A first train that never called at the origin could not be boarded, even
  // if it went on to reach the change station.
  let change =
    record === null || firstLeg.outcome === 'skipped-origin'
      ? null
      : assessChange({
          firstLeg: record,
          from,
          via,
          to,
          timetable: input.timetable.filter((slot) => kept(slot.tocCode)),
          onward: input.onward.filter((train) => kept(train.tocCode)),
          changeTimeFor: input.changeTimeFor,
        });

  // It never got to the change station. Follow the passenger from where they
  // were left, if the trains from there were looked up.
  const unreached: ReplacementStart[] = [];
  if (change === null && record !== null && input.replacementCandidates != null) {
    const booked = firstLeg.scheduledArrival;
    const starts = booked === null ? [] : replacementStarts(record, from, via, date, today);
    const options: { readonly leg: ReplacementLeg; readonly scored: JourneyAssessment }[] = [];

    for (const start of starts) {
      const leg = pickReplacement({
        start,
        candidates: input.replacementCandidates.filter((train) => kept(train.tocCode)),
        via,
        bookedArrivalAtVia: booked as string,
        firstTocCode: record.tocCode,
        changeTimeAt: input.changeTimeAt ?? resolveChangeTime,
      });
      if (leg === null) {
        unreached.push(start);
        continue;
      }
      const measured = assessChange({
        firstLeg: arrivingOn(record, from, via, firstLeg.scheduledDeparture, booked as string, leg.train.arrived),
        from,
        via,
        to,
        timetable: input.timetable.filter((slot) => kept(slot.tocCode)),
        onward: input.onward.filter((train) => kept(train.tocCode)),
        changeTimeFor: input.changeTimeFor,
        arrivedOnToc: leg.tocCode,
      });
      if (measured === null) continue;
      options.push({
        leg,
        scored: scoreChange(input, record, firstLeg, { ...measured, replacement: leg }),
      });
    }

    const [likeliest] = options;
    if (likeliest !== undefined) {
      const reported =
        !likeliest.scored.looksClaimable
          ? (options.find((option) => option.scored.looksClaimable) ?? likeliest)
          : likeliest;
      const other = options.find((option) => option !== reported);
      const notes = [...reported.scored.notes];
      if (other !== undefined && other.scored.delayMinutes !== null) {
        const otherLateness = describeLateness(other.scored.delayMinutes);
        notes.push(
          other.leg.reason === 'carried-past'
            ? `If you could not get off before ${via} and were carried on to ` +
                `${other.leg.station}, you would have reached ${to} ${otherLateness}` +
                (other.scored.looksClaimable ? '.' : ' - also inside the threshold.')
            : `If the change of plan was announced in time for you to get off at ` +
                `${other.leg.station} instead, you would have reached ${to} ${otherLateness} - ` +
                'inside the threshold. Which applies depends on whether you could get off there.',
        );
      }
      if (leftOutNames.length > 0) notes.push(leftOutNote(leftOutNames, via, to));
      return { ...reported.scored, notes };
    }
  }

  // Still nothing to judge the connection on.
  if (change === null) {
    const notes = [...firstLeg.notes];
    for (const start of unreached) {
      notes.push(
        `No train from ${start.station} to ${via} was recorded leaving within ` +
          `90 minutes of ${displayClockTime(start.readyAt)}.`,
      );
    }
    if (record !== null && firstLeg.outcome !== 'service-not-found') {
      notes.push(
        `This train did not get you to ${via}, so the connection there to ${to} ` +
          'could not be assessed. Your delay depends on how you completed the journey.',
      );
    }
    return { ...firstLeg, to, via, notes };
  }

  const scored = scoreChange(input, record as ServiceRecord, firstLeg, change);
  if (leftOutNames.length === 0) return scored;
  return { ...scored, notes: [...scored.notes, leftOutNote(leftOutNames, via, to)] };
}

function leftOutNote(names: readonly string[], via: string, to: string): string {
  return (
    `${names.join(' and ')} trains from ${via} to ${to} are left out of this check. ` +
    'If one of those was your connection or the train you took on, the figures here ' +
    'will not match your journey.'
  );
}

/**
 * The first train as it would have been had it reached the change station when
 * the replacement did: the same booked times, the replacement's arrival.
 */
function arrivingOn(
  record: ServiceRecord,
  from: string,
  via: string,
  scheduledDeparture: string | null,
  scheduledArrival: string,
  actualArrival: string,
): ServiceRecord {
  const blank = { actualDeparture: null, actualArrival: null, lateCancReason: null };
  return {
    ...record,
    calls: [
      { ...blank, location: from, scheduledDeparture, scheduledArrival: null },
      { ...blank, location: via, scheduledDeparture: null, scheduledArrival, actualArrival },
    ],
  };
}

/** What happened to the first train, and the train taken instead. */
function replacementNotes(
  replacement: ReplacementLeg,
  firstLeg: JourneyAssessment,
  via: string,
): readonly string[] {
  const notes: string[] = [];
  const { train } = replacement;

  if (replacement.reason === 'cancelled' || replacement.reason === 'skipped-origin') {
    notes.push(
      replacement.reason === 'cancelled'
        ? 'No departure was recorded for this train, which usually means it was cancelled.'
        : `This train was recorded before and after ${replacement.station} but not at ` +
            `${replacement.station}, which usually means it did not stop there and could ` +
            'not be boarded.',
    );
    notes.push(...reasonCodeNotes(firstLeg.reasonCode));
    notes.push(
      `The first train you could have caught instead left ${replacement.station} at ` +
        `${displayClockTime(train.departed)}, ${train.waitMinutes} ` +
        `${train.waitMinutes === 1 ? 'minute' : 'minutes'} after yours was due to leave, ` +
        `and reached ${via} at ${displayClockTime(train.arrived)}.`,
    );
  } else {
    notes.push(
      replacement.reason === 'carried-past'
        ? `This train ran past ${via} without calling there. It was next recorded at ` +
            `${replacement.station} at ${displayClockTime(replacement.readyAt)}.`
        : `This train ran but never reached ${via}. It was last recorded at ` +
            `${replacement.station} at ${displayClockTime(replacement.readyAt)}.`,
    );
    notes.push(...reasonCodeNotes(firstLeg.reasonCode));
    notes.push(
      `The first train ${replacement.reason === 'carried-past' ? 'back' : 'you could have caught'} ` +
        `from there left ${replacement.station} at ` +
        `${displayClockTime(train.departed)}, ${articleFor(train.waitMinutes)} ` +
        `${train.waitMinutes}-minute wait allowing ` +
        `${changeAllowance(train.changeMinutes, train.changeTimeFromTimetable)}, and reached ` +
        `${via} at ${displayClockTime(train.arrived)}.`,
    );
    if (train.leftInsideChangeTime !== null) {
      notes.push(
        `A train also left at ${displayClockTime(train.leftInsideChangeTime)}, too soon ` +
          'after you were set down to count as a connection. If you did catch it, claim on ' +
          'that train instead.',
      );
    }
  }
  return notes;
}

function scoreChange(
  input: ClassifyChangeInput,
  record: ServiceRecord,
  firstLeg: JourneyAssessment,
  change: ChangeAssessment,
): JourneyAssessment {
  const { from, via, to, date } = input;
  const notes: string[] = [];

  const threshold = resolveThreshold(change.responsibleTocCode, input.thresholdMinutes);
  notes.push(...thresholdNotes(threshold));

  const shared = {
    date: firstLeg.date,
    from,
    to,
    scheduledDeparture: firstLeg.scheduledDeparture,
    actualDeparture: firstLeg.actualDeparture,
    via,
    lastRecordedCall: null,
    onwardConnection: null,
    carriedPast: null,
    change,
    rid: record.rid,
    tocCode: change.responsibleTocCode,
    operator: threshold.operator,
    thresholdMinutes: threshold.minutes,
    thresholdConfirmed: threshold.confirmed,
    reasonCode: firstLeg.reasonCode,
    claimWindow: firstLeg.claimWindow,
  } as const;

  const { planned, caught, replacement } = change;
  if (replacement !== null) notes.push(...replacementNotes(replacement, firstLeg, via));
  const firstName = operatorName(change.firstTocCode);
  const arrivedAtVia =
    `${replacement === null ? 'This' : 'That'} train reached ${via} at ` +
    displayClockTime(change.actualArrivalAtVia);

  if (planned === null) {
    notes.push(
      `No train from ${via} to ${to} was found in the timetable within 90 minutes of ` +
        `this train's arrival there, so the journey could not be scored. Worth ` +
        'checking yourself.',
    );
    const holiday = bankHolidayNote(date);
    if (holiday !== null) notes.push(holiday);
    return {
      ...shared,
      scheduledArrival: null,
      actualArrival: null,
      delayMinutes: null,
      outcome: 'service-not-found',
      evidence: 'none',
      looksClaimable: false,
      needsManualCheck: true,
      notes,
    };
  }

  const plannedName = operatorName(planned.tocCode);
  notes.push(
    `Planned: into ${via} at ${displayClockTime(change.plannedArrivalAtVia)}, then the ` +
      `${displayClockTime(planned.scheduledDeparture)} ${plannedName} train to ${to}, due at ` +
      `${displayClockTime(planned.scheduledArrival)} - allowing ` +
      `${changeAllowance(planned.changeMinutes, planned.changeTimeFromTimetable)}.`,
  );

  // Why the plan did not hold, where it did not.
  switch (change.cause) {
    case 'first-train-late':
      notes.push(
        `${arrivedAtVia}, ${describeLateness(minutesBehind(change))} - too late for ` +
          `the ${displayClockTime(planned.scheduledDeparture)}` +
          (planned.actualDeparture === null
            ? '.'
            : `, which left at ${displayClockTime(planned.actualDeparture)}.`),
      );
      break;
    case 'connection-did-not-run':
      notes.push(
        `${arrivedAtVia}, in time. The ${displayClockTime(planned.scheduledDeparture)} to ` +
          `${to} has no recorded departure, which usually means it was cancelled.`,
      );
      break;
    case 'connection-not-in-data':
      notes.push(
        `${arrivedAtVia}, in time. The ${displayClockTime(planned.scheduledDeparture)} to ` +
          `${to} is not in the performance data for this day - it may have been ` +
          'cancelled, or the data may simply be missing it.',
      );
      break;
    case 'connection-did-not-reach':
      notes.push(
        `${arrivedAtVia}, in time. The ${displayClockTime(planned.scheduledDeparture)} to ` +
          `${to} left` +
          (planned.actualDeparture === null
            ? ''
            : ` at ${displayClockTime(planned.actualDeparture)}`) +
          ` but did not reach ${to} - it stopped short or ran past without calling.`,
      );
      break;
    case 'connection-arrival-not-recorded':
      notes.push(
        `${arrivedAtVia}, in time. The ${displayClockTime(planned.scheduledDeparture)} to ` +
          `${to} left` +
          (planned.actualDeparture === null
            ? ''
            : ` at ${displayClockTime(planned.actualDeparture)}`) +
          ` but has no recorded arrival at ${to}, so when it got there is not known.`,
      );
      break;
    case 'connection-late':
    case null:
      break;
  }

  if (caught === null) {
    notes.push(
      `No train onward from ${via} to ${to} was recorded within 90 minutes, so the ` +
        'delay at the destination could not be worked out. Work it out from when you ' +
        'actually arrived.',
    );
    notes.push(...missingNote(change));
    return {
      ...shared,
      scheduledArrival: planned.scheduledArrival,
      actualArrival: null,
      delayMinutes: null,
      outcome: 'arrival-not-recorded',
      evidence: 'inferred-from-absent-times',
      looksClaimable: true,
      needsManualCheck: true,
      notes,
    };
  }

  if (change.madePlannedConnection) {
    notes.push(
      `You would have made that connection. It reached ${to} at ` +
        `${displayClockTime(caught.arrived)}.`,
    );
  } else {
    notes.push(
      `The first train that could have carried you on left ${via} at ` +
        `${displayClockTime(caught.departed)}, ${articleFor(caught.waitMinutes)} ` +
        `${caught.waitMinutes}-minute wait, and reached ${to} at ` +
        `${displayClockTime(caught.arrived)}.`,
    );
    if (caught.leftInsideChangeTime !== null) {
      notes.push(
        `A train also left at ${displayClockTime(caught.leftInsideChangeTime)}, too soon ` +
          'after you arrived to count as a connection. If you did catch it, claim on ' +
          'that train instead.',
      );
    }
    notes.push(
      'Delay Repay claims are checked against the first train you could have ' +
        'caught, so that is the train this is measured to. If you could not board ' +
        'it - for example because it was too full - say so when you claim.',
    );
  }

  const delayMinutes = caught.totalDelayMinutes;
  const bestCase = change.bestCaseDelayMinutes ?? delayMinutes;
  // Over the threshold on the trains recorded, but not if the gaps in the data
  // ran to time. That is a question the data cannot answer.
  const unconfirmed = delayMinutes >= threshold.minutes && bestCase < threshold.minutes;
  const looksClaimable = delayMinutes >= threshold.minutes && !unconfirmed;

  if (looksClaimable) {
    const responsibleName = operatorName(change.responsibleTocCode);
    notes.push(
      change.cause === 'first-train-late'
        ? `The delay started with the ${firstName} train from ${from}, so it is ` +
            `${responsibleName}'s to answer for, even though the rest of the journey ` +
            'was on another train.'
        : `Your first train got you to ${via} in time for the connection, so the delay ` +
            `happened on the connection, run by ${responsibleName}.`,
    );
  }

  // Other trains that left in time but are known not to have got there.
  const notReaching = change.didNotReach.filter(
    (time) => !(change.cause === 'connection-did-not-reach' && time === planned.scheduledDeparture),
  );
  if (notReaching.length > 0) {
    const one = notReaching.length === 1;
    notes.push(
      `${one ? 'The train' : 'Trains'} from ${via} at ${notReaching.map(displayClockTime).join(', ')} ` +
        `left but did not reach ${to}, so ${one ? 'it is' : 'they are'} not counted as a way on.`,
    );
  }

  const missing = missingNote(change);
  notes.push(...missing);
  if (bestCase < delayMinutes) {
    notes.push(
      `If those trains ran to time, you could have been in ` +
        `${describeLateness(bestCase)} instead of ${describeLateness(delayMinutes)}` +
        (unconfirmed ? `, which is inside the ${threshold.minutes}-minute threshold.` : '.'),
    );
  }

  const clockChange = spansClockChange(date, [
    parseClockTime(firstLeg.scheduledDeparture),
    parseClockTime(planned.scheduledArrival),
  ]);
  if (clockChange !== null) {
    notes.push(
      `The clocks changed on ${date}, so the recorded times for this journey may ` +
        'be an hour out either way. Check this one yourself.',
    );
  }

  // A replacement rests on an inferred cancellation and an assumed train.
  const assumedConnection = !change.madePlannedConnection || replacement !== null;
  return {
    ...shared,
    scheduledArrival: planned.scheduledArrival,
    actualArrival: caught.arrived,
    delayMinutes,
    outcome: unconfirmed ? 'unconfirmed' : looksClaimable ? 'delayed' : 'within-threshold',
    evidence: assumedConnection ? 'assumed-onward-connection' : 'recorded-times',
    looksClaimable,
    // A missed connection rests on which train was caught, and missing records
    // mean an earlier train may have run. Neither is something to assert alone.
    needsManualCheck:
      assumedConnection || missing.length > 0 || unconfirmed || clockChange !== null,
    notes,
  };
}

/** How late the first train was into the change station. */
function minutesBehind(change: ChangeAssessment): number {
  return minutesLate(
    parseClockTime(change.plannedArrivalAtVia) as number,
    parseClockTime(change.actualArrivalAtVia) as number,
  );
}

function missingNote(change: ChangeAssessment): readonly string[] {
  // The planned train already has its own sentence when it is the one missing.
  const planned = change.planned?.scheduledDeparture;
  const missing = change.missingFromData.filter(
    (time) => !(change.cause === 'connection-not-in-data' && time === planned),
  );
  const unrecorded = change.arrivalNotRecorded.filter(
    (time) => !(change.cause === 'connection-arrival-not-recorded' && time === planned),
  );

  const notes: string[] = [];
  if (missing.length > 0) {
    const one = missing.length === 1;
    notes.push(
      `The performance data has no record on this day of ${one ? 'the train' : 'trains'} ` +
        `timetabled from ${change.via} at ${missing.map(displayClockTime).join(', ')}, which ` +
        `${one ? 'runs' : 'run'} on other days. If one ran, it may have been an earlier ` +
        'way on. Check this one yourself.',
    );
  }
  if (unrecorded.length > 0) {
    const one = unrecorded.length === 1;
    notes.push(
      `${one ? 'The train' : 'Trains'} timetabled from ${change.via} at ` +
        `${unrecorded.map(displayClockTime).join(', ')} left but ${one ? 'has' : 'have'} no ` +
        `recorded arrival at the destination, so ${one ? 'it' : 'one'} may have been an ` +
        'earlier way on. Check this one yourself.',
    );
  }
  return notes;
}
