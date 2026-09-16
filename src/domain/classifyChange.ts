/**
 * One honest answer about one journey with a change.
 *
 * The first train is judged by the single-train rules in classify.ts, as far as
 * the change station. If it never got there - cancelled, stopped short, not in
 * the data - that answer stands, because there is no connection to assess. If
 * it did, connection.ts works out the rest, and this file turns that into the
 * same JourneyAssessment every other result uses, scored against the threshold
 * of the operator responsible for the delay.
 *
 * Pure. No network, no clock.
 */

import { classifyJourney, thresholdNotes } from './classify.js';
import { assessChange, type AssessChangeInput, type ChangeAssessment } from './connection.js';
import { findOperator, resolveThreshold } from './operators.js';
import { spansClockChange } from './clockChange.js';
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

  const change =
    record === null
      ? null
      : assessChange({
          firstLeg: record,
          from,
          via,
          to,
          timetable: input.timetable,
          onward: input.onward,
          changeTimeFor: input.changeTimeFor,
        });

  // It never got to the change station, so there is no connection to judge.
  if (change === null) {
    const notes = [...firstLeg.notes];
    if (record !== null && firstLeg.outcome !== 'service-not-found') {
      notes.push(
        `This train did not get you to ${via}, so the connection there to ${to} ` +
          'could not be assessed. Your delay depends on how you completed the journey.',
      );
    }
    return { ...firstLeg, to, via, notes };
  }

  return scoreChange(input, record as ServiceRecord, firstLeg, change);
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
    change,
    rid: record.rid,
    tocCode: change.responsibleTocCode,
    operator: threshold.operator,
    thresholdMinutes: threshold.minutes,
    thresholdConfirmed: threshold.confirmed,
    reasonCode: firstLeg.reasonCode,
    claimWindow: firstLeg.claimWindow,
  } as const;

  const { planned, caught } = change;
  const firstName = operatorName(change.firstTocCode);
  const arrivedAtVia =
    `This train reached ${via} at ${displayClockTime(change.actualArrivalAtVia)}`;

  if (planned === null) {
    notes.push(
      `No train from ${via} to ${to} was found in the timetable within 90 minutes of ` +
        `this train's arrival there, so the journey could not be scored. Worth ` +
        'checking yourself.',
    );
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

  const assumedConnection = !change.madePlannedConnection;
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
