import { describe, expect, it } from 'vitest';
import { clockChangeOn, spansClockChange } from '../src/domain/clockChange.js';
import { parseClockTime } from '../src/domain/time.js';

describe('clockChangeOn', () => {
  it('finds the last Sunday in March and October', () => {
    expect(clockChangeOn('2026-03-29')).toBe('spring-forward');
    expect(clockChangeOn('2026-10-25')).toBe('autumn-back');
    expect(clockChangeOn('2027-03-28')).toBe('spring-forward');
    expect(clockChangeOn('2027-10-31')).toBe('autumn-back');
    expect(clockChangeOn('2025-03-30')).toBe('spring-forward');
    expect(clockChangeOn('2025-10-26')).toBe('autumn-back');
  });

  it('returns null on ordinary days, including the days either side', () => {
    expect(clockChangeOn('2026-03-28')).toBeNull();
    expect(clockChangeOn('2026-03-30')).toBeNull();
    expect(clockChangeOn('2026-09-15')).toBeNull();
  });

  it('lands on a Sunday every time', () => {
    for (let year = 2024; year <= 2035; year += 1) {
      for (const month of ['03', '10']) {
        const days = month === '03' ? 31 : 31;
        let found: string | null = null;
        for (let day = 1; day <= days; day += 1) {
          const date = `${year}-${month}-${String(day).padStart(2, '0')}`;
          if (clockChangeOn(date) !== null) found = date;
        }
        expect(found).not.toBeNull();
        expect(new Date(`${found}T00:00:00Z`).getUTCDay()).toBe(0);
      }
    }
  });
});

describe('spansClockChange', () => {
  const smallHours = [parseClockTime('0050'), parseClockTime('0210')];
  const morning = [parseClockTime('0715'), parseClockTime('0817')];

  it('flags a small-hours journey on a transition date', () => {
    expect(spansClockChange('2026-03-29', smallHours)).toBe('spring-forward');
    expect(spansClockChange('2026-10-25', smallHours)).toBe('autumn-back');
  });

  it('leaves a morning commute alone even on a transition date', () => {
    expect(spansClockChange('2026-03-29', morning)).toBeNull();
  });

  it('leaves a small-hours journey alone on an ordinary date', () => {
    expect(spansClockChange('2026-09-15', smallHours)).toBeNull();
  });

  it('ignores absent times', () => {
    expect(spansClockChange('2026-03-29', [null, null])).toBeNull();
  });
});
