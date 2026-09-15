import { describe, expect, it } from 'vitest';
import { classifyJourney } from '../src/domain/classify.js';
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
const AWAITING = classifyJourney({
  record: null,
  from: 'BTN',
  to: 'VIC',
  date: TODAY,
  today: TODAY,
  dataMayBeIncomplete: true,
});

const EVERY_OUTCOME = [DELAYED, CANCELLED, ON_TIME, NOT_FOUND, AWAITING];

describe('the words the tool is allowed to use', () => {
  it('covers every outcome the classifier can produce', () => {
    // If a new outcome is added, this test must be updated before the guard
    // below can claim to have checked it.
    expect(new Set(EVERY_OUTCOME.map((a) => a.outcome))).toEqual(
      new Set([
        'delayed',
        'arrival-not-recorded',
        'within-threshold',
        'service-not-found',
        'awaiting-data',
      ]),
    );
  });

  it('says a journey looks claimable, and never that a claim is valid', () => {
    expect(describeOutcome(DELAYED)).toContain('looks claimable');
    expect(describeOutcome(CANCELLED)).toContain('looks claimable');
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
      summariseScan(EVERY_OUTCOME),
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
    const summary = summariseScan(EVERY_OUTCOME);
    expect(summary).toContain('2 journeys look claimable');
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
