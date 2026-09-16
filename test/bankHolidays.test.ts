import { describe, expect, it } from 'vitest';
import { bankHolidayNote, bankHolidaysOn } from '../src/domain/bankHolidays.js';
import { classifyJourney } from '../src/domain/classify.js';

describe('bank holidays', () => {
  it('knows a holiday in England and Wales that Scotland does not share', () => {
    // 2026's summer bank holiday: 31 August in England and Wales.
    expect(bankHolidaysOn('2026-08-31')).toEqual([
      { region: 'England and Wales', title: 'Summer bank holiday' },
    ]);
  });

  it('knows a holiday in Scotland that England and Wales do not share', () => {
    // ...and 3 August in Scotland.
    expect(bankHolidaysOn('2026-08-03')).toEqual([{ region: 'Scotland', title: 'Summer bank holiday' }]);
  });

  it('knows a holiday shared by both', () => {
    expect(bankHolidaysOn('2026-12-25').map((h) => h.region)).toEqual(['England and Wales', 'Scotland']);
  });

  it('says nothing about an ordinary day', () => {
    expect(bankHolidaysOn('2026-09-07')).toEqual([]);
    expect(bankHolidayNote('2026-09-07')).toBeNull();
  });

  it('names one region, or both once when they share the holiday', () => {
    expect(bankHolidayNote('2026-08-31')).toContain('a bank holiday in England and Wales (Summer bank holiday)');
    expect(bankHolidayNote('2026-08-03')).toContain('a bank holiday in Scotland (Summer bank holiday)');
    expect(bankHolidayNote('2026-12-25')).toContain('a bank holiday in England, Wales and Scotland (Christmas Day)');
  });

  it('is added when a train cannot be found on a bank holiday', () => {
    const result = classifyJourney({
      record: null,
      from: 'HSK',
      to: 'CLJ',
      date: '2026-08-31',
      today: '2026-09-17',
    });
    expect(result.outcome).toBe('service-not-found');
    expect(result.notes.join(' ')).toContain('2026-08-31 was a bank holiday in England and Wales');
    expect(result.notes.join(' ')).toContain('different timetable');
  });

  it('is not added when the missing train was on an ordinary day', () => {
    const result = classifyJourney({
      record: null,
      from: 'HSK',
      to: 'CLJ',
      date: '2026-09-07',
      today: '2026-09-17',
    });
    expect(result.notes.join(' ')).not.toContain('bank holiday');
  });
});
