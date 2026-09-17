import type { ClaimWindow } from './window.js';
import type { Operator } from './operators.js';
import type { OnwardConnection } from './onward.js';
import type { ChangeAssessment } from './connection.js';

/** One call at one station, normalised from an HSP `serviceDetails` location. */
export interface ServiceCall {
  /** CRS code, e.g. "BTN". */
  readonly location: string;
  /** Public timetable departure, "HHMM", or null where none applies. */
  readonly scheduledDeparture: string | null;
  /** Public timetable arrival, "HHMM", or null where none applies. */
  readonly scheduledArrival: string | null;
  /** Recorded departure, "HHMM". Null means not recorded, which is not the
   *  same as "on time" - see the cancellation caveat in CLAUDE.md. */
  readonly actualDeparture: string | null;
  /** Recorded arrival, "HHMM". Null means not recorded. */
  readonly actualArrival: string | null;
  /** HSP late/cancellation reason code. 574 is ambiguous between the two. */
  readonly lateCancReason: string | null;
}

/** One service on one day, normalised from an HSP `serviceDetails` response. */
export interface ServiceRecord {
  readonly rid: string;
  /** YYYY-MM-DD. */
  readonly date: string;
  readonly tocCode: string | null;
  readonly calls: readonly ServiceCall[];
}

export type JourneyOutcome =
  /** Arrived, and inside the operator's threshold. */
  | 'within-threshold'
  /**
   * A journey with a change whose delay the data cannot settle: over the
   * threshold on the trains recorded, inside it if trains missing from the data
   * ran to time. Neither claimable nor fine - the user has to check.
   */
  | 'unconfirmed'
  /** Arrived late by at least the threshold. */
  | 'delayed'
  /**
   * No time recorded anywhere from the origin on - not there, not at any stop
   * after it. Treated as cancelled, by decision: HSP never says "cancelled",
   * and a train that ran leaves times behind.
   */
  | 'cancelled'
  /** Scheduled to arrive, no arrival recorded. Often a cancellation. */
  | 'arrival-not-recorded'
  /**
   * The service demonstrably ran past the origin, but never called at the
   * destination - terminated short, diverted, or run fast through it.
   *
   * Distinct from 'arrival-not-recorded' because the record says something
   * quite different: not "we cannot tell what happened to this train" but "this
   * train ran, we can see how late it was, and it did not take you where you
   * were going". Collapsing the two throws away the evidence for the stronger
   * claim of the pair.
   */
  | 'did-not-call'
  /**
   * The service ran through the origin without calling there - recorded before
   * it and after it, but not at it - so it could not be boarded.
   */
  | 'skipped-origin'
  /** No matching service in HSP at all. */
  | 'service-not-found'
  /** Too recent for the data to be in yet. Nothing to conclude either way. */
  | 'awaiting-data';

/**
 * The last place a service was actually recorded before it stopped serving the
 * journey. Only meaningful on a 'did-not-call' outcome.
 *
 * `minutesLate` is how late it was *there*, at a station the user was not
 * travelling to. It is deliberately kept out of `delayMinutes`: the delay that
 * decides a claim is the one at the destination, and this is not it.
 */
export interface LastRecordedCall {
  /** CRS code of the last station with a recorded time. */
  readonly location: string;
  /** "HHMM" recorded there. */
  readonly time: string;
  /** Minutes late at that station, or null if it could not be measured. */
  readonly minutesLate: number | null;
}

/**
 * Where a service that ran past the destination without calling was next
 * recorded, and the train back from there. The passenger may have been carried
 * on to it if the change of plan came too late to get off before.
 */
export interface CarriedPast {
  /** The first station after the destination with a recorded time. */
  readonly call: LastRecordedCall;
  /** The first train back from `call.location` to the destination, if one was found. */
  readonly connection: OnwardConnection | null;
  /**
   * True when the result is measured on this, rather than on getting off before
   * the destination - because only this one is over the threshold, or because
   * there was nowhere before the destination to get off.
   */
  readonly reported: boolean;
}

export type Evidence =
  /** Both scheduled and actual times were present. */
  | 'recorded-times'
  /** Conclusion drawn from times HSP did not record. */
  | 'inferred-from-absent-times'
  /**
   * Measured against the connection the user is assumed to have taken, rather
   * than against a time recorded for their own journey.
   */
  | 'assumed-onward-connection'
  /** Nothing to go on. */
  | 'none';

export interface JourneyAssessment {
  /** YYYY-MM-DD. */
  readonly date: string;
  /** Origin CRS. */
  readonly from: string;
  /** Destination CRS. */
  readonly to: string;
  /** Where the journey changes trains, or null for a single train. */
  readonly via: string | null;

  readonly scheduledDeparture: string | null;
  readonly scheduledArrival: string | null;
  readonly actualDeparture: string | null;
  readonly actualArrival: string | null;

  /** Minutes late at the destination. Null when no arrival was recorded. */
  readonly delayMinutes: number | null;

  /**
   * Where the service was last seen, when it never reached the destination.
   * Null on every other outcome.
   */
  readonly lastRecordedCall: LastRecordedCall | null;

  /**
   * The train assumed to have carried them the rest of the way, when their own
   * stopped short. Null whenever no assumption was made or none was found.
   */
  readonly onwardConnection: OnwardConnection | null;

  /**
   * Set when the service ran past the destination without calling there and
   * was recorded after it. Null otherwise.
   */
  readonly carriedPast: CarriedPast | null;

  /**
   * The change, on a journey that has one. Null on a single-train journey.
   *
   * When set, the times and delay above describe the whole journey: departure
   * on the first train, planned and actual arrival at the final destination.
   */
  readonly change: ChangeAssessment | null;

  readonly outcome: JourneyOutcome;
  readonly evidence: Evidence;

  /**
   * Whether this is worth putting in front of the user as a candidate.
   * Never an assertion that a claim is valid - the user checks.
   */
  readonly looksClaimable: boolean;

  /**
   * True when the tool cannot stand behind a negative result: the service was
   * invisible to HSP, or the data is ambiguous. Surfaced rather than dropped,
   * because silence here reads as "your train was fine".
   */
  readonly needsManualCheck: boolean;

  readonly rid: string | null;
  readonly tocCode: string | null;
  readonly operator: Operator | null;
  /** Threshold this journey was scored against, in minutes. */
  readonly thresholdMinutes: number;
  /** False when the threshold was a fallback rather than the operator's own. */
  readonly thresholdConfirmed: boolean;

  readonly reasonCode: string | null;
  readonly claimWindow: ClaimWindow;
  /** Caveats attached to this specific result, in the order they were found. */
  readonly notes: readonly string[];
}
