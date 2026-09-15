import { describe, expect, it } from 'vitest';
import { classifyJourney } from '../src/domain/classify.js';
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

describe('a service with no arrival recorded', () => {
  const cancelled = record([
    call('BTN', { scheduledDeparture: '0715', lateCancReason: '574' }),
    call('VIC', { scheduledArrival: '0817', lateCancReason: '574' }),
  ], { date: '2026-09-09' });

  it('is treated as a candidate rather than as an on-time arrival', () => {
    const result = classify(cancelled, { thresholdMinutes: 15 });
    expect(result.outcome).toBe('arrival-not-recorded');
    expect(result.looksClaimable).toBe(true);
    expect(result.delayMinutes).toBeNull();
  });

  it('is marked as inferred, because HSP never says "cancelled"', () => {
    const result = classify(cancelled, { thresholdMinutes: 15 });
    expect(result.evidence).toBe('inferred-from-absent-times');
    expect(result.needsManualCheck).toBe(true);
    expect(result.notes.join(' ')).toContain('does not report cancellations directly');
  });

  it('says that reason code 574 settles nothing', () => {
    const result = classify(cancelled, { thresholdMinutes: 15 });
    expect(result.notes.join(' ')).toContain('574');
    expect(result.notes.join(' ')).toContain('both');
  });

  it('notes when no departure was recorded either', () => {
    const result = classify(cancelled, { thresholdMinutes: 15 });
    expect(result.notes.join(' ')).toContain('no departure was recorded either');
  });

  it('does not claim a departure was missing when it was recorded', () => {
    const departedThenVanished = record([
      call('BTN', { scheduledDeparture: '0715', actualDeparture: '0716' }),
      call('VIC', { scheduledArrival: '0817' }),
    ]);
    const result = classify(departedThenVanished, { thresholdMinutes: 15 });
    expect(result.outcome).toBe('arrival-not-recorded');
    expect(result.notes.join(' ')).not.toContain('no departure was recorded either');
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
  it('falls back to 15 minutes and says so when the operator is unconfirmed', () => {
    const late = record([
      call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
      call('VIC', { scheduledArrival: '0817', actualArrival: '0837' }),
    ]);
    const result = classify(late);
    expect(result.thresholdMinutes).toBe(15);
    expect(result.thresholdConfirmed).toBe(false);
    expect(result.notes.join(' ')).toContain('has not been confirmed');
    expect(result.notes.join(' ')).toContain('30 minutes');
  });

  it('names the operator when the TOC code is known', () => {
    const late = record([
      call('BTN', { scheduledDeparture: '0715', actualDeparture: '0718' }),
      call('VIC', { scheduledArrival: '0817', actualArrival: '0837' }),
    ]);
    expect(classify(late).operator?.name).toBe('Southern');
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

    expect(cancelled.outcome).toBe('arrival-not-recorded');
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

  it('says the assumption can only understate the delay, never overstate it', () => {
    expect(assessed.notes.join(' ')).toContain('longer than this, never shorter');
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
    expect(quick.notes.join(' ')).toContain('rests on an assumed connection');
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
});
