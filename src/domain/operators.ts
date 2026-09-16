/**
 * Train operating companies, keyed by the TOC code HSP returns.
 *
 * Two fields here are deliberately unpopulated: `minimumDelayMinutes` and
 * `claimUrl`. Both are facts about an operator's published Delay Repay policy
 * that change without notice, and both are load-bearing for trust - a wrong
 * threshold silently loses the user money, and a wrong claim link in a product
 * whose entire value is trustworthiness is worse than no link at all.
 *
 * So they start null and must be filled in from the operator's own published
 * terms, with the date checked recorded. Until then the scan falls back to
 * DEFAULT_MINIMUM_DELAY_MINUTES and says so in the result notes.
 *
 * TOC codes themselves are stable industry identifiers and are safe to hardcode.
 */

/**
 * Threshold used when an operator's own has not been confirmed.
 *
 * Set to the lower of the two common scheme minimums. Over-flagging costs the
 * user a moment checking; under-flagging costs them a claim. Every result
 * scored against this default carries a note saying so.
 */
export const DEFAULT_MINIMUM_DELAY_MINUTES = 15;

export interface Operator {
  /** HSP `toc_code`, e.g. "SN". */
  readonly code: string;
  readonly name: string;
  /**
   * Shortest delay this operator pays out on, in minutes. Null until confirmed
   * against the operator's published Delay Repay terms.
   */
  readonly minimumDelayMinutes: number | null;
  /** The operator's own Delay Repay claim page. Null until confirmed. */
  readonly claimUrl: string | null;
  /** YYYY-MM-DD the two fields above were last checked. */
  readonly policyLastConfirmed: string | null;
  /** Where they were checked, so the next person can recheck them. */
  readonly policySource: string | null;
}

function pending(code: string, name: string): Operator {
  return {
    code,
    name,
    minimumDelayMinutes: null,
    claimUrl: null,
    policyLastConfirmed: null,
    policySource: null,
  };
}

const OPERATOR_LIST: readonly Operator[] = [
  pending('AW', 'Transport for Wales'),
  pending('CC', 'c2c'),
  pending('CH', 'Chiltern Railways'),
  pending('EM', 'East Midlands Railway'),
  pending('GC', 'Grand Central'),
  pending('GN', 'Great Northern'),
  pending('GR', 'London North Eastern Railway'),
  pending('GW', 'Great Western Railway'),
  pending('GX', 'Gatwick Express'),
  pending('HT', 'Hull Trains'),
  pending('LD', 'Lumo'),
  pending('LE', 'Greater Anglia'),
  pending('LM', 'West Midlands Trains'),
  pending('LO', 'London Overground'),
  pending('ME', 'Merseyrail'),
  pending('NT', 'Northern'),
  pending('SE', 'Southeastern'),
  {
    code: 'SN',
    name: 'Southern',
    // Read at source on 2026-09-16. Southern is a GTR brand and runs under the
    // same Passenger's Charter as Thameslink: section 14 sets the 15-minute
    // threshold for all GTR services and lists this claim page for Southern.
    minimumDelayMinutes: 15,
    claimUrl: 'https://www.southernrailway.com/delayrepay',
    policyLastConfirmed: '2026-09-16',
    policySource:
      'https://www.thameslinkrailway.com/-/media/gtr/files/passenger_charter.pdf (section 14)',
  },
  pending('SR', 'ScotRail'),
  pending('SW', 'South Western Railway'),
  {
    code: 'TL',
    name: 'Thameslink',
    // Read at source on 2026-09-16, from GTR's Passenger's Charter section 14
    // ("if your journey is delayed by 15 minutes or more ... you're entitled to
    // claim compensation") and the Thameslink Delay Repay page ("If you arrive
    // 15 minutes or more late at your destination"). The claim link is the one
    // the Charter lists for Thameslink.
    //
    // An earlier version of this entry carried the same figures with a
    // confirmed date when they had only come from search summaries. The date
    // below is the real one; recheck both fields against policySource when it
    // goes stale.
    minimumDelayMinutes: 15,
    claimUrl: 'https://www.thameslinkrailway.com/delayrepay',
    policyLastConfirmed: '2026-09-16',
    policySource:
      'https://www.thameslinkrailway.com/-/media/gtr/files/passenger_charter.pdf ' +
      '(section 14); https://www.thameslinkrailway.com/help-and-support/delay-repay',
  },
  pending('TP', 'TransPennine Express'),
  pending('VT', 'Avanti West Coast'),
  pending('XC', 'CrossCountry'),
];

const BY_CODE = new Map(OPERATOR_LIST.map((operator) => [operator.code, operator]));

export function findOperator(tocCode: string | null | undefined): Operator | null {
  if (!tocCode) return null;
  return BY_CODE.get(tocCode.trim().toUpperCase()) ?? null;
}

export function allOperators(): readonly Operator[] {
  return OPERATOR_LIST;
}

export interface ResolvedThreshold {
  readonly minutes: number;
  /** False when DEFAULT_MINIMUM_DELAY_MINUTES was used as a stand-in. */
  readonly confirmed: boolean;
  readonly operator: Operator | null;
}

/**
 * The delay threshold to score a service against.
 *
 * `override` wins, then the operator's confirmed policy, then the default.
 */
export function resolveThreshold(
  tocCode: string | null | undefined,
  override?: number | null,
): ResolvedThreshold {
  const operator = findOperator(tocCode);

  if (override != null) {
    return { minutes: override, confirmed: true, operator };
  }
  if (operator?.minimumDelayMinutes != null) {
    return { minutes: operator.minimumDelayMinutes, confirmed: true, operator };
  }
  return { minutes: DEFAULT_MINIMUM_DELAY_MINUTES, confirmed: false, operator };
}
