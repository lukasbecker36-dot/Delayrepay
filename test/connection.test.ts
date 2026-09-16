import { describe, expect, it } from 'vitest';
import { assessChange, type TimetabledConnection } from '../src/domain/connection.js';
import { classifyJourneyWithChange } from '../src/domain/classifyChange.js';
import { describeOutcome } from '../src/domain/copy.js';
import type { ServiceCall, ServiceRecord } from '../src/domain/types.js';

// Modelled on Hassocks to Shepherd's Bush, changing at Clapham Junction. The
// Southern train is due into CLJ at 07:52. From there the timetable has London
// Overground at 07:58 and 08:11, and Southern's hourly West London train at
// 08:38. CLJ allows 5 minutes from one Southern train to another, 10 otherwise.

const DATE = '2026-09-08';
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

/** The Hassocks train, arriving at CLJ at `arrived` (null: it never got there). */
function firstTrain(arrived: string | null, departed: string | null = '0703'): ServiceRecord {
  return {
    rid: 'first',
    date: DATE,
    tocCode: 'SN',
    calls: [
      call('HSK', { scheduledDeparture: '0703', actualDeparture: departed }),
      call('HHE', { scheduledArrival: '0709', actualArrival: departed === null ? null : '0710' }),
      call('CLJ', { scheduledArrival: '0752', actualArrival: arrived }),
    ],
  };
}

const LO_0758: TimetabledConnection = { tocCode: 'LO', scheduledDeparture: '0758', scheduledArrival: '0811' };
const LO_0811: TimetabledConnection = { tocCode: 'LO', scheduledDeparture: '0811', scheduledArrival: '0824' };
const LO_0826: TimetabledConnection = { tocCode: 'LO', scheduledDeparture: '0826', scheduledArrival: '0839' };
const SN_0838: TimetabledConnection = { tocCode: 'SN', scheduledDeparture: '0838', scheduledArrival: '0852' };
const TIMETABLE = [LO_0758, LO_0811, SN_0838];

/** One day's record of a timetabled connection. */
function ran(
  slot: TimetabledConnection,
  departed: string | null = slot.scheduledDeparture,
  arrived: string | null = departed === null ? null : slot.scheduledArrival,
): ServiceRecord {
  return {
    rid: `${slot.tocCode}-${slot.scheduledDeparture}`,
    date: DATE,
    tocCode: slot.tocCode,
    calls: [
      call('CLJ', { scheduledDeparture: slot.scheduledDeparture, actualDeparture: departed }),
      call('KPA', { scheduledArrival: '0000' }),
      call('SPB', { scheduledArrival: slot.scheduledArrival, actualArrival: arrived }),
    ],
  };
}

const CLAPHAM = (arriving: string | null, departing: string | null) =>
  arriving === 'SN' && departing === 'SN'
    ? { minutes: 5, fromTimetable: true }
    : { minutes: 10, fromTimetable: true };

function assess(
  first: ServiceRecord,
  onward: readonly ServiceRecord[],
  timetable: readonly TimetabledConnection[] = TIMETABLE,
) {
  return assessChange({
    firstLeg: first,
    from: 'HSK',
    via: 'CLJ',
    to: 'SPB',
    timetable,
    onward,
    changeTimeFor: CLAPHAM,
  });
}

function classify(
  first: ServiceRecord | null,
  onward: readonly ServiceRecord[],
  timetable: readonly TimetabledConnection[] = TIMETABLE,
) {
  return classifyJourneyWithChange({
    record: first,
    from: 'HSK',
    via: 'CLJ',
    to: 'SPB',
    date: DATE,
    today: TODAY,
    timetable,
    onward,
    changeTimeFor: CLAPHAM,
  });
}

describe('the planned connection', () => {
  it('is the first timetabled train that leaves the change time, of any operator', () => {
    // 07:58 leaves 6 minutes after 07:52, inside the 10 minutes CLJ allows onto
    // the Overground. 08:11 is the plan.
    const result = assess(firstTrain('0752'), TIMETABLE.map((slot) => ran(slot)));
    expect(result?.planned?.scheduledDeparture).toBe('0811');
    expect(result?.planned?.changeMinutes).toBe(10);
  });

  it('uses the change time for the pair of operators involved', () => {
    // Southern to Southern at CLJ is 5 minutes, so a Southern train 6 minutes
    // after arrival is a valid plan where an Overground one is not.
    const sn0758: TimetabledConnection = { tocCode: 'SN', scheduledDeparture: '0758', scheduledArrival: '0812' };
    const result = assess(firstTrain('0752'), [ran(sn0758), ran(LO_0811)], [sn0758, LO_0811]);
    expect(result?.planned?.tocCode).toBe('SN');
    expect(result?.planned?.changeMinutes).toBe(5);
  });

  it('breaks a tie on departure by the earlier arrival', () => {
    const slow: TimetabledConnection = { tocCode: 'SN', scheduledDeparture: '0811', scheduledArrival: '0830' };
    const result = assess(firstTrain('0752'), [ran(slow), ran(LO_0811)], [slow, LO_0811]);
    expect(result?.planned?.scheduledArrival).toBe('0824');
  });

  it('is absent when nothing is timetabled onward within the wait limit', () => {
    const late: TimetabledConnection = { tocCode: 'SN', scheduledDeparture: '0938', scheduledArrival: '0952' };
    const result = assess(firstTrain('0752'), [ran(late)], [late]);
    expect(result?.planned).toBeNull();
  });
});

describe('what happened at the change', () => {
  it('on time throughout: connection made, no delay, nothing to blame', () => {
    const result = assess(firstTrain('0752'), TIMETABLE.map((slot) => ran(slot)));
    expect(result?.madePlannedConnection).toBe(true);
    expect(result?.delayMinutes).toBe(0);
    expect(result?.cause).toBeNull();
  });

  it('a late first train that misses the connection puts the delay on the first operator', () => {
    // In at 08:05; the 08:11 left on time, 6 minutes later - under the 10
    // allowed. The next train you could catch is Southern's 08:38.
    const result = assess(firstTrain('0805'), TIMETABLE.map((slot) => ran(slot)));
    expect(result?.madePlannedConnection).toBe(false);
    expect(result?.caught?.rid).toBe('SN-0838');
    expect(result?.delayMinutes).toBe(28);
    expect(result?.cause).toBe('first-train-late');
    expect(result?.responsibleTocCode).toBe('SN');
    expect(result?.caught?.leftInsideChangeTime).toBe('0811');
  });

  it('a late first train still counts as making it if the connection was late too', () => {
    // In at 08:08, but the 08:11 left at 08:20 - 12 minutes, enough to change.
    const result = assess(firstTrain('0808'), [ran(LO_0758), ran(LO_0811, '0820', '0833'), ran(SN_0838)]);
    expect(result?.madePlannedConnection).toBe(true);
    expect(result?.delayMinutes).toBe(9);
    expect(result?.cause).toBe('connection-late');
    expect(result?.responsibleTocCode).toBe('LO');
  });

  it('a cancelled connection puts the delay on the connection\'s operator', () => {
    const result = assess(firstTrain('0752'), [ran(LO_0758), ran(LO_0811, null), ran(SN_0838)]);
    expect(result?.cause).toBe('connection-did-not-run');
    expect(result?.responsibleTocCode).toBe('LO');
    expect(result?.caught?.rid).toBe('SN-0838');
    expect(result?.delayMinutes).toBe(28);
  });

  it('a connection missing from the data is named as missing, not as cancelled', () => {
    const result = assess(firstTrain('0752'), [ran(LO_0758), ran(SN_0838)]);
    expect(result?.cause).toBe('connection-not-in-data');
    expect(result?.planned?.inData).toBe(false);
    expect(result?.missingFromData).toContain('0811');
  });

  it('a late-running connection that was still caught belongs to its operator', () => {
    const result = assess(firstTrain('0752'), [ran(LO_0758), ran(LO_0811, '0825', '0840'), ran(SN_0838)]);
    expect(result?.madePlannedConnection).toBe(true);
    expect(result?.delayMinutes).toBe(16);
    expect(result?.cause).toBe('connection-late');
    expect(result?.responsibleTocCode).toBe('LO');
  });

  it('lists trains that run on other days but have no record today', () => {
    // 08:26 is in the timetable but absent today, and would have been an
    // earlier way on than 08:38.
    const result = assess(
      firstTrain('0805'),
      [ran(LO_0758), ran(LO_0811), ran(SN_0838)],
      [...TIMETABLE, LO_0826],
    );
    expect(result?.missingFromData).toEqual(['0826']);
  });

  it('does not list a missing train that left after the one caught', () => {
    const later: TimetabledConnection = { tocCode: 'LO', scheduledDeparture: '0845', scheduledArrival: '0858' };
    const result = assess(firstTrain('0752'), TIMETABLE.map((slot) => ran(slot)), [...TIMETABLE, later]);
    expect(result?.missingFromData).toEqual([]);
  });

  it('works out the best case as if a missing train had run to time', () => {
    // The planned 08:11 is absent. On the trains recorded the way on is 08:38,
    // 28 minutes late; had the 08:11 run, nothing was late at all.
    const result = assess(firstTrain('0752'), [ran(LO_0758), ran(SN_0838)]);
    expect(result?.delayMinutes).toBe(28);
    expect(result?.bestCaseDelayMinutes).toBe(0);
  });

  it('treats a train that left with no recorded arrival as arriving as late as it left', () => {
    // The 08:11 left at 08:14 and has no arrival at SPB: best case in at 08:27.
    const result = assess(firstTrain('0752'), [ran(LO_0758), ran(LO_0811, '0814', null), ran(SN_0838)]);
    expect(result?.cause).toBe('connection-arrival-not-recorded');
    expect(result?.arrivalNotRecorded).toEqual(['0811']);
    expect(result?.delayMinutes).toBe(28);
    expect(result?.bestCaseDelayMinutes).toBe(3);
  });

  it('has a best case equal to the recorded delay when nothing is missing', () => {
    const result = assess(firstTrain('0805'), TIMETABLE.map((slot) => ran(slot)));
    expect(result?.bestCaseDelayMinutes).toBe(result?.delayMinutes);
  });

  it('has nothing to say when the first train never reached the change', () => {
    expect(assess(firstTrain(null, null), TIMETABLE.map((slot) => ran(slot)))).toBeNull();
  });
});

describe('scoring a journey with a change', () => {
  it('scores a missed connection on the delay at the destination, against the first operator', () => {
    const result = classify(firstTrain('0805'), TIMETABLE.map((slot) => ran(slot)));
    expect(result.outcome).toBe('delayed');
    expect(result.delayMinutes).toBe(28);
    expect(result.looksClaimable).toBe(true);
    expect(result.operator?.name).toBe('Southern');
    expect(result.thresholdConfirmed).toBe(true);
    // Planned in on the 08:11 at 08:24; actually in on the 08:38 at 08:52.
    expect(result.scheduledArrival).toBe('0824');
    expect(result.actualArrival).toBe('0852');
    expect(result.needsManualCheck).toBe(true);

    const notes = result.notes.join(' ');
    expect(notes).toContain("the timetable's 10-minute change time");
    expect(notes).toContain('too late for the 08:11');
    expect(notes).toContain('The delay started with the Southern train from HSK');
    expect(notes).toContain('checked against the first train you could have caught');
  });

  it('says where the lateness was measured and where the change was', () => {
    const result = classify(firstTrain('0805'), TIMETABLE.map((slot) => ran(slot)));
    expect(describeOutcome(result)).toContain('Arrived at SPB 28 minutes late, changing at CLJ');
  });

  it('scores a late connection against the connection\'s operator, with its caveat', () => {
    const result = classify(firstTrain('0752'), [ran(LO_0758), ran(LO_0811, '0825', '0840'), ran(SN_0838)]);
    expect(result.looksClaimable).toBe(true);
    expect(result.operator?.name).toBe('London Overground');
    expect(result.evidence).toBe('recorded-times');
    expect(result.needsManualCheck).toBe(false);

    const notes = result.notes.join(' ');
    expect(notes).toContain('You would have made that connection');
    expect(notes).toContain('happened on the connection, run by London Overground');
    expect(notes).toContain("London Overground's Delay Repay threshold has not been confirmed");
  });

  it('keeps an on-time journey quiet apart from the plan it checked', () => {
    const result = classify(firstTrain('0752'), TIMETABLE.map((slot) => ran(slot)));
    expect(result.outcome).toBe('within-threshold');
    expect(result.needsManualCheck).toBe(false);
    expect(result.notes.join(' ')).not.toContain('started with');
  });

  it('flags a result that missing records could have changed', () => {
    const result = classify(
      firstTrain('0805'),
      [ran(LO_0758), ran(LO_0811), ran(SN_0838)],
      [...TIMETABLE, LO_0826],
    );
    expect(result.needsManualCheck).toBe(true);
    expect(result.notes.join(' ')).toContain('no record on this day of the train timetabled from CLJ at 08:26');
  });

  it('will not call a journey claimable when the gaps in the data could undo it', () => {
    const result = classify(firstTrain('0752'), [ran(LO_0758), ran(SN_0838)]);
    expect(result.outcome).toBe('unconfirmed');
    expect(result.looksClaimable).toBe(false);
    expect(result.needsManualCheck).toBe(true);
    expect(describeOutcome(result)).toContain('the data is missing trains');
    expect(result.notes.join(' ')).toContain('on time instead of 28 minutes late');
  });

  it('still calls it claimable when even the best case is over the threshold', () => {
    // In at 08:05: too late for the 08:11 whether or not the missing 08:26 ran,
    // which would have got in at 08:39 - still 16 minutes late.
    const result = classify(
      firstTrain('0805'),
      [ran(LO_0758), ran(LO_0811), ran(SN_0838)],
      [...TIMETABLE, LO_0826],
    );
    expect(result.outcome).toBe('delayed');
    expect(result.looksClaimable).toBe(true);
    expect(result.change?.bestCaseDelayMinutes).toBe(15);
    expect(result.notes.join(' ')).toContain('15 minutes late instead of 28 minutes late');
  });

  it('judges a first train that never reached the change on its own, naming the change station', () => {
    const cancelled = classify(firstTrain(null, null), TIMETABLE.map((slot) => ran(slot)));
    expect(cancelled.outcome).toBe('arrival-not-recorded');
    expect(cancelled.to).toBe('SPB');
    expect(cancelled.via).toBe('CLJ');
    expect(cancelled.notes.join(' ')).toContain('connection there to SPB could not be assessed');
  });

  it('says a train that stopped short did not call at the change station, not the destination', () => {
    const stoppedShort = classify(firstTrain(null, '0703'), TIMETABLE.map((slot) => ran(slot)));
    expect(stoppedShort.outcome).toBe('did-not-call');
    expect(describeOutcome(stoppedShort)).toContain('did not call at CLJ');
  });

  it('reports a journey whose first train HSP never saw', () => {
    const missing = classify(null, TIMETABLE.map((slot) => ran(slot)));
    expect(missing.outcome).toBe('service-not-found');
    expect(missing.to).toBe('SPB');
  });
});
