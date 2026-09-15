import type { ClaimWindow } from './window.js';
import type { Operator } from './operators.js';

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
  /** Arrived late by at least the threshold. */
  | 'delayed'
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

export type Evidence =
  /** Both scheduled and actual times were present. */
  | 'recorded-times'
  /** Conclusion drawn from times HSP did not record. */
  | 'inferred-from-absent-times'
  /** Nothing to go on. */
  | 'none';

export interface JourneyAssessment {
  /** YYYY-MM-DD. */
  readonly date: string;
  /** Origin CRS. */
  readonly from: string;
  /** Destination CRS. */
  readonly to: string;

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
