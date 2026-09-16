/**
 * Train operating companies, keyed by the TOC code HSP returns.
 *
 * Two fields are facts about an operator's published compensation policy:
 * `minimumDelayMinutes` and `claimUrl`. Both change without notice, and both
 * are load-bearing for trust - a wrong threshold silently loses the user money,
 * and a wrong claim link in a product whose entire value is trustworthiness is
 * worse than no link at all. So each carries where and when it was read.
 *
 * Read 2026-09-16/17, in this order of preference:
 *
 * 1. The operator's own Delay Repay page or conditions, where it could be
 *    fetched. Both fields come from there.
 * 2. Where the operator's site refuses automated reading (East Midlands
 *    Railway, Greater Anglia, Northern, ScotRail, CrossCountry) or its page
 *    could not be found (Grand Central, Hull Trains, Merseyrail): the Office of
 *    Rail and Road's table of each operator's scheme, in its delay compensation
 *    factsheet for rail periods 11-13 (published 25 June 2026, "as at 31 March
 *    2026"). That gives the threshold but no claim page, so `claimUrl` stays
 *    null, and `caveat` tells the user the figure came from the regulator. The
 *    ORR table agreed with every operator page that could be read directly.
 *
 * `caveat` carries anything else a user needs before claiming: TfL's schemes
 * only pay for delays within TfL's control, and one TOC code can cover two
 * brands with different claim pages.
 *
 * A threshold is the shortest delay that pays. Where a scheme pays for "more
 * than 30 minutes" rather than "30 minutes or more", it is recorded as 31.
 *
 * TOC codes themselves are stable industry identifiers and are safe to hardcode;
 * each one here was checked against the RDG timetable feed.
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
  /**
   * Something a user must know before claiming from this operator, shown with
   * every result scored against it. Null when there is nothing to add.
   */
  readonly caveat: string | null;
}

function pending(code: string, name: string): Operator {
  return {
    code,
    name,
    minimumDelayMinutes: null,
    claimUrl: null,
    policyLastConfirmed: null,
    policySource: null,
    caveat: null,
  };
}

/** Read from the operator's own published terms. */
function fromOperator(
  code: string,
  name: string,
  minimumDelayMinutes: number,
  claimUrl: string,
  policySource: string = claimUrl,
  caveat: string | null = null,
): Operator {
  return {
    code,
    name,
    minimumDelayMinutes,
    claimUrl,
    policyLastConfirmed: '2026-09-17',
    policySource,
    caveat,
  };
}

const ORR_FACTSHEET =
  'https://dataportal.orr.gov.uk/media/ittbwvrh/delay-compensation-claims-factsheet-2025-26-rail-periods-11-13.pdf';

/**
 * Read from the Office of Rail and Road's table, because the operator's own
 * page could not be. No claim link: one that has not been read is not given.
 */
function fromRegulator(
  code: string,
  name: string,
  minimumDelayMinutes: number,
  scheme: string,
): Operator {
  return {
    code,
    name,
    minimumDelayMinutes,
    claimUrl: null,
    policyLastConfirmed: '2026-09-17',
    policySource: `${ORR_FACTSHEET} (${scheme})`,
    caveat:
      `${name}'s ${minimumDelayMinutes}-minute threshold comes from the rail regulator's ` +
      `list of compensation schemes, not from ${name}'s own site. Check their terms ` +
      'before claiming.',
  };
}

const TFL_REFUND_PAGE = 'https://tfl.gov.uk/fares/refunds/apply-for-a-service-delay-refund';
const TFL_CAVEAT =
  "This is TfL's scheme, not National Rail Delay Repay: it pays for delays of more " +
  'than 30 minutes, and not for delays TfL treats as outside its control, such as ' +
  'strikes, bad weather, engineering works or a passenger being taken ill.';

const OPERATOR_LIST: readonly Operator[] = [
  // "arrive at your destination station more than 15 minutes later", but the
  // compensation table and FAQ both start at "15 minutes or more".
  fromOperator('AW', 'Transport for Wales', 15, 'https://tfw.wales/help-and-contact/rail/delay-repay'),
  // The page says "more than 15 minutes" and gives no table; the ORR lists c2c
  // as Delay Repay 15, whose bands start at 15.
  fromOperator(
    'CC',
    'c2c',
    15,
    'https://www.c2c-online.co.uk/help-feedback/delay-repay/',
    `https://www.c2c-online.co.uk/help-feedback/delay-repay/; ${ORR_FACTSHEET}`,
  ),
  // Compensation table: "0-14 minutes None", "15-29 minutes 25%".
  fromOperator('CH', 'Chiltern Railways', 15, 'https://www.chilternrailways.co.uk/compensation'),
  // "If your journey with Caledonian Sleeper is delayed by 30 minutes or more".
  fromOperator('CS', 'Caledonian Sleeper', 30, 'https://www.sleeper.scot/help-support/after-your-trip/'),
  fromRegulator('EM', 'East Midlands Railway', 15, 'Delay Repay 15'),
  fromRegulator('GC', 'Grand Central', 60, 'its own scheme, 60+ minutes'),
  // GTR, like Thameslink and Southern: "15 minutes or more".
  fromOperator('GN', 'Great Northern', 15, 'https://www.greatnorthernrail.com/help-and-support/delay-repay-compensation'),
  // "If your LNER train is delayed by more than 30 minutes", but the table
  // starts "30-59 minutes" and the heading says "30 minutes or more".
  fromOperator('GR', 'LNER', 30, 'https://www.lner.co.uk/support/delay-repay/'),
  // "15 - 29 minutes 25%"; "we were unable to find a delay of 15 minutes or more".
  fromOperator('GW', 'Great Western Railway', 15, 'https://www.gwr.com/help-and-support/refunds-and-compensation/delay-repay'),
  fromOperator('GX', 'Gatwick Express', 15, 'https://www.gatwickexpress.com/help-and-support/delay-repay-compensation'),
  fromRegulator('HT', 'Hull Trains', 30, 'Delay Repay 30'),
  // Conditions of Carriage, for tickets bought after 20 July 2026, section 6.1:
  // "more than 30 minutes later than scheduled", but the table pays from "30 to
  // 59 minutes". Recorded as 30, the reading that does not miss a claim. No
  // claim page was found; the conditions are the source.
  {
    code: 'HX',
    name: 'Heathrow Express',
    minimumDelayMinutes: 30,
    claimUrl: null,
    policyLastConfirmed: '2026-09-17',
    policySource: 'https://www.heathrowexpress.com/docs/heathrow-express-conditions-of-carriage-july-2026.pdf',
    caveat:
      "Heathrow Express runs its own Delay Compensation Scheme, and its conditions say " +
      'both "more than 30 minutes" and "30 to 59 minutes". Check them before claiming.',
  },
  // "When your journey with us is delayed by 30 minutes or more".
  fromOperator('LD', 'Lumo', 30, 'https://www.lumo.co.uk/help/delay-repay'),
  fromRegulator('LE', 'Greater Anglia', 15, 'Delay Repay 15'),
  // One TOC code for both West Midlands Trains brands. The West Midlands
  // Railway page was read ("at least 15 minutes late"); London Northwestern's
  // refused automated reading, and the ORR lists the company as Delay Repay 15.
  fromOperator(
    'LM',
    'West Midlands Railway',
    15,
    'https://www.westmidlandsrailway.co.uk/about-us/delay-repay',
    `https://www.westmidlandsrailway.co.uk/about-us/delay-repay; ${ORR_FACTSHEET}`,
    'If this was a London Northwestern Railway train, claim through London Northwestern ' +
      'instead - it is the same company under another name.',
  ),
  // TfL: "More than 30 minutes on London Overground and Elizabeth line services".
  fromOperator('LO', 'London Overground', 31, TFL_REFUND_PAGE, TFL_REFUND_PAGE, TFL_CAVEAT),
  fromRegulator('ME', 'Merseyrail', 30, 'its own scheme, 30+ minutes'),
  fromRegulator('NT', 'Northern', 15, 'Delay Repay 15'),
  // "If you arrive 15 minutes or more late at your destination".
  fromOperator('SE', 'Southeastern', 15, 'https://www.southeasternrailway.co.uk/help/refunds-and-compensation/delay-repay-compensation'),
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
    caveat: null,
  },
  fromRegulator('SR', 'ScotRail', 30, 'Delay Repay 30'),
  // "If you are delayed by 15 minutes or longer when you travel with us".
  fromOperator('SW', 'South Western Railway', 15, 'https://www.southwesternrailway.com/contact-and-help/delay-repay'),
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
    caveat: null,
  },
  // "reached your destination 15 or more minutes late".
  fromOperator('TP', 'TransPennine Express', 15, 'https://www.tpexpress.co.uk/help/delay-repay-compensation'),
  // "You can claim Delay Repay if your journey has been delayed by 15 minutes or more".
  fromOperator('VT', 'Avanti West Coast', 15, 'https://www.avantiwestcoast.co.uk/help-and-support/delay-repay'),
  fromRegulator('XC', 'CrossCountry', 30, 'Delay Repay 30'),
  fromOperator('XR', 'Elizabeth line', 31, TFL_REFUND_PAGE, TFL_REFUND_PAGE, TFL_CAVEAT),
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
