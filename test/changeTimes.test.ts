import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANGE_MINUTES, resolveChangeTime } from '../src/domain/changeTimes.js';

describe('change times from the timetable feed', () => {
  it('uses the station figure from the MSN file', () => {
    expect(resolveChangeTime('HHE')).toEqual({ minutes: 3, fromTimetable: true });
    expect(resolveChangeTime('CLJ')).toEqual({ minutes: 10, fromTimetable: true });
  });

  it('prefers a figure for the pair of operators when the TSI file has one', () => {
    expect(resolveChangeTime('CLJ', 'SN', 'SN')).toEqual({ minutes: 5, fromTimetable: true });
  });

  it('falls back to the station figure for a pair the TSI file does not list', () => {
    expect(resolveChangeTime('CLJ', 'SN', 'LO')).toEqual({ minutes: 10, fromTimetable: true });
  });

  it('ignores case and stray whitespace in codes', () => {
    expect(resolveChangeTime(' clj ', 'sn', 'sn').minutes).toBe(5);
  });

  it('says when a default stood in for a station it does not know', () => {
    expect(resolveChangeTime('ZZZ')).toEqual({
      minutes: DEFAULT_CHANGE_MINUTES,
      fromTimetable: false,
    });
  });
});
