/**
 * A journey with one change: whether the connection was made, the delay at the
 * final destination, and which operator it belongs to.
 *
 * The rules, as decided and recorded in CLAUDE.md ("Journeys with a change"):
 *
 * - The planned connection is the first timetabled train, of any operator,
 *   leaving the change station at least the timetable's change time after the
 *   first train was due there. That is what a journey planner would offer, and
 *   it sets the planned arrival - the time Delay Repay measures against.
 * - What actually happened is measured to the first train, of any operator,
 *   that left at least the change time after the first train really arrived.
 *   That is pickOnwardConnection, the same rule used when a train stops short.
 * - The operator responsible is the one whose delay first broke the plan
 *   ("claim with the operator who was responsible for the original delay",
 *   Thameslink's Delay Repay FAQ). If the first train got in too late for the
 *   planned connection, that is the first train's operator. If it got in with
 *   time to spare, the delay happened on the connection, and belongs to the
 *   operator of the planned connecting train.
 *
 * HSP's records are not complete for every operator. London Overground
 * services in particular are missing on some days while running on others, and
 * some that are present have no recorded arrival at the destination. Checked on
 * Clapham Junction to Shepherd's Bush over 21 weekdays: Southern's 07:39 was
 * recorded on all 21, each Overground departure on between 4 and 10.
 *
 * A gap can only make the recorded delay look worse than it was - the missing
 * train might have been the earlier way on. So two figures are worked out:
 * the delay on the trains recorded, and the best case, as if every gap had run
 * to time. Where the threshold falls between them, the data cannot settle the
 * question, and classifyChange.ts says so rather than choosing. The timetable
 * itself is taken from every day in the scan range, so a train missing on the
 * day is still known to have been planned.
 *
 * Pure. No network, no clock.
 */

import { formatClockTime, minutesLate, parseClockTime } from './time.js';
import {
  pickOnwardConnection,
  LOOKBACK_MINUTES,
  MAX_WAIT_MINUTES,
  type OnwardConnection,
} from './onward.js';
import type { ResolvedChangeTime } from './changeTimes.js';
import type { ServiceCall, ServiceRecord } from './types.js';

/** A train that runs from the change station to the destination in the timetable. */
export interface TimetabledConnection {
  readonly tocCode: string | null;
  /** Public timetable departure from the change station, "HHMM". */
  readonly scheduledDeparture: string;
  /** Public timetable arrival at the destination, "HHMM". */
  readonly scheduledArrival: string;
}

export interface PlannedConnection extends TimetabledConnection {
  /** The change time the plan allowed, in minutes. */
  readonly changeMinutes: number;
  readonly changeTimeFromTimetable: boolean;
  /**
   * Recorded departure of this train on the day, "HHMM". Null when it has a
   * record but no departure (usually cancelled) or no record at all.
   */
  readonly actualDeparture: string | null;
  /** False when the performance data has no record of this train on the day. */
  readonly inData: boolean;
}

export type ChangeCause =
  /** The first train got in too late to make the planned connection. */
  | 'first-train-late'
  /** The planned connecting train has a record but never departed. */
  | 'connection-did-not-run'
  /** The planned connecting train is not in the data for the day at all. */
  | 'connection-not-in-data'
  /** The planned connecting train left, but has no recorded arrival at the destination. */
  | 'connection-arrival-not-recorded'
  /**
   * The planned connecting train left, and was recorded running elsewhere, but
   * never reached the destination - it stopped short or ran past.
   */
  | 'connection-did-not-reach'
  /** The connection was there to be caught; any delay happened on it. */
  | 'connection-late';

/**
 * How someone reached the change station when their first train did not take
 * them there - the train they are measured as having caught instead.
 */
export interface ReplacementLeg {
  /**
   * Why the first train did not get them to the change station: it never ran,
   * it ran through the origin without stopping, it stopped short, or it ran
   * past the change station without calling.
   */
  readonly reason: 'cancelled' | 'skipped-origin' | 'stopped-short' | 'carried-past';
  /**
   * Where they were left: the origin if it never ran or never stopped there, the
   * last station it was recorded at if it stopped short, the next station it
   * was recorded at if it ran past.
   */
  readonly station: string;
  /** From when they could leave that station, "HHMM". */
  readonly readyAt: string;
  /** Operator of the replacement train. */
  readonly tocCode: string | null;
  /** The first train that actually left `station` for the change station. */
  readonly train: OnwardConnection;
}

export interface ChangeAssessment {
  /** The change station. */
  readonly via: string;
  /** Operator of the first train. */
  readonly firstTocCode: string | null;
  /** When the first train was due at the change station, "HHMM". */
  readonly plannedArrivalAtVia: string;
  /** When it got there, "HHMM". */
  readonly actualArrivalAtVia: string;
  /** Null when the timetable has no train onward within MAX_WAIT_MINUTES. */
  readonly planned: PlannedConnection | null;
  /** The first train that could have carried them on. Null when none was recorded. */
  readonly caught: OnwardConnection | null;
  /** True when the train caught is the planned one. */
  readonly madePlannedConnection: boolean;
  /** Minutes late at the destination against the planned arrival. */
  readonly delayMinutes: number | null;
  readonly cause: ChangeCause | null;
  /** The operator whose delay first broke the plan. */
  readonly responsibleTocCode: string | null;
  /**
   * Scheduled departures, "HHMM", of trains that ran from the change station
   * at this time on other days but have no record on this one. Any of them
   * could have been an earlier way on.
   */
  readonly missingFromData: readonly string[];
  /**
   * Scheduled departures, "HHMM", of trains that left the change station in
   * that same window but have no recorded arrival at the destination.
   */
  readonly arrivalNotRecorded: readonly string[];
  /**
   * Scheduled departures, "HHMM", of trains that left the change station in
   * that window and were recorded further on, but never reached the destination.
   * Known not to be a way on, so never counted as a gap in the data.
   */
  readonly didNotReach: readonly string[];
  /**
   * The delay at the destination had every gap above run to time: missing
   * trains as timetabled, unrecorded arrivals as late as their departure.
   * Equal to `delayMinutes` when there are no gaps. Never more than it.
   */
  readonly bestCaseDelayMinutes: number | null;
  /**
   * Set when the first train never reached the change station and the journey
   * is measured on the train that could have carried them there instead. Null
   * when the first train got there itself.
   */
  readonly replacement: ReplacementLeg | null;
}

export interface AssessChangeInput {
  /** The user's first train. Must call at `from` and then `via`. */
  readonly firstLeg: ServiceRecord;
  readonly from: string;
  readonly via: string;
  readonly to: string;
  /** Every train seen running from `via` to `to` across the scan range. */
  readonly timetable: readonly TimetabledConnection[];
  /** This day's records of trains from `via` to `to`. */
  readonly onward: readonly ServiceRecord[];
  /** The change time at `via` from one operator's train to another's. */
  readonly changeTimeFor: (
    arrivingToc: string | null,
    departingToc: string | null,
  ) => ResolvedChangeTime;
  /**
   * The operator of the train that actually arrived at `via`, when that was not
   * `firstLeg` - a replacement for a first train that never got there. The plan
   * still uses `firstLeg`'s operator; the change actually made uses this one.
   */
  readonly arrivedOnToc?: string | null;
}

function sameStation(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

function sameToc(a: string | null, b: string | null): boolean {
  return (a ?? '').trim().toUpperCase() === (b ?? '').trim().toUpperCase();
}

/** The call at `from`, and the first call at `to` after it. */
function legCalls(
  record: ServiceRecord,
  from: string,
  to: string,
): { readonly departure: ServiceCall; readonly arrival: ServiceCall } | null {
  const index = record.calls.findIndex((call) => sameStation(call.location, from));
  const departure = record.calls[index];
  if (index === -1 || !departure) return null;
  const arrival = record.calls.slice(index + 1).find((call) => sameStation(call.location, to));
  return arrival ? { departure, arrival } : null;
}

/**
 * True when a train left `via`, has no arrival at `to`, and yet was recorded
 * somewhere after leaving - so it ran, and did not get there. As opposed to a
 * train whose arrival is simply missing from the data.
 */
function ranWithoutReaching(record: ServiceRecord, via: string, to: string): boolean {
  const calls = legCalls(record, via, to);
  if (calls === null || calls.departure.actualDeparture === null) return false;
  if (calls.arrival.actualArrival !== null) return false;
  const start = record.calls.indexOf(calls.departure);
  return (
    calls.arrival.actualDeparture !== null ||
    record.calls
      .slice(start + 1)
      .some(
        (call) =>
          call !== calls.arrival && (call.actualArrival !== null || call.actualDeparture !== null),
      )
  );
}

/** This day's record of a timetabled train, matched on operator and times. */
function findRecord(
  onward: readonly ServiceRecord[],
  slot: TimetabledConnection,
  via: string,
  to: string,
): ServiceRecord | null {
  return (
    onward.find((record) => {
      if (!sameToc(record.tocCode, slot.tocCode)) return false;
      const calls = legCalls(record, via, to);
      return (
        calls !== null &&
        calls.departure.scheduledDeparture === slot.scheduledDeparture &&
        calls.arrival.scheduledArrival === slot.scheduledArrival
      );
    }) ?? null
  );
}

/**
 * The first train through the change that the first train did not reach, or
 * null when the first train has no recorded arrival at the change station -
 * that journey stopped short, and belongs to the single-train rules.
 */
export function assessChange(input: AssessChangeInput): ChangeAssessment | null {
  const { firstLeg, from, via, to } = input;
  const arrivedOn = input.arrivedOnToc === undefined ? firstLeg.tocCode : input.arrivedOnToc;

  const first = legCalls(firstLeg, from, via);
  const plannedArrivalAtVia = first?.arrival.scheduledArrival ?? null;
  const actualArrivalAtVia = first?.arrival.actualArrival ?? null;
  const plannedAt = parseClockTime(plannedArrivalAtVia);
  const actualAt = parseClockTime(actualArrivalAtVia);
  if (plannedAt === null || actualAt === null) return null;

  const base = {
    via,
    firstTocCode: firstLeg.tocCode,
    plannedArrivalAtVia: plannedArrivalAtVia as string,
    actualArrivalAtVia: actualArrivalAtVia as string,
  };

  // The plan: the first timetabled train leaving at least the change time
  // after the first train was due in.
  // Earliest departure first; between two leaving together, the one due first.
  const options = input.timetable
    .map((slot) => {
      const departs = parseClockTime(slot.scheduledDeparture);
      const arrives = parseClockTime(slot.scheduledArrival);
      if (departs === null || arrives === null) return null;
      const change = input.changeTimeFor(firstLeg.tocCode, slot.tocCode);
      const wait = minutesLate(plannedAt, departs);
      if (wait < change.minutes || wait > MAX_WAIT_MINUTES) return null;
      return { slot, change, wait, journey: minutesLate(departs, arrives) };
    })
    .filter((option) => option !== null)
    .sort((a, b) => a.wait - b.wait || a.wait + a.journey - (b.wait + b.journey));

  const chosen = options[0];
  let planned: PlannedConnection | null = null;
  if (chosen) {
    const record = findRecord(input.onward, chosen.slot, via, to);
    planned = {
      ...chosen.slot,
      changeMinutes: chosen.change.minutes,
      changeTimeFromTimetable: chosen.change.fromTimetable,
      actualDeparture:
        record === null ? null : (legCalls(record, via, to)?.departure.actualDeparture ?? null),
      inData: record !== null,
    };
  }

  if (planned === null) {
    return {
      ...base,
      planned: null,
      caught: null,
      madePlannedConnection: false,
      delayMinutes: null,
      cause: null,
      responsibleTocCode: firstLeg.tocCode,
      missingFromData: [],
      arrivalNotRecorded: [],
      didNotReach: [],
      bestCaseDelayMinutes: null,
      replacement: null,
    };
  }

  const caught = pickOnwardConnection({
    candidates: input.onward,
    from: via,
    to,
    setDownAt: actualArrivalAtVia as string,
    bookedArrival: planned.scheduledArrival,
    changeTimeFor: (departingToc) => input.changeTimeFor(arrivedOn, departingToc),
  });

  const plannedRecord = findRecord(input.onward, planned, via, to);
  const madePlannedConnection =
    caught !== null && plannedRecord !== null && caught.rid === plannedRecord.rid;
  const plannedArrivalRecorded =
    plannedRecord !== null && legCalls(plannedRecord, via, to)?.arrival.actualArrival != null;

  // Did the first train break the plan? Measured against when the connection
  // really left, if it did, and otherwise against when it was due to.
  const connectionLeft =
    parseClockTime(planned.actualDeparture) ?? (parseClockTime(planned.scheduledDeparture) as number);
  const firstTrainBrokePlan = minutesLate(actualAt, connectionLeft) < planned.changeMinutes;

  let cause: ChangeCause | null;
  let responsibleTocCode: string | null;
  if (firstTrainBrokePlan) {
    cause = 'first-train-late';
    responsibleTocCode = firstLeg.tocCode;
  } else {
    responsibleTocCode = planned.tocCode;
    cause = !planned.inData
      ? 'connection-not-in-data'
      : planned.actualDeparture === null
        ? 'connection-did-not-run'
        : plannedRecord !== null && ranWithoutReaching(plannedRecord, via, to)
          ? 'connection-did-not-reach'
          : !plannedArrivalRecorded && !madePlannedConnection
            ? 'connection-arrival-not-recorded'
            : 'connection-late';
  }

  const delayMinutes = caught?.totalDelayMinutes ?? null;
  // Nothing went wrong worth naming: the connection was made and nobody was late.
  if (cause === 'connection-late' && (delayMinutes === null || delayMinutes <= 0)) cause = null;

  // Trains that normally run in the window someone could have boarded in, but
  // have no record today. The window opens early because a train booked before
  // the arrival may have been running late, and closes at the train taken.
  const windowOpens = actualAt - LOOKBACK_MINUTES;
  const windowCloses = parseClockTime(caught?.departed) ?? actualAt + MAX_WAIT_MINUTES;
  const inWindow = (time: string | null): boolean => {
    const at = parseClockTime(time);
    return at !== null && minutesLate(windowOpens, at) >= 0 && minutesLate(at, windowCloses) > 0;
  };

  const missingSlots = input.timetable.filter(
    (slot) =>
      inWindow(slot.scheduledDeparture) && findRecord(input.onward, slot, via, to) === null,
  );

  const leftInWindowWithoutArriving = input.onward.filter((record) => {
    const calls = legCalls(record, via, to);
    return (
      calls !== null &&
      calls.departure.actualDeparture !== null &&
      calls.arrival.actualArrival === null &&
      inWindow(calls.departure.actualDeparture)
    );
  });
  // A train known to have run without getting there is not a gap to fill.
  const didNotReach = leftInWindowWithoutArriving.filter((record) =>
    ranWithoutReaching(record, via, to),
  );
  const unrecordedArrivals = leftInWindowWithoutArriving.filter(
    (record) => !didNotReach.includes(record),
  );

  // The best case: every gap filled as if it had run to time.
  let bestCaseDelayMinutes = delayMinutes;
  if (missingSlots.length > 0 || unrecordedArrivals.length > 0) {
    const filled = input.onward.map((record) =>
      unrecordedArrivals.includes(record) ? arrivingAsLateAsItLeft(record, via, to) : record,
    );
    const imagined = missingSlots.map((slot) => runningToTime(slot, via, to));
    const best = pickOnwardConnection({
      candidates: [...filled, ...imagined],
      from: via,
      to,
      setDownAt: actualArrivalAtVia as string,
      bookedArrival: planned.scheduledArrival,
      changeTimeFor: (departingToc) => input.changeTimeFor(arrivedOn, departingToc),
    });
    bestCaseDelayMinutes = best?.totalDelayMinutes ?? delayMinutes;
  }

  const times = (values: readonly (string | null)[]) =>
    [...new Set(values.filter((value): value is string => value !== null))].sort();

  return {
    ...base,
    planned,
    caught,
    madePlannedConnection,
    delayMinutes,
    cause,
    responsibleTocCode,
    missingFromData: times(missingSlots.map((slot) => slot.scheduledDeparture)),
    arrivalNotRecorded: times(
      unrecordedArrivals.map((record) => legCalls(record, via, to)?.departure.scheduledDeparture ?? null),
    ),
    didNotReach: times(
      didNotReach.map((record) => legCalls(record, via, to)?.departure.scheduledDeparture ?? null),
    ),
    bestCaseDelayMinutes,
    replacement: null,
  };
}

/** A timetabled train with no record, imagined as having run exactly to time. */
function runningToTime(slot: TimetabledConnection, via: string, to: string): ServiceRecord {
  const blank = { scheduledArrival: null, scheduledDeparture: null, lateCancReason: null };
  return {
    rid: `not-in-data:${slot.tocCode ?? ''}:${slot.scheduledDeparture}`,
    date: '',
    tocCode: slot.tocCode,
    calls: [
      { ...blank, location: via, scheduledDeparture: slot.scheduledDeparture, actualDeparture: slot.scheduledDeparture, actualArrival: null },
      { ...blank, location: to, scheduledArrival: slot.scheduledArrival, actualArrival: slot.scheduledArrival, actualDeparture: null },
    ],
  };
}

/** A train that left but has no recorded arrival, imagined as arriving as late as it left. */
function arrivingAsLateAsItLeft(record: ServiceRecord, via: string, to: string): ServiceRecord {
  const calls = legCalls(record, via, to);
  if (calls === null) return record;
  const scheduledDeparture = parseClockTime(calls.departure.scheduledDeparture);
  const actualDeparture = parseClockTime(calls.departure.actualDeparture);
  const scheduledArrival = parseClockTime(calls.arrival.scheduledArrival);
  if (scheduledDeparture === null || actualDeparture === null || scheduledArrival === null) return record;

  const lateness = Math.max(0, minutesLate(scheduledDeparture, actualDeparture));
  const arrival = formatClockTime(scheduledArrival + lateness);
  return {
    ...record,
    calls: record.calls.map((call) =>
      call === calls.arrival ? { ...call, actualArrival: arrival } : call,
    ),
  };
}
