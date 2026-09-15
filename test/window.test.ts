import { describe, expect, it } from 'vitest';
import {
  addDays,
  CLAIM_WINDOW_DAYS,
  claimWindowFor,
  daysBetween,
  parseIsoDate,
  scanRange,
  toIsoDate,
} from '../src/domain/window.js';

describe('date arithmetic', () => {
  it('rejects malformed dates', () => {
    expect(() => parseIsoDate('2026-9-1')).toThrow(RangeError);
    expect(() => parseIsoDate('01/09/2026')).toThrow(RangeError);
    expect(() => parseIsoDate('not a date')).toThrow(RangeError);
  });

  it('rejects dates that do not exist', () => {
    expect(() => parseIsoDate('2026-02-30')).toThrow(RangeError);
    expect(() => parseIsoDate('2026-13-01')).toThrow(RangeError);
  });

  it('counts whole days between dates', () => {
    expect(daysBetween('2026-09-01', '2026-09-15')).toBe(14);
    expect(daysBetween('2026-09-15', '2026-09-01')).toBe(-14);
    expect(daysBetween('2026-09-15', '2026-09-15')).toBe(0);
  });

  it('counts days across a British Summer Time change without drifting', () => {
    // 2026-03-29 is the spring change. A naive local-time day count loses an
    // hour here and rounds a 28-day window down to 27.
    expect(daysBetween('2026-03-15', '2026-04-15')).toBe(31);
    expect(daysBetween('2026-10-10', '2026-11-10')).toBe(31);
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('round-trips through the epoch', () => {
    expect(toIsoDate(parseIsoDate('2026-09-15'))).toBe('2026-09-15');
  });
});

describe('claimWindowFor', () => {
  it('opens a 28-day window from the journey date', () => {
    const window = claimWindowFor('2026-09-15', '2026-09-15');
    expect(window.expiresOn).toBe('2026-10-13');
    expect(window.daysRemaining).toBe(CLAIM_WINDOW_DAYS);
    expect(window.status).toBe('open');
  });

  it('counts down as the window closes', () => {
    expect(claimWindowFor('2026-09-01', '2026-09-15').daysRemaining).toBe(14);
  });

  it('flags the last few days as expiring soon, and not the day before', () => {
    // Four days left is still routine; three is the point the reminder is
    // worth sending.
    expect(claimWindowFor('2026-08-22', '2026-09-15').daysRemaining).toBe(4);
    expect(claimWindowFor('2026-08-22', '2026-09-15').status).toBe('open');

    expect(claimWindowFor('2026-08-21', '2026-09-15').daysRemaining).toBe(3);
    expect(claimWindowFor('2026-08-21', '2026-09-15').status).toBe('expiring-soon');
    expect(claimWindowFor('2026-08-20', '2026-09-15').status).toBe('expiring-soon');
  });

  it('keeps the day the window closes claimable', () => {
    const window = claimWindowFor('2026-08-18', '2026-09-15');
    expect(window.expiresOn).toBe('2026-09-15');
    expect(window.daysRemaining).toBe(0);
    expect(window.status).toBe('expiring-soon');
  });

  it('marks the day after as expired', () => {
    const window = claimWindowFor('2026-08-17', '2026-09-15');
    expect(window.daysRemaining).toBe(-1);
    expect(window.status).toBe('expired');
  });
});

describe('scanRange', () => {
  it('covers exactly the window that still has something to claim', () => {
    const range = scanRange('2026-09-15');
    expect(range).toEqual({ from: '2026-08-18', to: '2026-09-15' });
    // The oldest date in the range is the oldest one still claimable today.
    expect(claimWindowFor(range.from, '2026-09-15').status).not.toBe('expired');
    expect(claimWindowFor(addDays(range.from, -1), '2026-09-15').status).toBe('expired');
  });
});
