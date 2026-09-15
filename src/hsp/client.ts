/**
 * The HSP client.
 *
 * HSP sends no Access-Control-Allow-Origin header, so it cannot be called from
 * browser JavaScript at all. Every call goes through here, server-side, which is
 * where the credentials belong regardless.
 */

import { HspError } from './errors.js';
import {
  parseServiceDetails,
  parseServiceMetrics,
  HspSchemaError,
  type MatchedService,
} from './schema.js';
import type { ServiceRecord } from '../domain/types.js';

export const DEFAULT_BASE_URL = 'https://hsp-prod.rockshore.net/api/v1';

/** Which days of the week a serviceMetrics query covers. */
export type DayType = 'WEEKDAY' | 'SATURDAY' | 'SUNDAY';

export interface ServiceMetricsQuery {
  /** Origin CRS. */
  readonly fromLocation: string;
  /** Destination CRS. */
  readonly toLocation: string;
  /** Start of the departure time band, "HHMM". */
  readonly fromTime: string;
  /** End of the departure time band, "HHMM". */
  readonly toTime: string;
  /** YYYY-MM-DD. */
  readonly fromDate: string;
  /** YYYY-MM-DD. */
  readonly toDate: string;
  readonly days: DayType;
}

export interface HspClientOptions {
  readonly email: string;
  readonly password: string;
  readonly baseUrl?: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Attempts per request, including the first. */
  readonly maxAttempts?: number;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests; called between retries. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 4;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HspClient {
  readonly #authorization: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: HspClientOptions) {
    if (!options.email || !options.password) {
      throw new HspError('auth', 'HSP credentials are required.');
    }
    this.#authorization = `Basic ${Buffer.from(
      `${options.email}:${options.password}`,
    ).toString('base64')}`;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Services matching a station pair, time band and date range.
   *
   * Keep the time band narrow. At a busy station a wide band returns a response
   * large enough to be unusable.
   */
  async serviceMetrics(query: ServiceMetricsQuery): Promise<readonly MatchedService[]> {
    const payload = await this.#post('serviceMetrics', {
      from_loc: query.fromLocation,
      to_loc: query.toLocation,
      from_time: query.fromTime,
      to_time: query.toTime,
      from_date: query.fromDate,
      to_date: query.toDate,
      days: query.days,
    });
    return this.#parse(() => parseServiceMetrics(payload));
  }

  /** One service, by RID, with its recorded times. */
  async serviceDetails(rid: string): Promise<ServiceRecord> {
    const payload = await this.#post('serviceDetails', { rid });
    return this.#parse(() => parseServiceDetails(payload));
  }

  #parse<T>(parse: () => T): T {
    try {
      return parse();
    } catch (error) {
      if (error instanceof HspSchemaError) {
        throw new HspError('malformed', error.message, { cause: error });
      }
      throw error;
    }
  }

  async #post(path: string, body: Record<string, unknown>): Promise<unknown> {
    let lastError: HspError | null = null;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        return await this.#postOnce(path, body);
      } catch (error) {
        if (!(error instanceof HspError) || !error.retryable) throw error;
        lastError = error;
        if (attempt < this.#maxAttempts) {
          // 2s, 4s, 8s.
          await this.#sleep(2 ** attempt * 1000);
        }
      }
    }

    throw lastError ?? new HspError('unknown', `${path} failed`);
  }

  async #postOnce(path: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.#authorization,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      throw new HspError(
        'network',
        timedOut
          ? `${path} timed out after ${this.#timeoutMs}ms`
          : `${path} could not reach HSP`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new HspError(statusToKind(response.status), `${path} returned ${response.status}`, {
        status: response.status,
      });
    }

    try {
      return await response.json();
    } catch (error) {
      throw new HspError('malformed', `${path} returned invalid JSON`, { cause: error });
    }
  }
}

function statusToKind(status: number): 'auth' | 'rate-limited' | 'unavailable' | 'unknown' {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'unavailable';
  return 'unknown';
}

/** Builds a client from the environment. Credentials never live anywhere else. */
export function clientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<HspClientOptions> = {},
): HspClient {
  const email = env['HSP_EMAIL'];
  const password = env['HSP_PASSWORD'];
  if (!email || !password) {
    throw new HspError(
      'auth',
      'HSP_EMAIL and HSP_PASSWORD must be set. Copy .env.example to .env and fill them in.',
    );
  }
  const baseUrl = env['HSP_BASE_URL'];
  return new HspClient({
    email,
    password,
    ...(baseUrl ? { baseUrl } : {}),
    ...overrides,
  });
}
