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
    // The 08:11 left at 08:45 and got in at 09:00: 36 minutes, over TfL's 30.
    // Southern's 08:38 was later still, so the Overground is the train caught.
    const result = classify(firstTrain('0752'), [ran(LO_0758), ran(LO_0811, '0845', '0900'), ran(SN_0838, '0850', '0904')]);
    expect(result.looksClaimable).toBe(true);
    expect(result.operator?.name).toBe('London Overground');
    expect(result.thresholdMinutes).toBe(31);
    expect(result.evidence).toBe('recorded-times');
    expect(result.needsManualCheck).toBe(false);

    const notes = result.notes.join(' ');
    expect(notes).toContain('You would have made that connection');
    expect(notes).toContain('happened on the connection, run by London Overground');
    expect(notes).toContain("TfL's scheme");
  });

  it('holds a late connection to its own operator\'s threshold, not the first train\'s', () => {
    // 16 minutes late on the Overground: over Southern's 15, not over TfL's 30.
    const result = classify(firstTrain('0752'), [ran(LO_0758), ran(LO_0811, '0825', '0840'), ran(SN_0838)]);
    expect(result.delayMinutes).toBe(16);
    expect(result.looksClaimable).toBe(false);
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
    // A Southern connection at 07:58 is planned (5 minutes Southern to Southern)
    // but missing from the data. On the trains recorded: the 08:38, 40 minutes late.
    const sn0758: TimetabledConnection = { tocCode: 'SN', scheduledDeparture: '0758', scheduledArrival: '0812' };
    const result = classify(firstTrain('0752'), [ran(SN_0838)], [sn0758, SN_0838]);
    expect(result.outcome).toBe('unconfirmed');
    expect(result.looksClaimable).toBe(false);
    expect(result.needsManualCheck).toBe(true);
    expect(describeOutcome(result)).toContain('the data is missing trains');
    expect(result.notes.join(' ')).toContain('on time instead of 40 minutes late');
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

  it('leaves an operator out of the connection entirely when told to, and says so', () => {
    // Without the Overground, the plan is Southern's 08:38 (in 08:52), and that
    // is the train caught: no delay, and nothing missing.
    const result = classifyJourneyWithChange({
      record: firstTrain('0752'),
      from: 'HSK',
      via: 'CLJ',
      to: 'SPB',
      date: DATE,
      today: TODAY,
      timetable: TIMETABLE,
      onward: [ran(SN_0838)],
      changeTimeFor: CLAPHAM,
      leaveOutOperators: ['LO'],
    });
    expect(result.change?.planned?.scheduledDeparture).toBe('0838');
    expect(result.change?.missingFromData).toEqual([]);
    expect(result.delayMinutes).toBe(0);
    expect(result.notes.join(' ')).toContain('London Overground trains from CLJ to SPB are left out');
  });

  it('says nothing about leaving an operator out when it had no trains to leave out', () => {
    const result = classifyJourneyWithChange({
      record: firstTrain('0752'),
      from: 'HSK',
      via: 'CLJ',
      to: 'SPB',
      date: DATE,
      today: TODAY,
      timetable: [SN_0838],
      onward: [ran(SN_0838)],
      changeTimeFor: CLAPHAM,
      leaveOutOperators: ['LO'],
    });
    expect(result.notes.join(' ')).not.toContain('left out');
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

describe('a first train that never reached the change station', () => {
  /** A Hassocks train to CLJ, as a replacement candidate. */
  function toClapham(rid: string, from: string, departed: string, arrived: string, toc = 'SN'): ServiceRecord {
    return {
      rid,
      date: DATE,
      tocCode: toc,
      calls: [
        call(from, { scheduledDeparture: departed, actualDeparture: departed }),
        call('CLJ', { scheduledArrival: arrived, actualArrival: arrived }),
      ],
    };
  }

  const ONWARD = TIMETABLE.map((slot) => ran(slot));

  function classifyWithReplacements(first: ServiceRecord, candidates: readonly ServiceRecord[] | null) {
    return classifyJourneyWithChange({
      record: first,
      from: 'HSK',
      via: 'CLJ',
      to: 'SPB',
      date: DATE,
      today: TODAY,
      timetable: TIMETABLE,
      onward: ONWARD,
      changeTimeFor: CLAPHAM,
      replacementCandidates: candidates,
      changeTimeAt: () => ({ minutes: 3, fromTimetable: true }),
    });
  }

  it('measures a cancelled train from the next one to leave the origin after it was due', () => {
    // The 07:03 never ran. The 07:33 got to CLJ at 08:22: in time for the 08:38?
    // No - the plan was the 08:11 (due 08:24), which needs 10 minutes onto the
    // Overground, so the 08:38 (in 08:52) it is: 28 minutes, on Southern.
    const result = classifyWithReplacements(firstTrain(null, null), [
      toClapham('before', 'HSK', '0633', '0722'),
      toClapham('next', 'HSK', '0733', '0822'),
      toClapham('later', 'HSK', '0803', '0852'),
    ]);

    expect(result.change?.replacement?.reason).toBe('cancelled');
    expect(result.change?.replacement?.train.rid).toBe('next');
    expect(result.change?.actualArrivalAtVia).toBe('0822');
    expect(result.delayMinutes).toBe(28);
    expect(result.change?.cause).toBe('first-train-late');
    expect(result.operator?.name).toBe('Southern');
    expect(result.looksClaimable).toBe(true);
    expect(result.needsManualCheck).toBe(true);
    expect(result.evidence).toBe('assumed-onward-connection');

    const notes = result.notes.join(' ');
    expect(notes).toContain('No departure was recorded for this train');
    expect(notes).toContain('left HSK at 07:33, 30 minutes after yours was due to leave');
    expect(notes).toContain('That train reached CLJ at 08:22');
    expect(describeOutcome(result)).toContain('Your train did not reach CLJ; on the next trains you would have arrived at SPB 28 minutes late');
  });

  it('counts a late-running earlier train that left after the cancelled one was due', () => {
    const result = classifyWithReplacements(firstTrain(null, null), [
      toClapham('late-0633', 'HSK', '0705', '0754'),
      toClapham('next', 'HSK', '0733', '0822'),
    ]);
    expect(result.change?.replacement?.train.rid).toBe('late-0633');
  });

  it('can find a cancellation cost nothing at all', () => {
    // A late-running earlier train still made the planned 08:11.
    const result = classifyWithReplacements(firstTrain(null, null), [toClapham('late', 'HSK', '0704', '0753')]);
    expect(result.delayMinutes).toBe(0);
    expect(result.looksClaimable).toBe(false);
    expect(result.needsManualCheck).toBe(true);
  });

  it('follows a train that stopped short from where it was last recorded', () => {
    // Stopped at HHE at 07:10; the change time there is 3 minutes.
    const stoppedShort = firstTrain(null, '0703');
    const result = classifyWithReplacements(stoppedShort, [
      toClapham('too-soon', 'HHE', '0712', '0756'),
      toClapham('next', 'HHE', '0720', '0804'),
    ]);

    expect(result.change?.replacement?.reason).toBe('stopped-short');
    expect(result.change?.replacement?.station).toBe('HHE');
    expect(result.change?.replacement?.train.rid).toBe('next');
    // In at 08:04 - 12 minutes late, still 7 short of the 10 needed for the 08:11.
    expect(result.change?.cause).toBe('first-train-late');
    expect(result.delayMinutes).toBe(28);

    const notes = result.notes.join(' ');
    expect(notes).toContain('last recorded at HHE at 07:10');
    expect(notes).toContain('left HHE at 07:20');
    expect(notes).toContain('A train also left at 07:12');
  });

  it('says so when no train from there was recorded, and keeps the journey flagged', () => {
    const result = classifyWithReplacements(firstTrain(null, null), []);
    expect(result.outcome).toBe('arrival-not-recorded');
    expect(result.looksClaimable).toBe(true);
    expect(result.change).toBeNull();
    expect(result.notes.join(' ')).toContain('No train from HSK to CLJ was recorded leaving within 90 minutes of 07:03');
  });

  it('reports the journey as before when the trains from there were not looked up', () => {
    const result = classifyWithReplacements(firstTrain(null, null), null);
    expect(result.outcome).toBe('arrival-not-recorded');
    expect(result.notes.join(' ')).toContain('could not be assessed');
    expect(result.notes.join(' ')).not.toContain('No train from HSK');
  });
});
