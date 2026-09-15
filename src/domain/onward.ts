/**
 * What happened after a train stopped short of where the user was going.
 *
 * A service that terminates early does not end the journey - the passenger is
 * standing on a platform partway home, and their real delay is set by whatever
 * came next. HSP cannot see which train someone boarded, so this module applies
 * one stated rule instead: they took the next train that actually departed for
 * their destination.
 *
 * That rule is an assumption, and it is deliberately the *conservative* one.
 * Picking the earliest departure yields the earliest arrival the data allows,
 * so the delay it produces is a floor. If the user missed that connection their
 * delay was longer, never shorter - the error can only ever run in the
 * direction of under-claiming, and the copy says so.
 *
 * Pure, and separate from the fetching in scan.ts, because this arithmetic is
 * the part that has to be right.
 */

import { minutesLate, parseClockTime } from './time.js';
import type { ServiceRecord } from './types.js';

/**
 * How long after being set down we keep looking for a way onward.
 *
 * Past this, "the next train" stops being a reasonable account of what someone
 * did - they found a bus, a taxi, or gave up - and a guess would do more harm
 * than an honest gap.
 */
export const MAX_WAIT_MINUTES = 90;

/**
 * How far *before* the set-down time to start asking HSP for services.
 *
 * serviceMetrics filters on the timetabled departure, not the actual one. The
 * train someone actually caught may have been booked to leave before they were
 * even set down, and running late - on 2026-09-03 the connection out of
 * Haywards Heath was booked at 20:04 and left at 20:31. Starting the band at
 * the set-down time alone would miss exactly the delayed services most likely
 * to be involved.
 */
export const LOOKBACK_MINUTES = 30;

export interface OnwardConnection {
  readonly rid: string;
  /** Where the user was set down. */
  readonly from: string;
  /** Where they were going. */
  readonly to: string;
  /** Recorded departure from `from`, "HHMM". */
  readonly departed: string;
  /** Recorded arrival at `to`, "HHMM". */
  readonly arrived: string;
  /** Minutes spent waiting at `from`. */
  readonly waitMinutes: number;
  /** Minutes between the booked arrival at `to` and this actual arrival. */
  readonly totalDelayMinutes: number;
}

export interface PickOnwardInput {
  /** Services that might have carried them on, in any order. */
  readonly candidates: readonly ServiceRecord[];
  /** Where they were set down. */
  readonly from: string;
  /** Where they were going. */
  readonly to: string;
  /** When they were set down at `from`, "HHMM" actual. */
  readonly setDownAt: string;
  /** The booked arrival at `to` on the original service, "HHMM". */
  readonly bookedArrival: string;
}

function sameStation(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/**
 * The next train that actually left for the destination, and what it means.
 *
 * Selection is on the *recorded* departure, not the timetabled one. A service
 * booked before the set-down but running late is still a train the user could
 * have caught, and on a disrupted evening it is often the only one.
 */
export function pickOnwardConnection(input: PickOnwardInput): OnwardConnection | null {
  const setDown = parseClockTime(input.setDownAt);
  const booked = parseClockTime(input.bookedArrival);
  if (setDown === null || booked === null) return null;

  let best: OnwardConnection | null = null;

  for (const record of input.candidates) {
    const departureIndex = record.calls.findIndex(
      (call) => sameStation(call.location, input.from) && call.actualDeparture !== null,
    );
    if (departureIndex === -1) continue;

    const departureCall = record.calls[departureIndex];
    if (!departureCall) continue;

    const arrivalCall = record.calls
      .slice(departureIndex + 1)
      .find((call) => sameStation(call.location, input.to) && call.actualArrival !== null);
    if (!arrivalCall) continue;

    const departed = parseClockTime(departureCall.actualDeparture);
    const arrived = parseClockTime(arrivalCall.actualArrival);
    if (departed === null || arrived === null) continue;

    // A train that left before the user got there is not a connection they
    // could have made, however close it was.
    const waitMinutes = minutesLate(setDown, departed);
    if (waitMinutes < 0 || waitMinutes > MAX_WAIT_MINUTES) continue;

    const candidate: OnwardConnection = {
      rid: record.rid,
      from: departureCall.location,
      to: arrivalCall.location,
      departed: departureCall.actualDeparture as string,
      arrived: arrivalCall.actualArrival as string,
      waitMinutes,
      totalDelayMinutes: minutesLate(booked, arrived),
    };

    // Earliest departure wins - that is the train someone standing on the
    // platform actually boards. A tie is broken by whichever got there first.
    if (
      best === null ||
      candidate.waitMinutes < best.waitMinutes ||
      (candidate.waitMinutes === best.waitMinutes &&
        candidate.totalDelayMinutes < best.totalDelayMinutes)
    ) {
      best = candidate;
    }
  }

  return best;
}
