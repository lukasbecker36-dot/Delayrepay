/**
 * A scan: one route, one date range, one list of candidates.
 *
 * The orchestration is deliberately thin. All the judgement lives in
 * `domain/classify.ts`, which is pure and tested on its own; this file's job is
 * to fetch, to cache, and to make sure that a bad day at HSP costs the user
 * some results rather than all of them.
 */

import { classifyJourney } from './domain/classify.js';
import {
  classifyJourneyWithChange,
  pickReplacement,
  replacementStarts,
} from './domain/classifyChange.js';
import type { TimetabledConnection } from './domain/connection.js';
import { resolveChangeTime, type ResolvedChangeTime } from './domain/changeTimes.js';
import {
  pickOnwardConnection,
  LOOKBACK_MINUTES,
  MAX_WAIT_MINUTES,
  type OnwardConnection,
} from './domain/onward.js';
import { formatClockTime, minutesLate, parseClockTime } from './domain/time.js';
import { summariseScan, type ScanCoverage } from './domain/copy.js';
import { addDays, daysBetween, parseIsoDate } from './domain/window.js';
import type { JourneyAssessment, ServiceRecord } from './domain/types.js';
import type { DayType, HspClient } from './hsp/client.js';
import { HspError, describeHspFailure } from './hsp/errors.js';
import { cacheKey, isCacheable, NullCache, type ResponseCache } from './hsp/cache.js';
import type { MatchedService } from './hsp/schema.js';
import { mapWithConcurrency } from './util/concurrency.js';

/**
 * How far past the planned arrival at a change station to look for connections.
 *
 * Wide enough for a badly late first train plus the longest wait onward. A day
 * whose first train got in later than this allows cannot be checked honestly -
 * the trains it needed are outside what was asked for - so it is reported as a
 * failure rather than scored against a partial list.
 */
const CONNECTION_HORIZON_MINUTES = 240;

/** The longest change time any station sets, as headroom on the connection band. */
const CHANGE_TIME_HEADROOM_MINUTES = 15;

/**
 * Operators left out of connections at a change station.
 *
 * HSP's London Overground records are too incomplete to plan or follow a
 * connection on: over 21 weekdays at Clapham Junction each Overground departure
 * was recorded on only 4 to 10 days, and trains Darwin shows running with actual
 * times were absent from HSP. Left out by decision (CLAUDE.md, "Journeys with a
 * change") until a complete source is in place. Results say when it happened.
 */
const CONNECTION_OPERATORS_LEFT_OUT: readonly string[] = ['LO'];

/**
 * Connection lookups ask HSP for this many minutes of departures at a time.
 *
 * A change station is often busy, and a month of departures across a few hours
 * there takes HSP longer to answer than the client waits: Clapham Junction to
 * Shepherd's Bush, 07:22 to 11:52 over 28 weekdays, took 22 seconds. An hour at
 * a time stays well inside the limit, and each hour caches on its own.
 */
const CONNECTION_CHUNK_MINUTES = 60;

/** HSP is a free service. Ask for a handful of things at a time, not hundreds. */
const DETAIL_CONCURRENCY = 4;

/**
 * Onward lookups run one at a time.
 *
 * Each is a fresh metrics call plus its details, and they only happen for the
 * rare journey that was abandoned partway. Slow is fine; hammering a free
 * service on someone else's behalf is not.
 */
const ONWARD_CONCURRENCY = 1;

/**
 * How far back the data is treated as still arriving.
 *
 * HSP lags the railway: today's trains may not have run, and the last day or
 * two may not have been written up. Inside this window an absent service means
 * "not yet", not "this train did not run", and the two must never be confused.
 */
export const DATA_SETTLING_DAYS = 2;

export interface ScanRequest {
  /** Origin CRS code. */
  readonly from: string;
  /** Destination CRS code. */
  readonly to: string;
  /**
   * CRS code of the station where the journey changes trains. Absent for a
   * single train. When set, `scheduledDeparture` and the time band describe the
   * first train, and the connection onward is found from the timetable.
   */
  readonly via?: string | null;
  /** Start of range, YYYY-MM-DD, inclusive. */
  readonly fromDate: string;
  /** End of range, YYYY-MM-DD, inclusive. */
  readonly toDate: string;
  /** Start of the departure time band, "HHMM". Keep it narrow. */
  readonly fromTime: string;
  /** End of the departure time band, "HHMM". Keep it narrow. */
  readonly toTime: string;
  /** Which days to cover. Defaults to WEEKDAY. */
  readonly days?: DayType;
  /**
   * Public timetable departure of the one service to check, "HHMM".
   *
   * A commuter takes the same train each morning. Pinning it means the results
   * are their journeys rather than every service in the band.
   */
  readonly scheduledDeparture?: string | null;
  /** Today, YYYY-MM-DD. Passed in so scans are reproducible. */
  readonly today: string;
  /** Overrides the operator's Delay Repay threshold, in minutes. */
  readonly thresholdMinutes?: number | null;
}

export interface ScanFailure {
  /** The journey date this failure cost us, where known. */
  readonly date: string | null;
  readonly rid: string | null;
  readonly kind: string;
  /** Plain-language explanation, safe to show the user. */
  readonly message: string;
}

export interface ScanResult {
  readonly request: ScanRequest;
  /** One per journey checked, newest last. */
  readonly assessments: readonly JourneyAssessment[];
  /** Everything the scan could not check, named rather than dropped. */
  readonly failures: readonly ScanFailure[];
  /** True when at least one lookup failed, so the list may be incomplete. */
  readonly partial: boolean;
  /**
   * How much of the range was actually read.
   *
   * A caller must be able to tell "checked, found nothing claimable" from
   * "checked nothing" without inspecting the prose.
   */
  readonly coverage: ScanCoverage;
  readonly summary: string;
}

export interface ScanOptions {
  readonly cache?: ResponseCache;
}

const DAY_MATCHERS: Record<DayType, (weekday: number) => boolean> = {
  // getUTCDay: 0 is Sunday.
  WEEKDAY: (weekday) => weekday >= 1 && weekday <= 5,
  SATURDAY: (weekday) => weekday === 6,
  SUNDAY: (weekday) => weekday === 0,
};

/** Every date in the range that the day filter covers. */
export function expectedDates(
  fromDate: string,
  toDate: string,
  days: DayType,
): readonly string[] {
  const span = daysBetween(fromDate, toDate);
  if (span < 0) return [];

  const matches = DAY_MATCHERS[days];
  const dates: string[] = [];
  for (let offset = 0; offset <= span; offset += 1) {
    const date = addDays(fromDate, offset);
    if (matches(new Date(parseIsoDate(date)).getUTCDay())) dates.push(date);
  }
  return dates;
}

export async function runScan(
  client: HspClient,
  request: ScanRequest,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const cache = options.cache ?? new NullCache();
  const days = request.days ?? 'WEEKDAY';
  const failures: ScanFailure[] = [];
  const dates = expectedDates(request.fromDate, request.toDate, days);

  const via = request.via?.trim().toUpperCase() || null;

  let matches: readonly MatchedService[];
  try {
    // With a change, the train pinned by the request runs only as far as it.
    matches = await fetchMetrics(client, { ...request, to: via ?? request.to }, days, cache);
  } catch (error) {
    // Nothing to work with. The caller still holds the request, so the user's
    // input is not lost - they can retry without retyping it. The summary has
    // to say that nothing was read, not that nothing was found.
    const failure = toFailure(error, null, null);
    const coverage: ScanCoverage = { expected: dates.length, checked: 0 };
    return {
      request,
      assessments: [],
      failures: [failure],
      partial: true,
      coverage,
      summary: `${summariseScan([], coverage)} ${failure.message}`,
    };
  }

  const wanted = request.scheduledDeparture?.trim();
  const relevant = wanted
    ? matches.filter((match) => match.scheduledDeparture === wanted)
    : matches;

  const rids = [...new Set(relevant.flatMap((match) => match.rids))];

  const records = await mapWithConcurrency(rids, DETAIL_CONCURRENCY, async (rid) => {
    try {
      return await fetchDetails(client, rid, request.today, cache);
    } catch (error) {
      failures.push(toFailure(error, null, rid));
      return null;
    }
  });

  const byDate = new Map<string, ServiceRecord[]>();
  for (const record of records) {
    if (record === null) continue;
    const existing = byDate.get(record.date);
    if (existing) existing.push(record);
    else byDate.set(record.date, [record]);
  }

  // A journey with a change needs the trains onward from the change station:
  // the timetable, to know what was planned, and each day's records, to know
  // what ran. A day whose connections could not be read is not scored - a
  // missing train would change the answer without saying so.
  // Whether the first trains themselves were read in full, before any
  // connection failures are added: only that makes an absent train a finding.
  const firstTrainsIncomplete = failures.length > 0;
  // A first train that never reached the change station is followed from where
  // it left the user, before the connections are read: the train they could
  // have caught instead decides when they got to the change station.
  const replacements =
    via === null ? null : await fetchReplacements(client, request, via, byDate, days, cache);
  if (replacements !== null) failures.push(...replacements.failures);
  const connections =
    via === null
      ? null
      : await fetchConnections(client, request, via, byDate, days, cache, replacements?.arrivals);
  if (connections !== null) failures.push(...connections.failures);

  const assessments: JourneyAssessment[] = [];
  /** Kept alongside each assessment so an abandoned journey can be re-scored. */
  const sourceRecords = new Map<JourneyAssessment, ServiceRecord>();
  const skipped: string[] = [];
  for (const date of dates) {
    const onThatDate = byDate.get(date) ?? [];

    if (via !== null && connections !== null) {
      if (connections.failedDates.has(date)) continue;
      if (onThatDate.length === 0 && firstTrainsIncomplete) {
        skipped.push(date);
        continue;
      }
      for (const record of onThatDate.length === 0 ? [null] : onThatDate) {
        assessments.push(
          classifyWithChange(
            record,
            date,
            request,
            via,
            connections.timetable,
            connections.onwardByDate.get(date) ?? [],
            replacements?.candidatesByDate.get(date) ?? null,
          ),
        );
      }
      continue;
    }

    if (onThatDate.length === 0) {
      // Only assert a missing service when nothing went wrong fetching it.
      // Otherwise the gap is ours, not the railway's, and "we could not see
      // this train" would be a lie in the direction that matters most. The
      // date is still reported, as a failure rather than as a finding.
      if (failures.length > 0) {
        skipped.push(date);
        continue;
      }
      assessments.push(classifyFor(null, date, request));
      continue;
    }

    for (const record of onThatDate) {
      const assessment = classifyFor(record, date, request);
      sourceRecords.set(assessment, record);
      assessments.push(assessment);
    }
  }

  // Second pass. A journey whose train did not take the user to their
  // destination is not finished being assessed: the delay that decides the
  // claim is the one at the destination, and that depends on the train they
  // caught instead. Only these journeys cost an extra lookup, and a failure
  // here costs the total rather than the result. (Journeys with a change do
  // this inside the change station lookups.)
  const resolved = await mapWithConcurrency(
    assessments,
    ONWARD_CONCURRENCY,
    async (assessment) => {
      if (assessment.via !== null) return assessment;
      const record = sourceRecords.get(assessment);
      const bookedArrival = assessment.scheduledArrival;
      if (record === undefined || bookedArrival === null) return assessment;

      const lookup = (station: string, readyAt: string, fromOrigin: boolean) =>
        findTrainFrom(client, request, {
          date: assessment.date,
          station,
          readyAt,
          bookedArrival,
          excludeRid: record.rid,
          // Someone whose train never left, or never stopped, is already on the platform.
          changeTimeFor: (departingToc) =>
            fromOrigin
              ? { minutes: 0, fromTimetable: true }
              : resolveChangeTime(station, record.tocCode, departingToc),
        }, days, cache);

      try {
        let onward: OnwardConnection | null = null;
        let carried: OnwardConnection | null = null;

        if (assessment.outcome === 'did-not-call') {
          const setDown = assessment.lastRecordedCall;
          if (setDown !== null) onward = await lookup(setDown.location, setDown.time, false);
          const next = assessment.carriedPast?.call ?? null;
          if (next !== null) carried = await lookup(next.location, next.time, false);
        } else if (
          assessment.scheduledDeparture !== null &&
          (assessment.outcome === 'skipped-origin' ||
            (assessment.outcome === 'arrival-not-recorded' && assessment.actualDeparture === null))
        ) {
          onward = await lookup(request.from, assessment.scheduledDeparture, true);
        }

        if (onward === null && carried === null) return assessment;
        return classifyFor(record, assessment.date, request, onward, carried);
      } catch (error) {
        failures.push(toFailure(error, assessment.date, null));
        // The journey still stands, just without the total. Losing the
        // connection must never lose the flagged journey itself.
        return assessment;
      }
    },
  );
  assessments.length = 0;
  assessments.push(...resolved);

  for (const date of skipped) {
    failures.push({
      date,
      rid: null,
      kind: 'incomplete',
      message:
        'This date could not be checked, because another lookup in the same scan ' +
        'failed. Try again shortly.',
    });
  }

  assessments.sort((a, b) => a.date.localeCompare(b.date));

  // Counted by date, not by assessment: a date can carry more than one service,
  // and a date we could not read carries none.
  const coverage: ScanCoverage = {
    expected: dates.length,
    checked: new Set(assessments.map((a) => a.date)).size,
  };

  return {
    request,
    assessments,
    failures,
    partial: failures.length > 0,
    coverage,
    summary: summariseScan(assessments, coverage),
  };
}

function classifyWithChange(
  record: ServiceRecord | null,
  date: string,
  request: ScanRequest,
  via: string,
  timetable: readonly TimetabledConnection[],
  onward: readonly ServiceRecord[],
  replacementCandidates: readonly ServiceRecord[] | null,
): JourneyAssessment {
  return classifyJourneyWithChange({
    record,
    from: request.from,
    via,
    to: request.to,
    date,
    today: request.today,
    dataMayBeIncomplete: daysBetween(date, request.today) < DATA_SETTLING_DAYS,
    timetable,
    onward,
    changeTimeFor: (arrivingToc, departingToc) =>
      resolveChangeTime(via, arrivingToc, departingToc),
    leaveOutOperators: CONNECTION_OPERATORS_LEFT_OUT,
    replacementCandidates,
    changeTimeAt: resolveChangeTime,
    ...(request.thresholdMinutes == null ? {} : { thresholdMinutes: request.thresholdMinutes }),
  });
}

interface Replacements {
  /** Each day's trains from where the first train left the user to the change station. */
  readonly candidatesByDate: ReadonlyMap<string, readonly ServiceRecord[]>;
  /**
   * When each such day's first train was due at the change station, and when
   * each possible replacement got there - more than one when it ran past.
   */
  readonly arrivals: ReadonlyMap<string, { readonly scheduled: number; readonly actuals: readonly number[] }>;
  readonly failures: readonly ScanFailure[];
}

/**
 * For each day whose first train never reached the change station, the trains
 * that could have carried the user there instead.
 *
 * A day whose trains could not be read keeps its result without a delay figure
 * and is named as a failure - losing the replacement must never lose the
 * flagged journey.
 */
async function fetchReplacements(
  client: HspClient,
  request: ScanRequest,
  via: string,
  firstTrains: ReadonlyMap<string, readonly ServiceRecord[]>,
  days: DayType,
  cache: ResponseCache,
): Promise<Replacements> {
  const candidatesByDate = new Map<string, ServiceRecord[]>();
  const arrivals = new Map<string, { scheduled: number; actuals: number[] }>();
  const failures: ScanFailure[] = [];

  for (const [date, records] of firstTrains) {
    for (const record of records) {
      const due = arrivalAt(record, request.from, via).scheduled;
      if (due === null) continue;

      for (const start of replacementStarts(record, request.from, via, date, request.today)) {
        const ready = parseClockTime(start.readyAt);
        if (ready === null) continue;
        const fromMinutes = ready - LOOKBACK_MINUTES;
        const toMinutes = ready + MAX_WAIT_MINUTES + CHANGE_TIME_HEADROOM_MINUTES;
        if (fromMinutes < 0 || toMinutes >= 1440) continue;

        try {
          const matches = await fetchMetricsBand(
            client,
            { ...request, from: start.station, to: via, fromDate: date, toDate: date, scheduledDeparture: null },
            fromMinutes,
            toMinutes,
            days,
            cache,
          );
          const rids = [
            ...new Set(
              matches
                .filter((match) => !CONNECTION_OPERATORS_LEFT_OUT.includes((match.tocCode ?? '').toUpperCase()))
                .flatMap((match) => match.rids)
                .filter((rid) => rid !== record.rid && (ridDate(rid) === null || ridDate(rid) === date)),
            ),
          ];
          const found = (
            await mapWithConcurrency(rids, DETAIL_CONCURRENCY, (rid) =>
              fetchDetails(client, rid, request.today, cache),
            )
          ).filter((candidate) => candidate.date === date);

          // One pool per day: each train is only ever picked from a station it calls at.
          const pool = candidatesByDate.get(date) ?? [];
          for (const candidate of found) {
            if (!pool.some((known) => known.rid === candidate.rid)) pool.push(candidate);
          }
          candidatesByDate.set(date, pool);

          const leg = pickReplacement({
            start,
            candidates: found,
            via,
            bookedArrivalAtVia: formatClockTime(due),
            firstTocCode: record.tocCode,
            changeTimeAt: resolveChangeTime,
          });
          const actual = parseClockTime(leg?.train.arrived);
          if (actual !== null) {
            const known = arrivals.get(date) ?? { scheduled: due, actuals: [] };
            known.actuals.push(actual);
            arrivals.set(date, known);
          }
        } catch (error) {
          const failure = toFailure(error, date, null);
          failures.push({
            ...failure,
            message:
              `The trains from ${start.station} to ${via} after your train could not be read, ` +
              `so this journey may have no delay figure. ${failure.message}`,
          });
        }
      }
    }
  }

  return { candidatesByDate, arrivals, failures };
}

/** HSP departures from `request.from` to `request.to` across a band, an hour at a time. */
async function fetchMetricsBand(
  client: HspClient,
  request: ScanRequest,
  fromMinutes: number,
  toMinutes: number,
  days: DayType,
  cache: ResponseCache,
): Promise<MatchedService[]> {
  const matches: MatchedService[] = [];
  for (let start = fromMinutes; start <= toMinutes; start += CONNECTION_CHUNK_MINUTES) {
    const end = Math.min(start + CONNECTION_CHUNK_MINUTES - 1, toMinutes);
    matches.push(
      ...(await fetchMetrics(
        client,
        { ...request, fromTime: formatClockTime(start), toTime: formatClockTime(end) },
        days,
        cache,
      )),
    );
  }
  return matches;
}

interface Connections {
  /** Every train seen running from the change station to the destination in the range. */
  readonly timetable: readonly TimetabledConnection[];
  readonly onwardByDate: ReadonlyMap<string, readonly ServiceRecord[]>;
  /** Days whose connections could not be read, already reported in `failures`. */
  readonly failedDates: ReadonlySet<string>;
  readonly failures: readonly ScanFailure[];
}

/** The scheduled and recorded arrival of a first train at the change station. */
function arrivalAt(
  record: ServiceRecord,
  from: string,
  via: string,
): { readonly scheduled: number | null; readonly actual: number | null } {
  const same = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();
  const start = record.calls.findIndex((call) => same(call.location, from));
  const arrival = start === -1 ? undefined : record.calls.slice(start + 1).find((call) => same(call.location, via));
  return {
    scheduled: parseClockTime(arrival?.scheduledArrival),
    actual: parseClockTime(arrival?.actualArrival),
  };
}

/**
 * The date a Darwin RID belongs to, from its leading YYYYMMDD.
 *
 * HSP's RIDs carry the service date - 202609157107161 ran on 2026-09-15 - which
 * lets a connection lookup fetch only the days it needs. Null when a RID does
 * not look like that, and then it is fetched and sorted by its record instead.
 */
function ridDate(rid: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(rid);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

async function fetchConnections(
  client: HspClient,
  request: ScanRequest,
  via: string,
  firstTrains: ReadonlyMap<string, readonly ServiceRecord[]>,
  days: DayType,
  cache: ResponseCache,
  /** Arrivals at the change station on replacement trains, for days the first train never got there. */
  replacementArrivals: ReadonlyMap<string, { readonly scheduled: number; readonly actuals: readonly number[] }> = new Map(),
): Promise<Connections> {
  const failures: ScanFailure[] = [];
  const failedDates = new Set<string>();
  const failDate = (date: string, message: string, kind = 'connection') => {
    if (failedDates.has(date)) return;
    failedDates.add(date);
    failures.push({ date, rid: null, kind, message });
  };

  // When each day's first train was due in, and when it got there.
  const arrivals = new Map<string, { scheduled: number; actuals: readonly number[] }>();
  let planned: number | null = null;
  for (const [date, records] of firstTrains) {
    for (const record of records) {
      const { scheduled, actual } = arrivalAt(record, request.from, via);
      if (scheduled !== null) planned ??= scheduled;
      if (scheduled !== null && actual !== null) arrivals.set(date, { scheduled, actuals: [actual] });
    }
  }
  for (const [date, arrival] of replacementArrivals) {
    if (!arrivals.has(date) && arrival.actuals.length > 0) arrivals.set(date, arrival);
  }
  const empty: Connections = { timetable: [], onwardByDate: new Map(), failedDates, failures };
  if (planned === null) return empty;

  // One band for the whole range: from a little before the earliest arrival,
  // for trains booked earlier and running late, to the longest wait after the
  // latest - but never past the horizon.
  const horizon = planned + CONNECTION_HORIZON_MINUTES;
  const allActuals = [...arrivals.values()].flatMap((a) => a.actuals);
  const earliest = Math.min(planned, ...allActuals);
  const latest = Math.max(planned, ...allActuals);
  const fromMinutes = earliest - LOOKBACK_MINUTES;
  const toMinutes = Math.min(
    latest + MAX_WAIT_MINUTES + CHANGE_TIME_HEADROOM_MINUTES,
    horizon,
  );
  if (fromMinutes < 0 || toMinutes >= 1440) {
    for (const date of arrivals.keys()) {
      failDate(date, `The connection at ${via} runs across midnight, which this check cannot follow yet.`);
    }
    return empty;
  }

  let matches: MatchedService[];
  try {
    matches = await fetchMetricsBand(
      client,
      { ...request, from: via, scheduledDeparture: null },
      fromMinutes,
      toMinutes,
      days,
      cache,
    );
  } catch (error) {
    const failure = toFailure(error, null, null);
    for (const date of arrivals.keys()) {
      failDate(date, `The trains onward from ${via} could not be read. ${failure.message}`, failure.kind);
    }
    return empty;
  }

  const seen = new Set<string>();
  const timetable: TimetabledConnection[] = [];
  for (const match of matches) {
    if (match.scheduledDeparture === null || match.scheduledArrival === null) continue;
    const key = `${match.tocCode}|${match.scheduledDeparture}|${match.scheduledArrival}`;
    if (seen.has(key)) continue;
    seen.add(key);
    timetable.push({
      tocCode: match.tocCode,
      scheduledDeparture: match.scheduledDeparture,
      scheduledArrival: match.scheduledArrival,
    });
  }

  // For each day, only the trains that could matter: booked from a little
  // before the first train got in, to the longest wait after.
  const wanted = new Map<string, Set<string>>();
  for (const [date, { scheduled, actuals }] of arrivals) {
    const opens = Math.min(...actuals) - LOOKBACK_MINUTES;
    const closes = Math.max(...actuals, scheduled) + MAX_WAIT_MINUTES + CHANGE_TIME_HEADROOM_MINUTES;
    if (closes > horizon) {
      failDate(date, `The first train reached ${via} too late for its connections to be checked.`);
      continue;
    }
    const rids = new Set<string>();
    for (const match of matches) {
      // Their records would be discarded, so they are not worth asking for.
      if (CONNECTION_OPERATORS_LEFT_OUT.includes((match.tocCode ?? '').toUpperCase())) continue;
      const departs = parseClockTime(match.scheduledDeparture);
      if (departs === null) continue;
      if (minutesLate(opens, departs) < 0 || minutesLate(departs, closes) < 0) continue;
      for (const rid of match.rids) {
        const belongs = ridDate(rid);
        if (belongs === null || belongs === date) rids.add(rid);
      }
    }
    wanted.set(date, rids);
  }

  const onwardByDate = new Map<string, ServiceRecord[]>();
  const allRids = [...new Set([...wanted.values()].flatMap((rids) => [...rids]))];
  const fetched = await mapWithConcurrency(allRids, DETAIL_CONCURRENCY, async (rid) => {
    try {
      return { rid, record: await fetchDetails(client, rid, request.today, cache) };
    } catch (error) {
      return { rid, error };
    }
  });

  for (const result of fetched) {
    if ('error' in result) {
      // A train we failed to read is a train that might have been the way on.
      const failure = toFailure(result.error, null, result.rid);
      for (const [date, rids] of wanted) {
        if (rids.has(result.rid)) {
          failDate(date, `A train onward from ${via} could not be read. ${failure.message}`, failure.kind);
        }
      }
      continue;
    }
    const existing = onwardByDate.get(result.record.date);
    if (existing) existing.push(result.record);
    else onwardByDate.set(result.record.date, [result.record]);
  }

  return { timetable, onwardByDate, failedDates, failures };
}

function classifyFor(
  record: ServiceRecord | null,
  date: string,
  request: ScanRequest,
  onwardConnection: OnwardConnection | null = null,
  carriedPastConnection: OnwardConnection | null = null,
): JourneyAssessment {
  return classifyJourney({
    record,
    from: request.from,
    to: request.to,
    date,
    today: request.today,
    dataMayBeIncomplete: daysBetween(date, request.today) < DATA_SETTLING_DAYS,
    onwardConnection,
    carriedPastConnection,
    ...(request.thresholdMinutes == null ? {} : { thresholdMinutes: request.thresholdMinutes }),
  });
}

/**
 * The first train that actually left `station` for the destination once the
 * user could board it - after their own stopped short, ran past, or never ran.
 *
 * Classification happens twice for these journeys: once to discover what
 * happened and where, then - knowing which station to ask about - again with
 * the train supplied. Re-running the classifier is free and pure, and it keeps
 * every sentence about the journey being decided in one place rather than
 * patched on afterwards.
 */
async function findTrainFrom(
  client: HspClient,
  request: ScanRequest,
  from: {
    readonly date: string;
    readonly station: string;
    /** When the user could board, "HHMM". */
    readonly readyAt: string;
    /** The original train's booked arrival at the destination, "HHMM". */
    readonly bookedArrival: string;
    /** The user's own train, never a way on. */
    readonly excludeRid: string;
    readonly changeTimeFor: (departingToc: string | null) => ResolvedChangeTime;
  },
  days: DayType,
  cache: ResponseCache,
): Promise<OnwardConnection | null> {
  const ready = parseClockTime(from.readyAt);
  if (ready === null) return null;

  // A band that runs backwards over midnight is not something serviceMetrics
  // can answer. Rather than send a query whose meaning we cannot predict, skip
  // the lookup and leave the journey reported without a connection.
  if (ready - LOOKBACK_MINUTES < 0 || ready + MAX_WAIT_MINUTES >= 1440) return null;

  const matches = await fetchMetrics(
    client,
    {
      from: from.station,
      to: request.to,
      fromDate: from.date,
      toDate: from.date,
      fromTime: formatClockTime(ready - LOOKBACK_MINUTES),
      toTime: formatClockTime(ready + MAX_WAIT_MINUTES),
      scheduledDeparture: null,
      today: request.today,
      thresholdMinutes: request.thresholdMinutes ?? null,
    },
    days,
    cache,
  );

  const rids = [...new Set(matches.flatMap((match) => match.rids))].filter(
    (rid) => rid !== from.excludeRid,
  );

  // Only trains that ran that day: a way on the next morning is not a way on.
  const candidates = (
    await mapWithConcurrency(rids, DETAIL_CONCURRENCY, async (rid) =>
      fetchDetails(client, rid, request.today, cache),
    )
  ).filter((candidate) => candidate.date === from.date);

  return pickOnwardConnection({
    candidates,
    from: from.station,
    to: request.to,
    setDownAt: from.readyAt,
    bookedArrival: from.bookedArrival,
    changeTimeFor: from.changeTimeFor,
  });
}

async function fetchMetrics(
  client: HspClient,
  request: ScanRequest,
  days: DayType,
  cache: ResponseCache,
): Promise<readonly MatchedService[]> {
  const key = cacheKey('serviceMetrics', {
    from: request.from,
    to: request.to,
    fromDate: request.fromDate,
    toDate: request.toDate,
    fromTime: request.fromTime,
    toTime: request.toTime,
    days,
  });

  const cached = await cache.get<readonly MatchedService[]>(key);
  if (cached !== undefined) return cached;

  const matches = await client.serviceMetrics({
    fromLocation: request.from,
    toLocation: request.to,
    fromTime: request.fromTime,
    toTime: request.toTime,
    fromDate: request.fromDate,
    toDate: request.toDate,
    days,
  });

  // The range runs up to today, whose services are still being recorded.
  if (isCacheable(request.toDate, request.today)) {
    await cache.set(key, matches);
  }
  return matches;
}

async function fetchDetails(
  client: HspClient,
  rid: string,
  today: string,
  cache: ResponseCache,
): Promise<ServiceRecord> {
  const key = cacheKey('serviceDetails', { rid });

  const cached = await cache.get<ServiceRecord>(key);
  if (cached !== undefined) return cached;

  const record = await client.serviceDetails(rid);
  if (isCacheable(record.date, today)) {
    await cache.set(key, record);
  }
  return record;
}

function toFailure(error: unknown, date: string | null, rid: string | null): ScanFailure {
  if (error instanceof HspError) {
    return { date, rid, kind: error.kind, message: describeHspFailure(error) };
  }
  return {
    date,
    rid,
    kind: 'unknown',
    message: 'Something went wrong reading the performance data.',
  };
}
