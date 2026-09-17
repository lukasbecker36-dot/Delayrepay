import { describe, expect, it } from 'vitest';
import { classifyJourney } from '../src/domain/classify.js';
import { describeOutcome } from '../src/domain/copy.js';
import type { OnwardConnection } from '../src/domain/onward.js';
import type { ServiceCall, ServiceRecord } from '../src/domain/types.js';

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

function record(calls: readonly ServiceCall[], overrides: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    rid: '202609080591234',
    date: '2026-09-08',
    tocCode: 'SN',
    calls,
    ...overrides,
  };
}

function classify(input: ServiceRecord | null, overrides: Record<string, unknown> = {}) {
  return classifyJourney({
    record: input,
    from: 'BTN',
    to: 'VIC',
    date: '2026-09-08',
    today: TODAY,
    ...overrides,
  });
}

describe('a service that arrived late', () => {
  const late = record([
    call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
    call('VIC', { scheduledArrival: '0817', actualArrival: '0851', lateCancReason: '574' }),
  ]);

  it('measures the delay at the destination, not the origin', () => {
    const result = classify(late, { thresholdMinutes: 15 });
    expect(result.delayMinutes).toBe(34);
    expect(result.outcome).toBe('delayed');
    expect(result.looksClaimable).toBe(true);
    expect(result.evidence).toBe('recorded-times');
  });

  it('carries the times through for the user to check against their memory', () => {
    const result = classify(late, { thresholdMinutes: 15 });
    expect(result.scheduledArrival).toBe('0817');
    expect(result.actualArrival).toBe('0851');
    expect(result.rid).toBe('202609080591234');
  });

  it('is not claimable under a threshold it does not meet', () => {
    const result = classify(late, { thresholdMinutes: 60 });
    expect(result.outcome).toBe('within-threshold');
    expect(result.looksClaimable).toBe(false);
    expect(result.delayMinutes).toBe(34);
  });
});

describe('the threshold boundary', () => {
  function arrivingLateBy(minutes: number): ServiceRecord {
    const arrival = 8 * 60 + 17 + minutes;
    const hh = String(Math.floor(arrival / 60)).padStart(2, '0');
    const mm = String(arrival % 60).padStart(2, '0');
    return record([
      call('BTN', { scheduledDeparture: '0715', actualDeparture: '0715' }),
      call('VIC', { scheduledArrival: '0817', actualArrival: `${hh}${mm}` }),
    ]);
  }

  it('claims at exactly the threshold', () => {
    const result = classify(arrivingLateBy(15), { thresholdMinutes: 15 });
    expect(result.delayMinutes).toBe(15);
    expect(result.looksClaimable).toBe(true);
  });

  it('does not claim one minute under', () => {
    const result = classify(arrivingLateBy(14), { thresholdMinutes: 15 });
    expect(result.delayMinutes).toBe(14);
    expect(result.looksClaimable).toBe(false);
  });

  it('says so when a near miss is close enough to be worth a second look', () => {
    const result = classify(arrivingLateBy(13), { thresholdMinutes: 15 });
    expect(result.looksClaimable).toBe(false);
    expect(result.notes.join(' ')).toContain('trust your memory');
  });

  it('stays quiet about a train that was genuinely fine', () => {
    const result = classify(arrivingLateBy(2), { thresholdMinutes: 15 });
    expect(result.notes).toEqual([]);
  });
});

describe('a service with no times recorded', () => {
  const cancelled = record([
    call('BTN', { scheduledDeparture: '0715', lateCancReason: '574' }),
    call('VIC', { scheduledArrival: '0817', lateCancReason: '574' }),
  ], { date: '2026-09-09' });

  it('is treated as cancelled, and as a candidate', () => {
    const result = classify(cancelled, { thresholdMinutes: 15 });
    expect(result.outcome).toBe('cancelled');
    expect(result.looksClaimable).toBe(true);
    expect(result.delayMinutes).toBeNull();
  });

  it('says plainly that it is treated as cancelled, while recording why', () => {
    const result = classify(cancelled, { thresholdMinutes: 15 });
    expect(result.evidence).toBe('inferred-from-absent-times');
    expect(result.notes.join(' ')).toContain('No times were recorded for this train from BTN onwards');
    expect(result.notes.join(' ')).toContain('treated as cancelled');
  });

  it('says that reason code 574 settles nothing', () => {
    const result = classify(cancelled, { thresholdMinutes: 15 });
    expect(result.notes.join(' ')).toContain('574');
    expect(result.notes.join(' ')).toContain('both');
  });

  it('does not call a train cancelled when it was recorded leaving', () => {
    const departedThenVanished = record([
      call('BTN', { scheduledDeparture: '0715', actualDeparture: '0716' }),
      call('VIC', { scheduledArrival: '0817' }),
    ]);
    const result = classify(departedThenVanished, { thresholdMinutes: 15 });
    expect(result.outcome).toBe('arrival-not-recorded');
    expect(result.looksClaimable).toBe(true);
    expect(result.notes.join(' ')).toContain('left BTN but no arrival was recorded');
    expect(result.notes.join(' ')).not.toContain('cancelled');
  });

  it('still calls it cancelled when the train ran earlier in its journey, before the origin', () => {
    const cancelledBeforeReachingUs = record([
      call('PRP', { scheduledDeparture: '0710', actualDeparture: '0710' }),
      call('BTN', { scheduledDeparture: '0715' }),
      call('VIC', { scheduledArrival: '0817' }),
    ]);
    expect(classify(cancelledBeforeReachingUs, { thresholdMinutes: 15 }).outcome).toBe('cancelled');
  });
});

describe('a service HSP never saw', () => {
  it('is surfaced rather than read as an on-time train', () => {
    const result = classify(null);
    expect(result.outcome).toBe('service-not-found');
    expect(result.looksClaimable).toBe(false);
    expect(result.needsManualCheck).toBe(true);
    expect(result.evidence).toBe('none');
  });

  it('names industrial action as the reason a service can be invisible', () => {
    expect(classify(null).notes.join(' ')).toContain('industrial action');
  });

  it('still reports the claim window, so the date is not lost', () => {
    const result = classify(null);
    expect(result.date).toBe('2026-09-08');
    expect(result.claimWindow.expiresOn).toBe('2026-10-06');
  });

  it('does not bother the user about thresholds for a train it cannot find', () => {
    expect(classify(null).notes.join(' ')).not.toContain('threshold');
  });
});

describe('a journey too recent for the data to have arrived', () => {
  it('says the data has not caught up, rather than that the train vanished', () => {
    const result = classifyJourney({
      record: null,
      from: 'BTN',
      to: 'VIC',
      date: '2026-09-15',
      today: '2026-09-15',
      dataMayBeIncomplete: true,
    });
    expect(result.outcome).toBe('awaiting-data');
    expect(result.notes.join(' ')).toContain('too recent');
    expect(result.notes.join(' ')).not.toContain('industrial action');
  });

  it('asks nothing of the user, because there is nothing yet to check', () => {
    const result = classifyJourney({
      record: null,
      from: 'BTN',
      to: 'VIC',
      date: '2026-09-15',
      today: '2026-09-15',
      dataMayBeIncomplete: true,
    });
    expect(result.looksClaimable).toBe(false);
    expect(result.needsManualCheck).toBe(false);
  });

  it('still reports a service that is there, recent or not', () => {
    const late = record([
      call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
      call('VIC', { scheduledArrival: '0817', actualArrival: '0851' }),
    ]);
    const result = classifyJourney({
      record: late,
      from: 'BTN',
      to: 'VIC',
      date: '2026-09-08',
      today: TODAY,
      dataMayBeIncomplete: true,
      thresholdMinutes: 15,
    });
    expect(result.outcome).toBe('delayed');
  });

  it('falls back to a plain not-found once the data has had time to arrive', () => {
    const result = classifyJourney({
      record: null,
      from: 'BTN',
      to: 'VIC',
      date: '2026-09-08',
      today: TODAY,
      dataMayBeIncomplete: false,
    });
    expect(result.outcome).toBe('service-not-found');
    expect(result.needsManualCheck).toBe(true);
  });
});

describe('picking the right leg', () => {
  it('ignores intermediate stations', () => {
    const viaHaywardsHeath = record([
      call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
      call('HHE', { scheduledArrival: '0732', actualArrival: '0748', scheduledDeparture: '0733', actualDeparture: '0749' }),
      call('VIC', { scheduledArrival: '0817', actualArrival: '0851' }),
    ]);
    const result = classify(viaHaywardsHeath, { thresholdMinutes: 15 });
    expect(result.delayMinutes).toBe(34);
  });

  it('takes the destination call after the origin, not before it', () => {
    // A service that passes through VIC, reverses, and calls again.
    const circular = record([
      call('VIC', { scheduledArrival: '0600', actualArrival: '0601' }),
      call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
      call('VIC', { scheduledArrival: '0817', actualArrival: '0851' }),
    ]);
    const result = classify(circular, { thresholdMinutes: 15 });
    expect(result.delayMinutes).toBe(34);
  });

  it('reports a service that does not serve the route rather than guessing', () => {
    const wrongRoute = record([
      call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
      call('LWS', { scheduledArrival: '0820', actualArrival: '0854' }),
    ]);
    const result = classify(wrongRoute, { thresholdMinutes: 15 });
    expect(result.outcome).toBe('service-not-found');
    expect(result.needsManualCheck).toBe(true);
  });

  it('matches station codes regardless of case or padding', () => {
    const padded = record([
      call(' btn ', { scheduledDeparture: '0715', actualDeparture: '0718' }),
      call('vic', { scheduledArrival: '0817', actualArrival: '0851' }),
    ]);
    expect(classify(padded, { thresholdMinutes: 15 }).delayMinutes).toBe(34);
  });
});

describe('a journey over midnight', () => {
  it('reads a 25-minute delay as 25 minutes, not as most of a day', () => {
    const overnight = record([
      call('BTN', { scheduledDeparture: '2330', actualDeparture: '2332' }),
      call('VIC', { scheduledArrival: '2350', actualArrival: '0015' }),
    ]);
    const result = classify(overnight, { thresholdMinutes: 15 });
    expect(result.delayMinutes).toBe(25);
    expect(result.looksClaimable).toBe(true);
  });
});

describe('a journey on the night the clocks change', () => {
  const nightService = record(
    [
      call('BTN', { scheduledDeparture: '0050', actualDeparture: '0051' }),
      call('VIC', { scheduledArrival: '0155', actualArrival: '0300' }),
    ],
    { date: '2026-03-29' },
  );

  it('is flagged for a manual check rather than scored silently', () => {
    const result = classifyJourney({
      record: nightService,
      from: 'BTN',
      to: 'VIC',
      date: '2026-03-29',
      today: TODAY,
      thresholdMinutes: 15,
    });
    expect(result.needsManualCheck).toBe(true);
    expect(result.notes.join(' ')).toContain('clocks changed');
  });
});

describe('thresholds', () => {
  it('falls back to 15 minutes and says so for an operator it does not know', () => {
    const late = record(
      [
        call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
        call('VIC', { scheduledArrival: '0817', actualArrival: '0837' }),
      ],
      { tocCode: 'ZZ' },
    );
    const result = classify(late);
    expect(result.thresholdMinutes).toBe(15);
    expect(result.thresholdConfirmed).toBe(false);
    expect(result.notes.join(' ')).toContain('No Delay Repay threshold on file');
  });

  it('scores against a 30-minute operator\'s own threshold', () => {
    // LNER pays from 30 minutes. A 20-minute delay is not a candidate.
    const late = record(
      [
        call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
        call('VIC', { scheduledArrival: '0817', actualArrival: '0837' }),
      ],
      { tocCode: 'GR' },
    );
    const result = classify(late);
    expect(result.thresholdMinutes).toBe(30);
    expect(result.thresholdConfirmed).toBe(true);
    expect(result.looksClaimable).toBe(false);
  });

  it('passes on an operator\'s caveat with every result scored against it', () => {
    const late = record(
      [
        call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
        call('VIC', { scheduledArrival: '0817', actualArrival: '0857' }),
      ],
      { tocCode: 'LO' },
    );
    const notes = classify(late).notes.join(' ');
    expect(notes).toContain("TfL's scheme");
    expect(notes).toContain('outside its control');
  });

  it('links to the claim site for an operator whose page was read by hand', () => {
    const late = record(
      [
        call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
        call('VIC', { scheduledArrival: '0817', actualArrival: '0857' }),
      ],
      { tocCode: 'NT' },
    );
    const result = classify(late);
    expect(result.thresholdMinutes).toBe(15);
    expect(result.thresholdConfirmed).toBe(true);
    expect(result.operator?.claimUrl).toBe('https://delayrepay.northernrailway.co.uk/');
  });

  it('scores Grand Central against its one-hour scheme', () => {
    const late = record(
      [
        call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
        call('VIC', { scheduledArrival: '0817', actualArrival: '0907' }),
      ],
      { tocCode: 'GC' },
    );
    const result = classify(late);
    expect(result.delayMinutes).toBe(50);
    expect(result.looksClaimable).toBe(false);
    expect(result.notes.join(' ')).toContain('from a delay of one hour');
  });

  it('names the operator when the TOC code is known', () => {
    const late = record([
      call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
      call('VIC', { scheduledArrival: '0817', actualArrival: '0837' }),
    ]);
    expect(classify(late).operator?.name).toBe('Southern');
  });

  it('uses Thameslink\'s confirmed threshold and claim page without the caveat', () => {
    const late = record(
      [
        call('LBG', { scheduledDeparture: '1835', actualDeparture: '1835' }),
        call('HSK', { scheduledArrival: '1932', actualArrival: '1947' }),
      ],
      { tocCode: 'TL' },
    );
    const result = classify(late, { from: 'LBG', to: 'HSK' });
    expect(result.thresholdMinutes).toBe(15);
    expect(result.thresholdConfirmed).toBe(true);
    expect(result.looksClaimable).toBe(true);
    expect(result.operator?.claimUrl).toBe('https://www.thameslinkrailway.com/delayrepay');
    expect(result.notes.join(' ')).not.toContain('has not been confirmed');
  });

  it('an explicit override counts as confirmed and silences the caveat', () => {
    const late = record([
      call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
      call('VIC', { scheduledArrival: '0817', actualArrival: '0837' }),
    ]);
    const result = classify(late, { thresholdMinutes: 30 });
    expect(result.thresholdConfirmed).toBe(true);
    expect(result.notes.join(' ')).not.toContain('has not been confirmed');
  });
});

describe('a service that ran but abandoned the journey', () => {
  // Modelled on the real 18:35 London Bridge to Hassocks of 2026-09-03: it ran
  // the length of the route, fell 41 minutes down by Haywards Heath, then
  // terminated there and never called at Hassocks. Read only at its endpoints
  // this is indistinguishable from a cancellation, and was reported as one.
  const terminatedShort = record(
    [
      call('LBG', { scheduledDeparture: '1835', actualDeparture: '1834', scheduledArrival: '1834', actualArrival: '1832' }),
      call('GTW', { scheduledArrival: '1904', actualArrival: '1939', scheduledDeparture: '1905', actualDeparture: '1941' }),
      call('HHE', { scheduledArrival: '1921', actualArrival: '2002' }),
      call('HSK', { scheduledArrival: '1932', lateCancReason: '911' }),
    ],
    { date: '2026-09-03', tocCode: 'TL' },
  );

  const assessment = classify(terminatedShort, {
    from: 'LBG',
    to: 'HSK',
    date: '2026-09-03',
  });

  it('does not call it a probable cancellation', () => {
    expect(assessment.outcome).toBe('did-not-call');
    expect(assessment.notes.join(' ')).not.toContain('cancelled');
  });

  it('reports where the train actually got to, and how late it was there', () => {
    expect(assessment.lastRecordedCall).toEqual({
      location: 'HHE',
      time: '2002',
      minutesLate: 41,
    });
  });

  it('keeps that figure out of delayMinutes, which is the delay at the destination', () => {
    // 41 minutes is how late it was somewhere the user was not going. Putting
    // it in delayMinutes would score the journey against a delay it never had.
    expect(assessment.delayMinutes).toBeNull();
  });

  it('says plainly that the figure is not the delay for this journey', () => {
    expect(assessment.notes.join(' ')).toContain('not at HSK');
  });

  it('still surfaces it as a candidate', () => {
    expect(assessment.looksClaimable).toBe(true);
    expect(assessment.needsManualCheck).toBe(true);
  });

  it('hands over a reason code it cannot interpret rather than dropping it', () => {
    expect(assessment.notes.join(' ')).toContain('911');
  });

  it('still reads a genuine cancellation as one', () => {
    // No recorded time anywhere on the route: nothing ran, and there is no
    // late-running to report. This must not become a "did not call".
    const nothingRan = record(
      [
        call('LBG', { scheduledDeparture: '1835', scheduledArrival: '1834' }),
        call('HHE', { scheduledArrival: '1921' }),
        call('HSK', { scheduledArrival: '1932' }),
      ],
      { date: '2026-09-07', tocCode: 'TL' },
    );
    const cancelled = classify(nothingRan, { from: 'LBG', to: 'HSK', date: '2026-09-07' });

    expect(cancelled.outcome).toBe('cancelled');
    expect(cancelled.lastRecordedCall).toBeNull();
    expect(cancelled.looksClaimable).toBe(true);
  });

  it('measures lateness from the departure when only a departure was recorded', () => {
    const departedOnly = record(
      [
        call('LBG', { scheduledDeparture: '1835', actualDeparture: '1834', scheduledArrival: '1834' }),
        call('HHE', { scheduledDeparture: '1922', actualDeparture: '1950' }),
        call('HSK', { scheduledArrival: '1932' }),
      ],
      { date: '2026-09-03', tocCode: 'TL' },
    );
    const result = classify(departedOnly, { from: 'LBG', to: 'HSK', date: '2026-09-03' });

    expect(result.outcome).toBe('did-not-call');
    expect(result.lastRecordedCall).toEqual({ location: 'HHE', time: '1950', minutesLate: 28 });
  });
});

describe('a stopped-short journey once the connection is known', () => {
  const terminatedShort = record(
    [
      call('LBG', { scheduledDeparture: '1835', actualDeparture: '1834', scheduledArrival: '1834' }),
      call('HHE', { scheduledArrival: '1921', actualArrival: '2002' }),
      call('HSK', { scheduledArrival: '1932', lateCancReason: '911' }),
    ],
    { date: '2026-09-03', tocCode: 'TL' },
  );

  const onward = {
    rid: 'onward-1',
    from: 'HHE',
    to: 'HSK',
    departed: '2015',
    arrived: '2025',
    waitMinutes: 13,
    totalDelayMinutes: 53,
    changeMinutes: 3,
    changeTimeFromTimetable: true,
    leftInsideChangeTime: null,
  };

  const assessed = classify(terminatedShort, {
    from: 'LBG',
    to: 'HSK',
    date: '2026-09-03',
    onwardConnection: onward,
  });

  it('finally has a delay at the destination to report', () => {
    expect(assessed.delayMinutes).toBe(53);
    expect(assessed.outcome).toBe('did-not-call');
  });

  it('marks the figure as resting on the assumed connection', () => {
    expect(assessed.evidence).toBe('assumed-onward-connection');
    expect(assessed.onwardConnection).toEqual(onward);
  });

  it('names what the total was measured to, and why that is the right train', () => {
    // Claims are checked against the first train available, so that is the
    // figure - not an invitation to claim on a later train someone chose.
    const notes = assessed.notes.join(' ');
    expect(notes).toContain('first train that could have carried you on');
    expect(notes).toContain('checked against the first train you could have caught');
    expect(notes).toContain('If you could not board it');
    expect(notes).not.toContain('claim on when you actually arrived');
  });

  it('scores the total against the threshold', () => {
    expect(assessed.looksClaimable).toBe(true);
  });

  it('keeps a below-threshold total visible rather than silently clearing it', () => {
    // The total rests on a guess about which train was caught. If that guess
    // is what drops a journey under the threshold, it must not vanish.
    const quick = classify(terminatedShort, {
      from: 'LBG',
      to: 'HSK',
      date: '2026-09-03',
      onwardConnection: { ...onward, arrived: '1940', totalDelayMinutes: 8 },
    });

    expect(quick.looksClaimable).toBe(false);
    expect(quick.needsManualCheck).toBe(true);
    expect(quick.notes.join(' ')).toContain('only because a train came along promptly');
  });

  it('still reports the journey when no connection could be found', () => {
    const withoutConnection = classify(terminatedShort, {
      from: 'LBG',
      to: 'HSK',
      date: '2026-09-03',
    });

    expect(withoutConnection.delayMinutes).toBeNull();
    expect(withoutConnection.looksClaimable).toBe(true);
    expect(withoutConnection.onwardConnection).toBeNull();
  });

  it('never writes "a 8-minute wait"', () => {
    const eight = classify(terminatedShort, {
      from: 'LBG',
      to: 'HSK',
      date: '2026-09-03',
      onwardConnection: { ...onward, waitMinutes: 8 },
    });
    expect(eight.notes.join(' ')).toContain('an 8-minute wait');
    expect(eight.notes.join(' ')).not.toContain('a 8-minute');
  });

  it('names the timetable change time it allowed', () => {
    expect(assessed.notes.join(' ')).toContain("the timetable's 3-minute change time at HHE");
  });

  it('says so when the change time was a default rather than the timetable\'s', () => {
    const defaulted = classify(terminatedShort, {
      from: 'LBG',
      to: 'HSK',
      date: '2026-09-03',
      onwardConnection: { ...onward, changeMinutes: 5, changeTimeFromTimetable: false },
    });
    const notes = defaulted.notes.join(' ');
    expect(notes).toContain('5 minutes to change at HHE');
    expect(notes).toContain('not on file');
  });

  it('mentions a train that left too soon to count, and what to do if it was caught', () => {
    const withEarlier = classify(terminatedShort, {
      from: 'LBG',
      to: 'HSK',
      date: '2026-09-03',
      onwardConnection: { ...onward, leftInsideChangeTime: '2005' },
    });
    const notes = withEarlier.notes.join(' ');
    expect(notes).toContain('A train also left at 20:05');
    expect(notes).toContain('claim on that train instead');
    expect(assessed.notes.join(' ')).not.toContain('A train also left');
  });
});

describe('a train that does not take you to your destination', () => {
  // London Bridge 18:35 to Hassocks, due 19:32.
  function train(from: string, departed: string, arrived: string, total: number, wait = 10): OnwardConnection {
    return {
      rid: `${from}-${departed}`,
      from,
      to: 'HSK',
      departed,
      arrived,
      waitMinutes: wait,
      totalDelayMinutes: total,
      changeMinutes: 3,
      changeTimeFromTimetable: true,
      leftInsideChangeTime: null,
    };
  }

  const judge = (calls: readonly ServiceCall[], extra: Record<string, unknown> = {}) =>
    classify(record(calls, { date: '2026-09-03', tocCode: 'TL' }), {
      from: 'LBG',
      to: 'HSK',
      date: '2026-09-03',
      ...extra,
    });

  describe('cancelled outright', () => {
    const cancelled = [
      call('LBG', { scheduledDeparture: '1835' }),
      call('GTW', { scheduledArrival: '1904' }),
      call('HSK', { scheduledArrival: '1932' }),
    ];

    it('is measured on the next train to leave the origin after it was due', () => {
      const result = judge(cancelled, { onwardConnection: train('LBG', '1905', '2002', 30, 30) });
      expect(result.outcome).toBe('cancelled');
      expect(result.delayMinutes).toBe(30);
      expect(result.looksClaimable).toBe(true);
      expect(result.needsManualCheck).toBe(true);
      expect(result.evidence).toBe('assumed-onward-connection');
      expect(result.notes.join(' ')).toContain('left LBG at 19:05, 30 minutes after yours was due to leave');
      expect(describeOutcome(result)).toContain('This train was cancelled. On the next train from LBG you would have got in at 20:02, 30 minutes late in total');
    });

    it('can find a cancellation cost less than the threshold, and says to check', () => {
      const result = judge(cancelled, { onwardConnection: train('LBG', '1840', '1942', 10, 5) });
      expect(result.looksClaimable).toBe(false);
      expect(result.needsManualCheck).toBe(true);
      expect(result.notes.join(' ')).toContain('only because a train came along promptly');
    });

    it('still looks claimable when no train from the origin was found', () => {
      const result = judge(cancelled);
      expect(result.delayMinutes).toBeNull();
      expect(result.looksClaimable).toBe(true);
    });
  });

  describe('not stopping at the origin', () => {
    const skipped = [
      call('BFR', { scheduledDeparture: '1830', actualDeparture: '1831' }),
      call('LBG', { scheduledDeparture: '1835' }),
      call('GTW', { scheduledArrival: '1904', actualArrival: '1905' }),
      call('HSK', { scheduledArrival: '1932', actualArrival: '1933' }),
    ];

    it('is not boardable even though it reached the destination on time', () => {
      const result = judge(skipped);
      expect(result.outcome).toBe('skipped-origin');
      expect(result.looksClaimable).toBe(true);
      expect(result.needsManualCheck).toBe(true);
      expect(describeOutcome(result)).toContain('did not call at LBG, so it could not be boarded');
    });

    it('is measured on the next train from the origin', () => {
      const result = judge(skipped, { onwardConnection: train('LBG', '1900', '1957', 25, 25) });
      expect(result.delayMinutes).toBe(25);
      expect(result.looksClaimable).toBe(true);
    });

    it('is not assumed when the missing time is at the start of the train\'s run', () => {
      // A train cannot skip the station it starts from: that is a gap in the data.
      const firstStopGap = [
        call('LBG', { scheduledDeparture: '1835' }),
        call('HSK', { scheduledArrival: '1932', actualArrival: '1933' }),
      ];
      expect(judge(firstStopGap).outcome).toBe('within-threshold');
    });
  });

  describe('running past the destination without calling', () => {
    // Via Haywards Heath, then fast through Hassocks to Brighton.
    const ranPast = [
      call('LBG', { scheduledDeparture: '1835', actualDeparture: '1835' }),
      call('HHE', { scheduledArrival: '1921', actualArrival: '1925' }),
      call('HSK', { scheduledArrival: '1932' }),
      call('BTN', { scheduledArrival: '1945', actualArrival: '1950' }),
    ];

    it('measures getting off before when that and being carried on are both over the threshold', () => {
      const result = judge(ranPast, {
        onwardConnection: train('HHE', '1935', '1952', 20),
        carriedPastConnection: train('BTN', '2000', '2012', 40),
      });
      expect(result.outcome).toBe('did-not-call');
      expect(result.delayMinutes).toBe(20);
      expect(result.carriedPast?.reported).toBe(false);
      expect(result.carriedPast?.call.location).toBe('BTN');
      expect(result.notes.join(' ')).toContain('It ran on past HSK without calling there. It was next recorded at BTN at 19:50');
      expect(result.notes.join(' ')).toContain('carried on to BTN, the first train back reached HSK at 20:12, 40 minutes late.');
    });

    it('measures being carried on when only that is over the threshold', () => {
      const result = judge(ranPast, {
        onwardConnection: train('HHE', '1930', '1942', 10),
        carriedPastConnection: train('BTN', '2000', '2012', 40),
      });
      expect(result.delayMinutes).toBe(40);
      expect(result.looksClaimable).toBe(true);
      expect(result.carriedPast?.reported).toBe(true);
      expect(result.onwardConnection?.from).toBe('BTN');
      expect(describeOutcome(result)).toContain('ran past HSK without calling there. On the first train back from BTN');
      expect(result.notes.join(' ')).toContain('in time for you to get off at HHE instead');
      expect(result.notes.join(' ')).toContain('Which applies depends on whether you could get off there');
    });

    it('measures being carried on when there was no stop before the destination to get off at', () => {
      const noStopBefore = [
        call('LBG', { scheduledDeparture: '1835', actualDeparture: '1835' }),
        call('HSK', { scheduledArrival: '1932' }),
        call('BTN', { scheduledArrival: '1945', actualArrival: '1946' }),
      ];
      const result = judge(noStopBefore, { carriedPastConnection: train('BTN', '1955', '2008', 36) });
      expect(result.outcome).toBe('did-not-call');
      expect(result.lastRecordedCall).toBeNull();
      expect(result.delayMinutes).toBe(36);
      expect(result.notes.join(' ')).toContain('with no stop before it to get off at');
    });

    it('still flags it with nothing found either way', () => {
      const result = judge(ranPast);
      expect(result.delayMinutes).toBeNull();
      expect(result.looksClaimable).toBe(true);
      expect(result.carriedPast?.connection).toBeNull();
    });
  });
});
