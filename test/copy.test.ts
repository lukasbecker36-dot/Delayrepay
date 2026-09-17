import { describe, expect, it } from 'vitest';
import { classifyJourney } from '../src/domain/classify.js';
import { classifyJourneyWithChange } from '../src/domain/classifyChange.js';
import {
  describeExpiry,
  describeOutcome,
  describeWhereToClaim,
  summariseScan,
} from '../src/domain/copy.js';
import { claimWindowFor, type ClaimWindow } from '../src/domain/window.js';
import type { JourneyAssessment, ServiceCall, ServiceRecord } from '../src/domain/types.js';

const TODAY = '2026-09-15';

function call(location: string, fields: Partial<ServiceCall> = {}): ServiceCall {
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

function assess(calls: readonly ServiceCall[] | null, date = '2026-09-08'): JourneyAssessment {
  const record: ServiceRecord | null =
    calls === null ? null : { rid: 'R1', date, tocCode: 'SN', calls };
  return classifyJourney({ record, from: 'BTN', to: 'VIC', date, today: TODAY });
}

const DELAYED = assess([
  call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
  call('VIC', { scheduledArrival: '0817', actualArrival: '0851' }),
]);
const CANCELLED = assess([
  call('BTN', { scheduledDeparture: '0715' }),
  call('VIC', { scheduledArrival: '0817' }),
]);
const ON_TIME = assess([
  call('BTN', { scheduledDeparture: '0715', actualDeparture: '0716' }),
  call('VIC', { scheduledArrival: '0817', actualArrival: '0819' }),
]);
const NOT_FOUND = assess(null);
const DID_NOT_CALL = classifyJourney({
  record: {
    rid: 'R2',
    date: '2026-09-03',
    tocCode: 'SN',
    calls: [
      call('BTN', { scheduledDeparture: '0715', actualDeparture: '0716', scheduledArrival: '0714' }),
      call('HHE', { scheduledArrival: '0740', actualArrival: '0821' }),
      call('VIC', { scheduledArrival: '0817', lateCancReason: '911' }),
    ],
  },
  from: 'BTN',
  to: 'VIC',
  date: '2026-09-03',
  today: TODAY,
});
const ARRIVED_EARLY = assess([
  call('BTN', { scheduledDeparture: '0715', actualDeparture: '0715' }),
  call('VIC', { scheduledArrival: '0817', actualArrival: '0816' }),
]);
const AWAITING = classifyJourney({
  record: null,
  from: 'BTN',
  to: 'VIC',
  date: TODAY,
  today: TODAY,
  dataMayBeIncomplete: true,
});

const SKIPPED_ORIGIN = assess([
  call('PRP', { scheduledDeparture: '0710', actualDeparture: '0710' }),
  call('BTN', { scheduledDeparture: '0715' }),
  call('VIC', { scheduledArrival: '0817', actualArrival: '0820' }),
]);

const DEPARTED_THEN_VANISHED = assess([
  call('BTN', { scheduledDeparture: '0715', actualDeparture: '0716' }),
  call('VIC', { scheduledArrival: '0817' }),
]);

const EVERY_OUTCOME = [
  DELAYED,
  CANCELLED,
  DEPARTED_THEN_VANISHED,
  DID_NOT_CALL,
  ON_TIME,
  NOT_FOUND,
  AWAITING,
  SKIPPED_ORIGIN,
];

/** A train measured on the way on, so the sentences that quote a total are checked too. */
const WAY_ON = {
  rid: 'on',
  from: 'BTN',
  to: 'VIC',
  departed: '0745',
  arrived: '0850',
  waitMinutes: 30,
  totalDelayMinutes: 33,
  changeMinutes: 0,
  changeTimeFromTimetable: true,
  leftInsideChangeTime: null,
};
const MEASURED_ON_A_WAY_ON = [
  classifyJourney({
    record: { rid: 'c', date: '2026-09-08', tocCode: 'SN', calls: [call('BTN', { scheduledDeparture: '0715' }), call('VIC', { scheduledArrival: '0817' })] },
    from: 'BTN',
    to: 'VIC',
    date: '2026-09-08',
    today: TODAY,
    onwardConnection: WAY_ON,
  }),
  classifyJourney({
    record: {
      rid: 'p',
      date: '2026-09-08',
      tocCode: 'SN',
      calls: [
        call('BTN', { scheduledDeparture: '0715', actualDeparture: '0715' }),
        call('CLJ', { scheduledArrival: '0800', actualArrival: '0801' }),
        call('VIC', { scheduledArrival: '0817' }),
        call('XYZ', { scheduledArrival: '0830', actualArrival: '0830' }),
      ],
    },
    from: 'BTN',
    to: 'VIC',
    date: '2026-09-08',
    today: TODAY,
    onwardConnection: { ...WAY_ON, from: 'CLJ', totalDelayMinutes: 5 },
    carriedPastConnection: { ...WAY_ON, from: 'XYZ', totalDelayMinutes: 40 },
  }),
];

/**
 * Journeys with a change, one per distinct way the connection can go, so their
 * sentences pass the same guard. Brighton to Kensington Olympia via Clapham
 * Junction, all on Southern so every outcome is reachable at one threshold.
 */
function withChange(
  firstArrival: string | null,
  connection: { departed: string | null; arrived: string | null } | null,
  missingOnOtherDays = false,
): JourneyAssessment {
  const onward = (rid: string, toc: string, dep: string, arr: string, actualDep: string | null, actualArr: string | null): ServiceRecord => ({
    rid,
    date: '2026-09-08',
    tocCode: toc,
    calls: [
      call('CLJ', { scheduledDeparture: dep, actualDeparture: actualDep }),
      call('KPA', { scheduledArrival: arr, actualArrival: actualArr }),
    ],
  });
  const records = [onward('late', 'SN', '0838', '0849', '0838', '0849')];
  if (connection !== null) {
    records.push(onward('planned', 'SN', '0811', '0822', connection.departed, connection.arrived));
  }
  const timetable = [
    { tocCode: 'SN', scheduledDeparture: '0811', scheduledArrival: '0822' },
    { tocCode: 'SN', scheduledDeparture: '0838', scheduledArrival: '0849' },
    ...(missingOnOtherDays ? [{ tocCode: 'LO', scheduledDeparture: '0826', scheduledArrival: '0837' }] : []),
  ];
  return classifyJourneyWithChange({
    record: {
      rid: 'first',
      date: '2026-09-08',
      tocCode: 'SN',
      calls: [
        call('BTN', { scheduledDeparture: '0700', actualDeparture: firstArrival === null ? null : '0700' }),
        call('CLJ', { scheduledArrival: '0752', actualArrival: firstArrival }),
      ],
    },
    from: 'BTN',
    via: 'CLJ',
    to: 'KPA',
    date: '2026-09-08',
    today: TODAY,
    timetable,
    onward: records,
    changeTimeFor: () => ({ minutes: 10, fromTimetable: true }),
  });
}

const CHANGE_JOURNEYS = [
  withChange('0752', { departed: '0811', arrived: '0822' }),
  withChange('0805', { departed: '0811', arrived: '0822' }, true),
  withChange('0752', { departed: null, arrived: null }),
  withChange('0752', null),
  withChange('0752', { departed: '0830', arrived: '0841' }),
  withChange(null, { departed: '0811', arrived: '0822' }),
  // Planned connection missing from the data: 57 minutes on the trains recorded,
  // on time if it ran.
  withChange('0752', { departed: '0811', arrived: null }),
  // The first train cancelled, measured on the next one to Clapham Junction.
  classifyJourneyWithChange({
    record: {
      rid: 'first',
      date: '2026-09-08',
      tocCode: 'SN',
      calls: [call('BTN', { scheduledDeparture: '0700' }), call('CLJ', { scheduledArrival: '0752' })],
    },
    from: 'BTN',
    via: 'CLJ',
    to: 'KPA',
    date: '2026-09-08',
    today: TODAY,
    timetable: [{ tocCode: 'SN', scheduledDeparture: '0838', scheduledArrival: '0849' }],
    onward: [
      {
        rid: 'on',
        date: '2026-09-08',
        tocCode: 'SN',
        calls: [
          call('CLJ', { scheduledDeparture: '0838', actualDeparture: '0838' }),
          call('KPA', { scheduledArrival: '0849', actualArrival: '0849' }),
        ],
      },
    ],
    replacementCandidates: [
      {
        rid: 'next',
        date: '2026-09-08',
        tocCode: 'SN',
        calls: [
          call('BTN', { scheduledDeparture: '0730', actualDeparture: '0730' }),
          call('CLJ', { scheduledArrival: '0822', actualArrival: '0822' }),
        ],
      },
    ],
    changeTimeFor: () => ({ minutes: 10, fromTimetable: true }),
  }),
];

describe('the words the tool is allowed to use', () => {
  it('covers every outcome the classifier can produce', () => {
    // If a new outcome is added, this test must be updated before the guard
    // below can claim to have checked it.
    expect(new Set(EVERY_OUTCOME.map((a) => a.outcome))).toEqual(
      new Set([
        'delayed',
        'arrival-not-recorded',
        'cancelled',
        'did-not-call',
        'within-threshold',
        'service-not-found',
        'awaiting-data',
        'skipped-origin',
      ]),
    );
    // Only a journey with a change can be unconfirmed; its sentences are
    // checked through CHANGE_JOURNEYS below.
    expect(CHANGE_JOURNEYS.map((a) => a.outcome)).toContain('unconfirmed');
  });

  it('says a journey looks claimable, and never that a claim is valid', () => {
    expect(describeOutcome(DELAYED)).toContain('looks claimable');
    expect(describeOutcome(CANCELLED)).toContain('looks claimable');
    expect(describeOutcome(DID_NOT_CALL)).toContain('looks claimable');
  });

  it('never says a train arrived a negative number of minutes late', () => {
    // "Arrived -1 minutes late" reads as broken arithmetic, and casts doubt on
    // every figure printed beside it.
    const sentence = describeOutcome(ARRIVED_EARLY);
    expect(sentence).not.toContain('-1');
    expect(sentence).toContain('1 minute early');
  });

  it('describes a terminated service without calling it a delay at the destination', () => {
    const sentence = describeOutcome(DID_NOT_CALL);
    expect(sentence).toContain('did not call at VIC');
    expect(sentence).toContain('last recorded at HHE');
    expect(sentence).toContain('41 minutes late');
    // The arrival delay at VIC is unknown, and must not be implied.
    expect(sentence).not.toContain('Arrived');
  });

  it('never asserts certainty or puts a figure on a claim', () => {
    // The data cannot support either. Copy that implies otherwise is the bug.
    const banned = [
      '£',
      'you are owed',
      'owed to you',
      'you will receive',
      'valid claim',
      'you have a claim',
      'entitled to',
      'guaranteed',
      'compensation of',
      'refund of',
    ];

    const everySentence = [
      ...EVERY_OUTCOME.flatMap((assessment) => [
        describeOutcome(assessment),
        describeWhereToClaim(assessment),
        ...assessment.notes,
      ]),
      ...['2026-08-01', '2026-08-18', '2026-09-12', '2026-09-15'].map((journeyDate) =>
        describeExpiry(claimWindowFor(journeyDate, TODAY)),
      ),
      ...MEASURED_ON_A_WAY_ON.flatMap((assessment) => [
        describeOutcome(assessment),
        describeWhereToClaim(assessment),
        ...assessment.notes,
      ]),
      ...CHANGE_JOURNEYS.flatMap((assessment) => [
        describeOutcome(assessment),
        describeWhereToClaim(assessment),
        ...assessment.notes,
      ]),
      summariseScan(EVERY_OUTCOME),
      summariseScan(CHANGE_JOURNEYS),
      describeOutcome(ARRIVED_EARLY),
      summariseScan([ON_TIME]),
      summariseScan([]),
      summariseScan([], { expected: 5, checked: 0 }),
      summariseScan([], { expected: 0, checked: 0 }),
      summariseScan([ON_TIME], { expected: 5, checked: 1 }),
    ];

    for (const sentence of everySentence) {
      for (const phrase of banned) {
        expect(sentence.toLowerCase()).not.toContain(phrase.toLowerCase());
      }
    }
  });
});

describe('describeExpiry', () => {
  const window = (daysRemaining: number): ClaimWindow => ({
    journeyDate: '2026-09-01',
    expiresOn: '2026-09-29',
    daysRemaining,
    status: daysRemaining < 0 ? 'expired' : daysRemaining <= 3 ? 'expiring-soon' : 'open',
  });

  it('leads with time to expiry rather than with how long it has sat', () => {
    expect(describeExpiry(window(3))).toBe('Expires in 3 days.');
    expect(describeExpiry(window(14))).toBe('Expires in 14 days.');
  });

  it('handles today and tomorrow without saying "in 0 days"', () => {
    expect(describeExpiry(window(0))).toBe('Expires today.');
    expect(describeExpiry(window(1))).toBe('Expires tomorrow.');
  });

  it('says plainly when the window has closed', () => {
    expect(describeExpiry(window(-1))).toBe('The 28-day claim window closed 1 day ago.');
    expect(describeExpiry(window(-5))).toBe('The 28-day claim window closed 5 days ago.');
  });
});

describe('summariseScan', () => {
  it('is one message covering everything, not one per journey', () => {
    // Delayed, cancelled, left and vanished, stopped short, and a train that did
    // not stop at the origin.
    const summary = summariseScan(EVERY_OUTCOME);
    expect(summary).toContain('5 journeys look claimable');
    expect(summary).toContain('could not be checked');
    expect(summary).toContain('too recent to check yet');
  });

  it('counts a too-recent journey apart from one it genuinely could not check', () => {
    // Conflating the two would tell the user to go and check something that
    // has not happened yet.
    expect(summariseScan([AWAITING])).not.toContain('could not be checked');
    expect(summariseScan([NOT_FOUND])).not.toContain('too recent');
  });

  it('leads with whichever candidate expires first', () => {
    const older = assess(
      [
        call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
        call('VIC', { scheduledArrival: '0817', actualArrival: '0851' }),
      ],
      '2026-08-20',
    );
    expect(summariseScan([DELAYED, older])).toContain('2026-08-20');
  });

  it('says so plainly when there is nothing to claim', () => {
    expect(summariseScan([ON_TIME])).toBe('No journeys in this range look claimable.');
  });

  it('never reports a scan that read nothing as a scan that found nothing', () => {
    // The difference between "we looked and there is nothing to claim" and "we
    // could not look" is the difference between a result and a failure. Blurring
    // them is how someone lets a 28-day window close on a claim they had.
    const summary = summariseScan([], { expected: 5, checked: 0 });

    expect(summary).not.toContain('No journeys in this range look claimable');
    expect(summary).toContain('Nothing could be checked');
    expect(summary).toContain('5 journeys');
  });

  it('leads with incompleteness when only some of the range was read', () => {
    const summary = summariseScan([ON_TIME], { expected: 5, checked: 1 });

    expect(summary.startsWith('Only 1 of 5 journeys')).toBe(true);
    expect(summary).toContain('may be incomplete');
  });

  it('stays a plain finding when the whole range was read', () => {
    expect(summariseScan([ON_TIME], { expected: 1, checked: 1 })).toBe(
      'No journeys in this range look claimable.',
    );
  });

  it('does not claim a failure when there was nothing in range to check', () => {
    expect(summariseScan([], { expected: 0, checked: 0 })).toBe(
      'No journeys in this range to check.',
    );
  });

  it('uses the singular for one journey', () => {
    expect(summariseScan([DELAYED])).toContain('1 journey looks claimable');
  });
});
