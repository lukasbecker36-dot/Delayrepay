/**
 * HSP failures, typed so a scan can carry on around them.
 *
 * The user has typed in a route and a date range. If HSP is slow, rate-limiting
 * us, or down, that input must survive: the scan degrades to partial results
 * with the gaps named, rather than throwing the lot away.
 */

export type HspFailureKind =
  /** Credentials missing, wrong, or not subscribed to HSP. Not retryable. */
  | 'auth'
  /** HSP asked us to slow down. Retryable. */
  | 'rate-limited'
  /** HSP returned 5xx. Retryable. */
  | 'unavailable'
  /** Connection failed or timed out. Retryable. */
  | 'network'
  /** HSP answered, but not in a shape we understand. Not retryable. */
  | 'malformed'
  /** Anything else. Not retryable. */
  | 'unknown';

export class HspError extends Error {
  override readonly name = 'HspError';
  readonly kind: HspFailureKind;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(
    kind: HspFailureKind,
    message: string,
    options: { status?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryable =
      kind === 'rate-limited' || kind === 'unavailable' || kind === 'network';
  }
}

/** What to tell the user, without blaming them for an upstream outage. */
export function describeHspFailure(error: HspError): string {
  switch (error.kind) {
    case 'auth':
      return (
        'The performance data service rejected our credentials. Check HSP_EMAIL and ' +
        'HSP_PASSWORD, and that the account has the Historical Service Performance ' +
        'subscription enabled.'
      );
    case 'rate-limited':
      return 'The performance data service is rate-limiting us. Your scan is saved; try again shortly.';
    case 'unavailable':
      return 'The performance data service is having problems. Your scan is saved; try again shortly.';
    case 'network':
      return 'We could not reach the performance data service. Your scan is saved; try again shortly.';
    case 'malformed':
      return 'The performance data service returned something we could not read.';
    case 'unknown':
      return 'Something went wrong reading the performance data.';
  }
}
