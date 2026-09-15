/**
 * HSP failures, typed so a scan can carry on around them.
 *
 * The user has typed in a route and a date range. If HSP is slow, rate-limiting
 * us, or down, that input must survive: the scan degrades to partial results
 * with the gaps named, rather than throwing the lot away.
 *
 * The kinds are deliberately finer-grained than the HTTP statuses suggest. A
 * wrong diagnosis sends the user to fix the wrong thing, and "your credentials
 * were rejected" is the most expensive wrong diagnosis available here - it is
 * the one message that makes someone go and rotate a password that was fine.
 */

export type HspFailureKind =
  /** Credentials missing, or HSP said 401. Not retryable. */
  | 'auth'
  /**
   * Something refused the request outright (403).
   *
   * Not the same as 'auth'. A 403 can come from HSP - an account without the
   * Historical Service Performance subscription - but it can equally come from
   * something in between: a corporate proxy, a sandbox egress allowlist, a WAF.
   * In every one of those cases the credentials were never tested, so saying
   * they were rejected is a guess dressed up as a finding.
   */
  | 'blocked'
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
  /**
   * What the far end actually said, trimmed and stripped of credentials.
   *
   * Worth keeping: when a proxy refuses the call it usually names itself and
   * the host it blocked, which is the whole diagnosis in one line. Discarding
   * the body and reporting only the status is how a blocked host gets
   * misread as a bad password.
   */
  readonly detail: string | null;

  constructor(
    kind: HspFailureKind,
    message: string,
    options: { status?: number | null; detail?: string | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.status = options.status ?? null;
    this.detail = options.detail ?? null;
    this.retryable =
      kind === 'rate-limited' || kind === 'unavailable' || kind === 'network';
  }
}

/** What to tell the user, without blaming them for an upstream outage. */
export function describeHspFailure(error: HspError): string {
  return withDetail(baseDescription(error), error.detail);
}

function baseDescription(error: HspError): string {
  switch (error.kind) {
    case 'auth':
      return (
        'The performance data service rejected our credentials (HTTP 401). Check ' +
        'HSP_EMAIL and HSP_PASSWORD.'
      );
    case 'blocked':
      return (
        'The request to the performance data service was refused (HTTP 403). This is ' +
        'not the same as a wrong password - the credentials were never accepted or ' +
        'rejected. The usual causes are an account without the Historical Service ' +
        'Performance subscription, or a proxy, firewall or egress allowlist between ' +
        'here and HSP blocking the call.'
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

function withDetail(description: string, detail: string | null): string {
  if (!detail) return description;
  return `${description} The response said: "${detail}"`;
}
