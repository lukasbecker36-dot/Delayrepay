import { describe, expect, it } from 'vitest';
import { pickOnwardConnection, MAX_WAIT_MINUTES } from '../src/domain/onward.js';
import { DEFAULT_CHANGE_MINUTES } from '../src/domain/changeTimes.js';
import type { ServiceCall, ServiceRecord } from '../src/domain/types.js';

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

/** A service calling at HHE then HSK, with whatever times the case needs. */
function connection(
  rid: string,
  bookedDeparture: string,
  actualDeparture: string | null,
  actualArrival: string | null,
): ServiceRecord {
  return {
    rid,
    date: '2026-09-03',
    tocCode: 'TL',
    calls: [
      call('HHE', { scheduledDeparture: bookedDeparture, actualDeparture }),
      call('HSK', { scheduledArrival: '2013', actualArrival }),
    ],
  };
}

const SET_DOWN_AT = '2002';
const BOOKED_ARRIVAL = '1932';

function pick(candidates: readonly ServiceRecord[], changeMinutes = DEFAULT_CHANGE_MINUTES) {
  const changeTimeFor = () => ({ minutes: changeMinutes, fromTimetable: true });
  return pickOnwardConnection({
    candidates,
    from: 'HHE',
    to: 'HSK',
    setDownAt: SET_DOWN_AT,
    bookedArrival: BOOKED_ARRIVAL,
    changeTimeFor,
  });
}

describe('picking the train someone actually caught', () => {
  it('goes by when a train really left, not by when it was booked to', () => {
    // The real 2026-09-03 case. The 19:52 was booked to leave before the user
    // was set down at 20:02, but ran 23 minutes late and was the first away.
    // Choosing on the timetable would skip it and overstate the delay by 17
    // minutes - enough to move a claim into a different compensation band.
    const chosen = pick([
      connection('booked-2004', '2004', '2031', '2042'),
      connection('booked-1952', '1952', '2015', '2025'),
      connection('booked-1934', '1934', '2019', '2029'),
    ]);

    expect(chosen?.rid).toBe('booked-1952');
    expect(chosen?.departed).toBe('2015');
    expect(chosen?.arrived).toBe('2025');
  });

  it('measures the total against the original booked arrival', () => {
    // 19:32 booked, 20:25 actual.
    expect(pick([connection('a', '1952', '2015', '2025')])?.totalDelayMinutes).toBe(53);
  });

  it('counts the wait from being set down to that train leaving', () => {
    expect(pick([connection('a', '1952', '2015', '2025')])?.waitMinutes).toBe(13);
  });

  it('will not put someone on a train that had already gone', () => {
    const chosen = pick([
      connection('departed-before', '1955', '2001', '2011'),
      connection('departed-after', '2004', '2031', '2042'),
    ]);
    expect(chosen?.rid).toBe('departed-after');
  });

  it('will not count a train that left inside the change time', () => {
    // The 2026-08-21 case: set down at Haywards Heath, and a train left three
    // minutes later. The timetable allows five to change, so it is not a
    // connection the operator would count - the next one is.
    const chosen = pick([
      connection('three-minutes', '1950', '2005', '2013'),
      connection('next', '2010', '2018', '2027'),
    ]);
    expect(chosen?.rid).toBe('next');
    expect(chosen?.changeMinutes).toBe(5);
  });

  it('still names the train that left too soon, so the result can mention it', () => {
    const chosen = pick([
      connection('three-minutes', '1950', '2005', '2013'),
      connection('next', '2010', '2018', '2027'),
    ]);
    expect(chosen?.leftInsideChangeTime).toBe('2005');
  });

  it('reports no train inside the change time when there was none', () => {
    expect(pick([connection('a', '1952', '2015', '2025')])?.leftInsideChangeTime).toBeNull();
  });

  it('treats a train leaving exactly at the change time as catchable', () => {
    expect(pick([connection('a', '2000', '2007', '2017')])?.waitMinutes).toBe(5);
  });

  it('uses whatever change time the station is given', () => {
    // A station with a longer change time rules out a train the default allows.
    const candidates = [
      connection('seven-minutes', '2000', '2009', '2019'),
      connection('later', '2015', '2020', '2030'),
    ];
    expect(pick(candidates, 5)?.rid).toBe('seven-minutes');
    expect(pick(candidates, 10)?.rid).toBe('later');
  });

  it('applies the change time for the operator of each train it considers', () => {
    // At Clapham Junction the timetable allows 5 minutes from Southern to
    // Southern but 10 in general. A 7-minute gap is a connection onto one and
    // not onto the other.
    const southern = { ...connection('southern', '2000', '2009', '2019'), tocCode: 'SN' };
    const overground = { ...connection('overground', '2000', '2009', '2018'), tocCode: 'LO' };

    const chosen = pickOnwardConnection({
      candidates: [overground, southern],
      from: 'HHE',
      to: 'HSK',
      setDownAt: SET_DOWN_AT,
      bookedArrival: BOOKED_ARRIVAL,
      changeTimeFor: (toc) => ({ minutes: toc === 'SN' ? 5 : 10, fromTimetable: true }),
    });
    expect(chosen?.rid).toBe('southern');
    expect(chosen?.leftInsideChangeTime).toBe('2009');
  });

  it('returns nothing when the only train left inside the change time', () => {
    expect(pick([connection('too-soon', '2000', SET_DOWN_AT, '2012')])).toBeNull();
  });

  it('gives up rather than guessing once the wait stops being plausible', () => {
    const tooLate = connection('a', '2130', '2135', '2145');
    expect(pick([tooLate])).toBeNull();
  });

  it('accepts a wait right up to the limit', () => {
    // 2002 + 90 = 2132.
    const atLimit = connection('a', '2130', '2132', '2142');
    expect(pick([atLimit])?.waitMinutes).toBe(MAX_WAIT_MINUTES);
  });

  it('ignores a service with no recorded departure, which did not run', () => {
    const chosen = pick([
      connection('never-ran', '2004', null, null),
      connection('ran', '2022', '2034', '2046'),
    ]);
    expect(chosen?.rid).toBe('ran');
  });

  it('ignores a service that ran but never reached the destination', () => {
    const chosen = pick([
      connection('terminated-again', '2004', '2010', null),
      connection('got-there', '2022', '2034', '2046'),
    ]);
    expect(chosen?.rid).toBe('got-there');
  });

  it('returns nothing when no candidate could have carried them', () => {
    expect(pick([])).toBeNull();
    expect(pick([connection('never-ran', '2004', null, null)])).toBeNull();
  });

  it('follows a connection across midnight without reading it as a day early', () => {
    const chosen = pickOnwardConnection({
      candidates: [connection('late-night', '2350', '2352', '0008')],
      from: 'HHE',
      to: 'HSK',
      setDownAt: '2345',
      bookedArrival: '2320',
      changeTimeFor: () => ({ minutes: DEFAULT_CHANGE_MINUTES, fromTimetable: false }),
    });

    expect(chosen?.waitMinutes).toBe(7);
    expect(chosen?.totalDelayMinutes).toBe(48);
  });

  it('will not take the destination from a call before the user boarded', () => {
    // A service calling at HSK, then HHE, then HSK again: only the second HSK
    // is reachable from the platform they are standing on.
    const looping: ServiceRecord = {
      rid: 'loop',
      date: '2026-09-03',
      tocCode: 'TL',
      calls: [
        call('HSK', { actualArrival: '1950' }),
        call('HHE', { scheduledDeparture: '2004', actualDeparture: '2010' }),
        call('HSK', { scheduledArrival: '2013', actualArrival: '2020' }),
      ],
    };
    expect(pick([looping])?.arrived).toBe('2020');
  });
});
