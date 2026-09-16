/**
 * How long a passenger is allowed to change trains at a station.
 *
 * The timetable sets a minimum change time for every station, and a connection
 * only counts if it leaves at least that long. GTR's Passenger's Charter,
 * section 11.8: "Our timetable says how long you should allow for changing
 * trains at each station. This is typically five minutes but is longer at some
 * stations". National Rail Conditions of Travel condition 20 puts the same duty
 * on the passenger when choosing trains.
 *
 * The figures come from the RDG timetable feed on the National Rail Data Portal,
 * via scripts/import-change-times.mjs:
 *
 * - the MSN file gives each station one change time;
 * - the TSI file overrides it for particular pairs of operators. Clapham
 *   Junction is 10 minutes in general but 5 from one Southern train to another;
 *   Farringdon is 8 between Thameslink and the Elizabeth line.
 *
 * The feed is republished with each timetable change. Rerun the import then.
 *
 * Pure. No network, no clock.
 */

import {
  OPERATOR_PAIR_CHANGE_MINUTES,
  STATION_CHANGE_MINUTES,
} from './changeTimes.data.js';

/**
 * For a station the timetable data does not know. GTR Passenger's Charter
 * 11.8: "typically five minutes".
 */
export const DEFAULT_CHANGE_MINUTES = 5;

export interface ResolvedChangeTime {
  readonly minutes: number;
  /** False when DEFAULT_CHANGE_MINUTES stood in for a figure from the timetable. */
  readonly fromTimetable: boolean;
}

function code(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

/**
 * The change time at `crs` from a train run by `arrivingToc` to one run by
 * `departingToc`. Either operator may be unknown, in which case only the
 * station's general figure can apply.
 */
export function resolveChangeTime(
  crs: string,
  arrivingToc?: string | null,
  departingToc?: string | null,
): ResolvedChangeTime {
  const station = code(crs);

  if (arrivingToc && departingToc) {
    const pair = OPERATOR_PAIR_CHANGE_MINUTES[`${station}:${code(arrivingToc)}:${code(departingToc)}`];
    if (pair !== undefined) return { minutes: pair, fromTimetable: true };
  }

  const general = STATION_CHANGE_MINUTES[station];
  return general === undefined
    ? { minutes: DEFAULT_CHANGE_MINUTES, fromTimetable: false }
    : { minutes: general, fromTimetable: true };
}
