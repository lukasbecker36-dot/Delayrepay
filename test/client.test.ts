import { describe, expect, it, vi } from 'vitest';
import { HspClient } from '../src/hsp/client.js';
import { HspError, describeHspFailure } from '../src/hsp/errors.js';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function stubFetch(responses: readonly (() => Promise<Response>)[]) {
  const calls: Call[] = [];
  let index = 0;
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next!();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const status = (code: number) => async () => new Response('', { status: code });

const statusWithBody = (code: number, body: string) => async () =>
  new Response(body, { status: code });

function clientWith(fetchImpl: typeof fetch, overrides = {}) {
  return new HspClient({
    email: 'someone@example.com',
    password: 'hunter2',
    fetchImpl,
    sleep: async () => {},
    ...overrides,
  });
}

const METRICS_QUERY = {
  fromLocation: 'BTN',
  toLocation: 'VIC',
  fromTime: '0700',
  toTime: '0800',
  fromDate: '2026-08-17',
  toDate: '2026-09-14',
  days: 'WEEKDAY',
} as const;

describe('request shape', () => {
  it('posts the field names HSP expects', async () => {
    const { impl, calls } = stubFetch([json({ Services: [] })]);
    await clientWith(impl).serviceMetrics(METRICS_QUERY);

    expect(calls[0]?.url).toBe('https://hsp-prod.rockshore.net/api/v1/serviceMetrics');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      from_loc: 'BTN',
      to_loc: 'VIC',
      from_time: '0700',
      to_time: '0800',
      from_date: '2026-08-17',
      to_date: '2026-09-14',
      days: 'WEEKDAY',
    });
  });

  it('authenticates with basic auth, server-side only', async () => {
    const { impl, calls } = stubFetch([json({ Services: [] })]);
    await clientWith(impl).serviceMetrics(METRICS_QUERY);

    const headers = calls[0]?.init.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from('someone@example.com:hunter2').toString('base64')}`;
    expect(headers['Authorization']).toBe(expected);
  });

  it('honours a base URL override', async () => {
    const { impl, calls } = stubFetch([json({ Services: [] })]);
    await clientWith(impl, { baseUrl: 'https://example.test/api/v1/' }).serviceMetrics(METRICS_QUERY);
    expect(calls[0]?.url).toBe('https://example.test/api/v1/serviceMetrics');
  });
});

describe('failures the scan can recover from', () => {
  it('retries a 5xx and succeeds', async () => {
    const { impl, calls } = stubFetch([status(503), status(503), json({ Services: [] })]);
    await expect(clientWith(impl).serviceMetrics(METRICS_QUERY)).resolves.toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it('retries a rate limit', async () => {
    const { impl, calls } = stubFetch([status(429), json({ Services: [] })]);
    await expect(clientWith(impl).serviceMetrics(METRICS_QUERY)).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('retries a network failure', async () => {
    let attempts = 0;
    const impl = (async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ Services: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(clientWith(impl).serviceMetrics(METRICS_QUERY)).resolves.toEqual([]);
    expect(attempts).toBe(3);
  });

  it('gives up after the configured number of attempts, and says why', async () => {
    const { impl, calls } = stubFetch([status(503)]);
    const error = await clientWith(impl, { maxAttempts: 3 })
      .serviceMetrics(METRICS_QUERY)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HspError);
    expect((error as HspError).kind).toBe('unavailable');
    expect((error as HspError).retryable).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('backs off between attempts rather than hammering a struggling service', async () => {
    const waits: number[] = [];
    const { impl } = stubFetch([status(503)]);
    await clientWith(impl, {
      maxAttempts: 4,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    })
      .serviceMetrics(METRICS_QUERY)
      .catch(() => undefined);

    expect(waits).toEqual([2000, 4000, 8000]);
  });
});

describe('failures the scan cannot recover from', () => {
  it('does not retry bad credentials', async () => {
    const { impl, calls } = stubFetch([status(401)]);
    const error = await clientWith(impl).serviceMetrics(METRICS_QUERY).catch((e: unknown) => e);

    expect((error as HspError).kind).toBe('auth');
    expect((error as HspError).retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('does not blame the credentials for a 403', async () => {
    // A 403 can be HSP refusing an unsubscribed account, or a proxy, firewall or
    // egress allowlist that the request never got past. In none of those cases
    // were the credentials tested, so reporting them as rejected sends the user
    // off to rotate a password that was working.
    const { impl, calls } = stubFetch([status(403)]);
    const error = await clientWith(impl).serviceMetrics(METRICS_QUERY).catch((e: unknown) => e);

    expect((error as HspError).kind).toBe('blocked');
    expect((error as HspError).status).toBe(403);
    expect((error as HspError).retryable).toBe(false);
    expect(calls).toHaveLength(1);

    const described = describeHspFailure(error as HspError);
    expect(described).not.toContain('HSP_PASSWORD');
    expect(described).toContain('not the same as a wrong password');
  });

  it('keeps 401 as a credentials problem', async () => {
    const { impl } = stubFetch([status(401)]);
    const error = await clientWith(impl).serviceMetrics(METRICS_QUERY).catch((e: unknown) => e);

    expect((error as HspError).kind).toBe('auth');
    expect(describeHspFailure(error as HspError)).toContain('HSP_PASSWORD');
  });

  it('keeps what the far end said, which is usually the whole diagnosis', async () => {
    const { impl } = stubFetch([
      statusWithBody(403, 'Host not in allowlist: hsp-prod.rockshore.net.'),
    ]);
    const error = await clientWith(impl).serviceMetrics(METRICS_QUERY).catch((e: unknown) => e);

    expect((error as HspError).detail).toBe('Host not in allowlist: hsp-prod.rockshore.net.');
    expect(describeHspFailure(error as HspError)).toContain('hsp-prod.rockshore.net');
  });

  it('never lets a credential out through an echoed error body', async () => {
    const encoded = Buffer.from('someone@example.com:hunter2').toString('base64');
    const { impl } = stubFetch([
      statusWithBody(403, `Rejected request with Authorization: Basic ${encoded} from someone@example.com`),
    ]);
    const error = await clientWith(impl).serviceMetrics(METRICS_QUERY).catch((e: unknown) => e);

    const detail = (error as HspError).detail ?? '';
    expect(detail).not.toContain(encoded);
    expect(detail).not.toContain('someone@example.com');
    expect(detail).not.toContain('hunter2');
    expect(detail).toContain('[redacted]');
  });

  it('collapses a sprawling error page to one readable line', async () => {
    const { impl } = stubFetch([statusWithBody(500, `<html>\n  <body>\n    ${'x'.repeat(500)}\n  </body>\n</html>`)]);
    const error = await clientWith(impl, { maxAttempts: 1 })
      .serviceMetrics(METRICS_QUERY)
      .catch((e: unknown) => e);

    const detail = (error as HspError).detail ?? '';
    expect(detail).not.toContain('\n');
    expect(detail.length).toBeLessThanOrEqual(303);
    expect(detail.endsWith('...')).toBe(true);
  });

  it('does not retry a response it cannot parse', async () => {
    const { impl, calls } = stubFetch([json({ Services: 'not an array' })]);
    const error = await clientWith(impl).serviceMetrics(METRICS_QUERY).catch((e: unknown) => e);

    expect((error as HspError).kind).toBe('malformed');
    expect(calls).toHaveLength(1);
  });

  it('reports invalid JSON as malformed rather than crashing', async () => {
    const impl = (async () => new Response('<html>down</html>', { status: 200 })) as unknown as typeof fetch;
    const error = await clientWith(impl).serviceMetrics(METRICS_QUERY).catch((e: unknown) => e);
    expect((error as HspError).kind).toBe('malformed');
  });

  it('refuses to be built without credentials', () => {
    expect(() => new HspClient({ email: '', password: '' })).toThrow(HspError);
  });
});

describe('timeouts', () => {
  it('aborts a request that hangs, and reports it as retryable', async () => {
    vi.useFakeTimers();
    try {
      const impl = ((_url: string, init: RequestInit = {}) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch;

      const promise = clientWith(impl, { timeoutMs: 100, maxAttempts: 1 })
        .serviceMetrics(METRICS_QUERY)
        .catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(200);
      const error = await promise;

      expect((error as HspError).kind).toBe('network');
      expect((error as HspError).message).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('serviceDetails', () => {
  it('posts the RID and returns the calls', async () => {
    const { impl, calls } = stubFetch([
      json({
        serviceAttributesDetails: {
          rid: 'R1',
          date_of_service: '2026-09-08',
          toc_code: 'SN',
          locations: [
            { location: 'BTN', gbtt_ptd: '0715', gbtt_pta: '', actual_td: '0718', actual_ta: '', late_canc_reason: '' },
          ],
        },
      }),
    ]);

    const record = await clientWith(impl).serviceDetails('R1');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ rid: 'R1' });
    expect(record.date).toBe('2026-09-08');
    expect(record.calls[0]?.actualDeparture).toBe('0718');
  });
});
