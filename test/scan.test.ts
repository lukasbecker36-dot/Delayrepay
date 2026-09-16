import { describe, expect, it } from 'vitest';
import { expectedDates, runScan, type ScanRequest } from '../src/scan.js';
import { MemoryCache } from '../src/hsp/cache.js';
import { HspError } from '../src/hsp/errors.js';
import type { HspClient } from '../src/hsp/client.js';
import type { ServiceRecord } from '../src/domain/types.js';
import type { MatchedService } from '../src/hsp/schema.js';

const TODAY = '2026-09-15';

const REQUEST: ScanRequest = {
  from: 'BTN',
  to: 'VIC',
  fromDate: '2026-09-07',
  toDate: '2026-09-11',
  fromTime: '0700',
  toTime: '0730',
  scheduledDeparture: '0715',
  today: TODAY,
  thresholdMinutes: 15,
};

function service(rids: readonly string[], scheduledDeparture = '0715'): MatchedService {
  return {
    rids,
    originLocation: 'BTN',
    destinationLocation: 'VIC',
    scheduledDeparture,
    scheduledArrival: '0817',
    tocCode: 'SN',
  };
}

function arriving(rid: string, date: string, actualArrival: string | null): ServiceRecord {
  return {
    rid,
    date,
    tocCode: 'SN',
    calls: [
      {
        location: 'BTN',
        scheduledDeparture: '0715',
        scheduledArrival: null,
        actualDeparture: actualArrival === null ? null : '0716',
        actualArrival: null,
        lateCancReason: null,
      },
      {
        location: 'VIC',
        scheduledDeparture: null,
        scheduledArrival: '0817',
        actualDeparture: null,
        actualArrival,
        lateCancReason: actualArrival === null ? '574' : null,
      },
    ],
  };
}

interface FakeOptions {
  readonly metrics?: readonly MatchedService[];
  readonly details?: Record<string, ServiceRecord>;
  readonly metricsError?: unknown;
  readonly detailErrors?: Record<string, unknown>;
}

function fakeClient(options: FakeOptions) {
  const detailCalls: string[] = [];
  let metricsCalls = 0;

  const client = {
    async serviceMetrics() {
      metricsCalls += 1;
      if (options.metricsError) throw options.metricsError;
      return options.metrics ?? [];
    },
    async serviceDetails(rid: string) {
      detailCalls.push(rid);
      const failure = options.detailErrors?.[rid];
      if (failure) throw failure;
      const record = options.details?.[rid];
      if (!record) throw new HspError('unknown', `no fixture for ${rid}`);
      return record;
    },
  } as unknown as HspClient;

  return {
    client,
    detailCalls,
    get metricsCalls() {
      return metricsCalls;
    },
  };
}

describe('expectedDates', () => {
  it('covers weekdays only by default', () => {
    expect(expectedDates('2026-09-07', '2026-09-13', 'WEEKDAY')).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
    ]);
  });

  it('covers Saturdays and Sundays when asked', () => {
    expect(expectedDates('2026-09-07', '2026-09-13', 'SATURDAY')).toEqual(['2026-09-12']);
    expect(expectedDates('2026-09-07', '2026-09-13', 'SUNDAY')).toEqual(['2026-09-13']);
  });

  it('is empty when the range runs backwards', () => {
    expect(expectedDates('2026-09-13', '2026-09-07', 'WEEKDAY')).toEqual([]);
  });

  it('includes both ends of the range', () => {
    expect(expectedDates('2026-09-07', '2026-09-07', 'WEEKDAY')).toEqual(['2026-09-07']);
  });
});

describe('a scan over a working week', () => {
  const fake = () =>
    fakeClient({
      metrics: [service(['r-mon', 'r-tue', 'r-wed', 'r-thu'])],
      details: {
        'r-mon': arriving('r-mon', '2026-09-07', '0819'),
        'r-tue': arriving('r-tue', '2026-09-08', '0851'),
        'r-wed': arriving('r-wed', '2026-09-09', null),
        'r-thu': arriving('r-thu', '2026-09-10', '0837'),
      },
    });

  it('returns one result per weekday in the range', async () => {
    const result = await runScan(fake().client, REQUEST);
    expect(result.assessments.map((a) => a.date)).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
    ]);
  });

  it('flags the late one, the cancelled one, and the Friday with no service at all', async () => {
    const result = await runScan(fake().client, REQUEST);
    const byDate = Object.fromEntries(result.assessments.map((a) => [a.date, a]));

    expect(byDate['2026-09-07']?.outcome).toBe('within-threshold');
    expect(byDate['2026-09-08']?.outcome).toBe('delayed');
    expect(byDate['2026-09-08']?.delayMinutes).toBe(34);
    expect(byDate['2026-09-09']?.outcome).toBe('arrival-not-recorded');
    expect(byDate['2026-09-10']?.outcome).toBe('delayed');
    expect(byDate['2026-09-11']?.outcome).toBe('service-not-found');
  });

  it('counts the candidates and names the one expiring first', async () => {
    const result = await runScan(fake().client, REQUEST);
    expect(result.assessments.filter((a) => a.looksClaimable)).toHaveLength(3);
    expect(result.summary).toContain('3 journeys look claimable');
    expect(result.summary).toContain('2026-09-08');
    expect(result.partial).toBe(false);
  });

  it('only fetches the service the commuter actually takes', async () => {
    const withTwoServices = fakeClient({
      metrics: [service(['r-mon'], '0715'), service(['other-1', 'other-2'], '0745')],
      details: { 'r-mon': arriving('r-mon', '2026-09-07', '0851') },
    });
    await runScan(withTwoServices.client, REQUEST);
    expect(withTwoServices.detailCalls).toEqual(['r-mon']);
  });

  it('never asks for the same RID twice', async () => {
    const duplicated = fakeClient({
      metrics: [service(['r-mon', 'r-mon'])],
      details: { 'r-mon': arriving('r-mon', '2026-09-07', '0851') },
    });
    await runScan(duplicated.client, REQUEST);
    expect(duplicated.detailCalls).toEqual(['r-mon']);
  });
});

describe('the most recent days', () => {
  it('does not report a missing train for a date the data has not reached', async () => {
    // Running this for real on 2026-09-15 reported today's train as one the
    // data had never seen. It had simply not run yet.
    const upToToday: ScanRequest = { ...REQUEST, fromDate: '2026-09-14', toDate: TODAY };
    const fake = fakeClient({ metrics: [service([])], details: {} });

    const result = await runScan(fake.client, upToToday);
    const byDate = Object.fromEntries(result.assessments.map((a) => [a.date, a]));

    expect(byDate[TODAY]?.outcome).toBe('awaiting-data');
    expect(byDate[TODAY]?.needsManualCheck).toBe(false);
    expect(byDate['2026-09-14']?.outcome).toBe('awaiting-data');
  });

  it('still reports a genuinely missing train once the data has had time', async () => {
    const fake = fakeClient({ metrics: [service([])], details: {} });
    const result = await runScan(fake.client, REQUEST);
    const byDate = Object.fromEntries(result.assessments.map((a) => [a.date, a]));

    expect(byDate['2026-09-07']?.outcome).toBe('service-not-found');
    expect(byDate['2026-09-11']?.outcome).toBe('service-not-found');
  });
});

describe('when HSP is having a bad day', () => {
  it('keeps the request intact when the first call fails, so nothing is retyped', async () => {
    const failing = fakeClient({ metricsError: new HspError('unavailable', 'down') });
    const result = await runScan(failing.client, REQUEST);

    expect(result.request).toEqual(REQUEST);
    expect(result.assessments).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.failures[0]?.message).toContain('Your scan is saved');
  });

  it('returns the journeys it could check when one lookup fails', async () => {
    const partly = fakeClient({
      metrics: [service(['r-mon', 'r-tue'])],
      details: { 'r-mon': arriving('r-mon', '2026-09-07', '0851') },
      detailErrors: { 'r-tue': new HspError('unavailable', 'down') },
    });
    const result = await runScan(partly.client, REQUEST);

    expect(result.partial).toBe(true);
    expect(result.assessments.some((a) => a.date === '2026-09-07' && a.looksClaimable)).toBe(true);
  });

  it('does not report a missing train when the gap was our own failed lookup', async () => {
    // Saying "we could not see this service" when the truth is "we could not
    // ask" would be a lie in the direction that matters most.
    const partly = fakeClient({
      metrics: [service(['r-mon', 'r-tue'])],
      details: { 'r-mon': arriving('r-mon', '2026-09-07', '0851') },
      detailErrors: { 'r-tue': new HspError('unavailable', 'down') },
    });
    const result = await runScan(partly.client, REQUEST);

    expect(result.assessments.some((a) => a.outcome === 'service-not-found')).toBe(false);
    const unchecked = result.failures.filter((f) => f.kind === 'incomplete').map((f) => f.date);
    expect(unchecked).toContain('2026-09-08');
    expect(unchecked).toContain('2026-09-11');
  });

  it('reports an auth failure as something to fix rather than as a retry', async () => {
    const denied = fakeClient({ metricsError: new HspError('auth', '401') });
    const result = await runScan(denied.client, REQUEST);
    expect(result.failures[0]?.kind).toBe('auth');
    expect(result.failures[0]?.message).toContain('HSP_EMAIL');
  });

  it('summarises a total failure as a failure, not as nothing to claim', async () => {
    // The scan read no data at all. Announcing "no journeys look claimable"
    // here would be the tool asserting a finding it has no basis for.
    const blocked = fakeClient({ metricsError: new HspError('blocked', '403') });
    const result = await runScan(blocked.client, REQUEST);

    expect(result.summary).not.toContain('No journeys in this range look claimable');
    expect(result.summary).toContain('Nothing could be checked');
    expect(result.coverage).toEqual({ expected: 5, checked: 0 });
  });

  it('counts coverage by date, so a clean scan is distinguishable from a failed one', async () => {
    const working = fakeClient({
      metrics: [service(['r-mon'])],
      details: { 'r-mon': arriving('r-mon', '2026-09-07', '0720') },
    });
    const result = await runScan(working.client, REQUEST);

    // Five weekdays in range, all five accounted for: four as services HSP has
    // no record of, one as a journey that ran. "HSP has no record" is a finding
    // we went and got, so it counts as checked - unlike a lookup that failed.
    expect(result.coverage).toEqual({ expected: 5, checked: 5 });
    expect(result.summary).not.toContain('may be incomplete');
    expect(result.summary).not.toContain('Nothing could be checked');
    expect(result.summary.startsWith('No journeys in this range look claimable.')).toBe(true);
  });

  it('says how much of the range it missed when only part of it failed', async () => {
    const partly = fakeClient({
      metrics: [service(['r-mon', 'r-tue'])],
      details: { 'r-mon': arriving('r-mon', '2026-09-07', '0851') },
      detailErrors: { 'r-tue': new HspError('unavailable', 'down') },
    });
    const result = await runScan(partly.client, REQUEST);

    expect(result.coverage.checked).toBeLessThan(result.coverage.expected);
    expect(result.summary).toContain('may be incomplete');
  });
});

describe('caching', () => {
  it('serves a repeat scan of a past range without touching HSP', async () => {
    const cache = new MemoryCache();
    const first = fakeClient({
      metrics: [service(['r-mon'])],
      details: { 'r-mon': arriving('r-mon', '2026-09-07', '0851') },
    });
    await runScan(first.client, REQUEST, { cache });

    const second = fakeClient({
      metrics: [service(['r-mon'])],
      details: { 'r-mon': arriving('r-mon', '2026-09-07', '0851') },
    });
    const result = await runScan(second.client, REQUEST, { cache });

    expect(second.metricsCalls).toBe(0);
    expect(second.detailCalls).toEqual([]);
    expect(result.assessments.some((a) => a.looksClaimable)).toBe(true);
  });

  it('does not cache a range that runs up to today', async () => {
    const cache = new MemoryCache();
    const live: ScanRequest = { ...REQUEST, toDate: TODAY };
    const options = {
      metrics: [service(['r-mon'])],
      details: { 'r-mon': arriving('r-mon', '2026-09-07', '0851') },
    };

    await runScan(fakeClient(options).client, live, { cache });
    const second = fakeClient(options);
    await runScan(second.client, live, { cache });

    expect(second.metricsCalls).toBe(1);
  });
});

describe('a journey that was abandoned partway', () => {
  const ABANDONED: ServiceRecord = {
    rid: 'r-main',
    date: '2026-09-07',
    tocCode: 'SN',
    calls: [
      {
        location: 'BTN',
        scheduledDeparture: '0715',
        scheduledArrival: null,
        actualDeparture: '0716',
        actualArrival: null,
        lateCancReason: null,
      },
      {
        location: 'HHE',
        scheduledDeparture: null,
        scheduledArrival: '0740',
        actualDeparture: null,
        actualArrival: '0821',
        lateCancReason: '911',
      },
      {
        location: 'VIC',
        scheduledDeparture: null,
        scheduledArrival: '0817',
        actualDeparture: null,
        actualArrival: null,
        lateCancReason: '911',
      },
    ],
  };

  const ONWARD: ServiceRecord = {
    rid: 'r-onward',
    date: '2026-09-07',
    tocCode: 'SN',
    calls: [
      {
        location: 'HHE',
        scheduledDeparture: '0820',
        scheduledArrival: null,
        actualDeparture: '0835',
        actualArrival: null,
        lateCancReason: null,
      },
      {
        location: 'VIC',
        scheduledDeparture: null,
        scheduledArrival: '0850',
        actualDeparture: null,
        actualArrival: '0905',
        lateCancReason: null,
      },
    ],
  };

  /** Answers the onward query differently from the main one. */
  function twoStageClient(options: { onwardThrows?: unknown } = {}) {
    const queries: string[] = [];
    const client = {
      async serviceMetrics(query: { fromLocation: string; fromTime: string }) {
        queries.push(`${query.fromLocation}@${query.fromTime}`);
        if (query.fromLocation === 'HHE') {
          if (options.onwardThrows) throw options.onwardThrows;
          return [
            {
              rids: ['r-onward'],
              originLocation: 'HHE',
              destinationLocation: 'VIC',
              scheduledDeparture: '0820',
              scheduledArrival: '0850',
              tocCode: 'SN',
            },
          ];
        }
        return [service(['r-main'])];
      },
      async serviceDetails(rid: string) {
        if (rid === 'r-main') return ABANDONED;
        if (rid === 'r-onward') return ONWARD;
        throw new HspError('unknown', `no fixture for ${rid}`);
      },
    } as unknown as HspClient;
    return { client, queries };
  }

  const request: ScanRequest = {
    ...REQUEST,
    fromDate: '2026-09-07',
    toDate: '2026-09-07',
  };

  it('looks up the connection and scores the journey on the total delay', async () => {
    const { client } = twoStageClient();
    const result = await runScan(client, request);
    const journey = result.assessments.find((a) => a.date === '2026-09-07');

    // Booked into VIC at 0817, actually there at 0905 on the next train.
    expect(journey?.outcome).toBe('did-not-call');
    expect(journey?.delayMinutes).toBe(48);
    expect(journey?.onwardConnection?.rid).toBe('r-onward');
    expect(journey?.looksClaimable).toBe(true);
  });

  it('asks about onward trains from before the set-down, not just after it', async () => {
    // The train someone catches is often one booked earlier and running late.
    const { client, queries } = twoStageClient();
    await runScan(client, request);

    expect(queries.some((q) => q.startsWith('HHE@'))).toBe(true);
    expect(queries).toContain('HHE@0751'); // 0821 set-down, less 30 minutes.
  });

  it('keeps the flagged journey when the connection lookup fails', async () => {
    // Losing the total is a worse result. Losing the claim would be a bug.
    const { client } = twoStageClient({ onwardThrows: new HspError('unavailable', 'down') });
    const result = await runScan(client, request);
    const journey = result.assessments.find((a) => a.date === '2026-09-07');

    expect(journey?.outcome).toBe('did-not-call');
    expect(journey?.looksClaimable).toBe(true);
    expect(journey?.onwardConnection).toBeNull();
    expect(result.failures.some((f) => f.date === '2026-09-07')).toBe(true);
  });
});

describe('a journey with a change', () => {
  const DAY = '2026-09-07';

  function callAt(location: string, fields: Partial<ServiceRecord['calls'][number]>) {
    return {
      location,
      scheduledDeparture: null,
      scheduledArrival: null,
      actualDeparture: null,
      actualArrival: null,
      lateCancReason: null,
      ...fields,
    };
  }

  /** Brighton 07:00, due into Clapham Junction 07:52, in at 08:05. */
  const FIRST: ServiceRecord = {
    rid: '202609071000001',
    date: DAY,
    tocCode: 'SN',
    calls: [
      callAt('BTN', { scheduledDeparture: '0700', actualDeparture: '0700' }),
      callAt('CLJ', { scheduledArrival: '0752', actualArrival: '0805' }),
    ],
  };

  function onward(rid: string, date: string, toc: string, dep: string, arr: string): ServiceRecord {
    return {
      rid,
      date,
      tocCode: toc,
      calls: [
        callAt('CLJ', { scheduledDeparture: dep, actualDeparture: dep }),
        callAt('KPA', { scheduledArrival: arr, actualArrival: arr }),
      ],
    };
  }

  const RECORDS: Record<string, ServiceRecord> = {
    [FIRST.rid]: FIRST,
    '202609072000001': onward('202609072000001', DAY, 'SW', '0811', '0822'),
    '202609072000002': onward('202609072000002', DAY, 'SN', '0838', '0849'),
    '202609082000002': onward('202609082000002', '2026-09-08', 'SN', '0838', '0849'),
  };

  function changeClient(options: { connectionsThrow?: unknown; detailThrows?: string } = {}) {
    const queries: string[] = [];
    const details: string[] = [];
    const client = {
      async serviceMetrics(query: { fromLocation: string; toLocation: string; fromTime: string; toTime: string }) {
        queries.push(`${query.fromLocation}-${query.toLocation}@${query.fromTime}-${query.toTime}`);
        if (query.fromLocation === 'CLJ') {
          if (options.connectionsThrow) throw options.connectionsThrow;
          return [
            { rids: ['202609072000001'], originLocation: 'CLJ', destinationLocation: 'KPA', scheduledDeparture: '0811', scheduledArrival: '0822', tocCode: 'SW' },
            { rids: ['202609072000002', '202609082000002'], originLocation: 'CLJ', destinationLocation: 'KPA', scheduledDeparture: '0838', scheduledArrival: '0849', tocCode: 'SN' },
          ];
        }
        return [
          { rids: [FIRST.rid], originLocation: 'BTN', destinationLocation: 'CLJ', scheduledDeparture: '0700', scheduledArrival: '0752', tocCode: 'SN' },
        ];
      },
      async serviceDetails(rid: string) {
        details.push(rid);
        if (rid === options.detailThrows) throw new HspError('unavailable', 'down');
        const record = RECORDS[rid];
        if (!record) throw new HspError('unknown', `no fixture for ${rid}`);
        return record;
      },
    } as unknown as HspClient;
    return { client, queries, details };
  }

  const request: ScanRequest = {
    ...REQUEST,
    via: 'CLJ',
    to: 'KPA',
    fromDate: DAY,
    toDate: DAY,
    fromTime: '0655',
    toTime: '0705',
    scheduledDeparture: '0700',
  };

  it('pins the first train as far as the change, then asks about the trains onward', async () => {
    const { client, queries } = changeClient();
    await runScan(client, request);
    expect(queries[0]).toBe('BTN-CLJ@0655-0705');
    // From 30 minutes before the earliest arrival (07:52 due) to the longest wait
    // after the latest (08:05 in, plus 90 and 15 for the change): an hour at a time.
    expect(queries.slice(1)).toEqual([
      'CLJ-KPA@0722-0821',
      'CLJ-KPA@0822-0921',
      'CLJ-KPA@0922-0950',
    ]);
  });

  it('scores the whole journey at the destination', async () => {
    const { client } = changeClient();
    const result = await runScan(client, request);
    const journey = result.assessments[0];

    // Planned: into CLJ 07:52, the 08:11, due KPA 08:22. In at 08:05, which is
    // 6 minutes - under CLJ's 10 onto the Overground - so the 08:38, in at 08:49.
    expect(journey?.via).toBe('CLJ');
    expect(journey?.change?.planned?.scheduledDeparture).toBe('0811');
    expect(journey?.delayMinutes).toBe(27);
    expect(journey?.change?.responsibleTocCode).toBe('SN');
    expect(journey?.looksClaimable).toBe(true);
  });

  it('does not fetch or use London Overground trains onward', async () => {
    const overground = {
      rids: ['202609073000001'],
      originLocation: 'CLJ',
      destinationLocation: 'KPA',
      scheduledDeparture: '0815',
      scheduledArrival: '0826',
      tocCode: 'LO',
    };
    const { client, details } = changeClient();
    const withOverground = {
      ...client,
      async serviceMetrics(query: { fromLocation: string }) {
        const result = await client.serviceMetrics(query as never);
        return query.fromLocation === 'CLJ' ? [...result, overground] : result;
      },
      serviceDetails: client.serviceDetails,
    } as unknown as HspClient;

    const result = await runScan(withOverground, request);
    expect(details).not.toContain('202609073000001');
    expect(result.assessments[0]?.change?.caught?.rid).toBe('202609072000002');
    expect(result.assessments[0]?.notes.join(' ')).toContain('London Overground trains from CLJ to KPA are left out');
  });

  it('fetches only the onward trains that ran on the day being checked', async () => {
    const { client, details } = changeClient();
    await runScan(client, request);
    expect(details).toContain('202609072000002');
    expect(details).not.toContain('202609082000002');
  });

  it('reports the day as unchecked when the trains onward cannot be read', async () => {
    const { client } = changeClient({ connectionsThrow: new HspError('unavailable', 'down') });
    const result = await runScan(client, request);

    expect(result.assessments).toEqual([]);
    expect(result.coverage.checked).toBe(0);
    expect(result.failures.some((f) => f.date === DAY && f.message.includes('onward from CLJ'))).toBe(true);
  });

  it('will not score a day on a partial list of trains onward', async () => {
    // Losing one onward train could hide the one that was caught.
    const { client } = changeClient({ detailThrows: '202609072000001' });
    const result = await runScan(client, request);

    expect(result.assessments).toEqual([]);
    expect(result.failures.some((f) => f.date === DAY)).toBe(true);
  });
});
