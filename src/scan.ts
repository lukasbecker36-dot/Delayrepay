/**
 * A scan: one route, one date range, one list of candidates.
 *
 * The orchestration is deliberately thin. All the judgement lives in
 * `domain/classify.ts`, which is pure and tested on its own; this file's job is
 * to fetch, to cache, and to make sure that a bad day at HSP costs the user
 * some results rather than all of them.
 */

import { classifyJourney } from './domain/classify.js';
import { summariseScan } from './domain/copy.js';
import { addDays, daysBetween, parseIsoDate } from './domain/window.js';
import type { JourneyAssessment, ServiceRecord } from './domain/types.js';
import type { DayType, HspClient } from './hsp/client.js';
import { HspError, describeHspFailure } from './hsp/errors.js';
import { cacheKey, isCacheable, NullCache, type ResponseCache } from './hsp/cache.js';
import type { MatchedService } from './hsp/schema.js';
import { mapWithConcurrency } from './util/concurrency.js';

/** HSP is a free service. Ask for a handful of things at a time, not hundreds. */
const DETAIL_CONCURRENCY = 4;

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

  let matches: readonly MatchedService[];
  try {
    matches = await fetchMetrics(client, request, days, cache);
  } catch (error) {
    // Nothing to work with. The caller still holds the request, so the user's
    // input is not lost - they can retry without retyping it.
    const failure = toFailure(error, null, null);
    return {
      request,
      assessments: [],
      failures: [failure],
      partial: true,
      summary: failure.message,
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

  const assessments: JourneyAssessment[] = [];
  const skipped: string[] = [];
  for (const date of expectedDates(request.fromDate, request.toDate, days)) {
    const onThatDate = byDate.get(date) ?? [];

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
      assessments.push(classifyFor(record, date, request));
    }
  }

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

  return {
    request,
    assessments,
    failures,
    partial: failures.length > 0,
    summary: summariseScan(assessments),
  };
}

function classifyFor(
  record: ServiceRecord | null,
  date: string,
  request: ScanRequest,
): JourneyAssessment {
  return classifyJourney({
    record,
    from: request.from,
    to: request.to,
    date,
    today: request.today,
    dataMayBeIncomplete: daysBetween(date, request.today) < DATA_SETTLING_DAYS,
    ...(request.thresholdMinutes == null ? {} : { thresholdMinutes: request.thresholdMinutes }),
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
