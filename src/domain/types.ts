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
  /** No matching service in HSP at all. */
  | 'service-not-found';

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
