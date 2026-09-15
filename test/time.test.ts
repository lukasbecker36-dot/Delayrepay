import { describe, expect, it } from 'vitest';
import {
  formatClockTime,
  minutesLate,
  minutesLateFromClockTimes,
  parseClockTime,
} from '../src/domain/time.js';

describe('parseClockTime', () => {
  it('reads an HHMM clock time as minutes since midnight', () => {
    expect(parseClockTime('0000')).toBe(0);
    expect(parseClockTime('0715')).toBe(7 * 60 + 15);
    expect(parseClockTime('2359')).toBe(23 * 60 + 59);
  });

  it('treats an absent time as null rather than as zero', () => {
    // HSP uses "" both for "no arrival applies here" and for "no arrival was
    // recorded". Reading either as 0000 would score a cancellation as a train
    // that arrived at midnight.
    expect(parseClockTime('')).toBeNull();
    expect(parseClockTime('   ')).toBeNull();
    expect(parseClockTime(null)).toBeNull();
    expect(parseClockTime(undefined)).toBeNull();
  });

  it('rejects anything that is not four digits of real clock time', () => {
    expect(parseClockTime('715')).toBeNull();
    expect(parseClockTime('07:15')).toBeNull();
    expect(parseClockTime('2460')).toBeNull();
    expect(parseClockTime('0760')).toBeNull();
    expect(parseClockTime('abcd')).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseClockTime(' 0715 ')).toBe(435);
  });
});

describe('formatClockTime', () => {
  it('round-trips with parseClockTime', () => {
    for (const time of ['0000', '0715', '1234', '2359']) {
      expect(formatClockTime(parseClockTime(time) as number)).toBe(time);
    }
  });

  it('wraps past midnight', () => {
    expect(formatClockTime(1440)).toBe('0000');
    expect(formatClockTime(1455)).toBe('0015');
    expect(formatClockTime(-15)).toBe('2345');
  });
});

describe('minutesLate', () => {
  it('measures a plain delay', () => {
    expect(minutesLate(parseClockTime('0817')!, parseClockTime('0851')!)).toBe(34);
  });

  it('measures an early arrival as negative', () => {
    expect(minutesLate(parseClockTime('0817')!, parseClockTime('0813')!)).toBe(-4);
  });

  it('is zero for an exact arrival', () => {
    expect(minutesLate(435, 435)).toBe(0);
  });

  it('folds a delay across midnight instead of reading it as a 23-hour delay', () => {
    // Scheduled 2350, arrived 0015. Twenty-five minutes late, not 1415.
    expect(minutesLate(parseClockTime('2350')!, parseClockTime('0015')!)).toBe(25);
  });

  it('folds an early arrival across midnight', () => {
    expect(minutesLate(parseClockTime('0015')!, parseClockTime('2350')!)).toBe(-25);
  });

  it('still reports a genuinely long delay inside the half-day bound', () => {
    // Eleven hours late is absurd but real, and must not be folded away.
    expect(minutesLate(parseClockTime('0800')!, parseClockTime('1900')!)).toBe(660);
  });
});

describe('minutesLateFromClockTimes', () => {
  it('returns null when either time is absent', () => {
    expect(minutesLateFromClockTimes('0817', '')).toBeNull();
    expect(minutesLateFromClockTimes('', '0851')).toBeNull();
  });

  it('computes the delay when both are present', () => {
    expect(minutesLateFromClockTimes('0817', '0851')).toBe(34);
  });
});
