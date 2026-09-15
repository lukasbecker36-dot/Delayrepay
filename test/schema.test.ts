import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HspSchemaError,
  parseServiceDetails,
  parseServiceMetrics,
} from '../src/hsp/schema.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'));
}

describe('parseServiceMetrics', () => {
  const services = parseServiceMetrics(fixture('serviceMetrics.json'));

  it('reads every service in the band', () => {
    expect(services).toHaveLength(2);
    expect(services[0]?.scheduledDeparture).toBe('0715');
    expect(services[1]?.scheduledDeparture).toBe('0745');
  });

  it('keeps the RIDs that identify each run', () => {
    expect(services[0]?.rids).toEqual([
      '202609070591234',
      '202609080591234',
      '202609090591234',
    ]);
  });

  it('carries the operator through', () => {
    expect(services[0]?.tocCode).toBe('SN');
  });

  it('treats no services in the band as an empty answer, not an error', () => {
    expect(parseServiceMetrics({ Services: [] })).toEqual([]);
    expect(parseServiceMetrics({})).toEqual([]);
    expect(parseServiceMetrics({ Services: null })).toEqual([]);
  });

  it('rejects a response it cannot read rather than guessing', () => {
    expect(() => parseServiceMetrics(null)).toThrow(HspSchemaError);
    expect(() => parseServiceMetrics('nope')).toThrow(HspSchemaError);
    expect(() => parseServiceMetrics({ Services: 'nope' })).toThrow(HspSchemaError);
    expect(() => parseServiceMetrics({ Services: [{}] })).toThrow(HspSchemaError);
  });
});

describe('parseServiceDetails', () => {
  it('reads the calls in order', () => {
    const record = parseServiceDetails(fixture('serviceDetails-delayed.json'));
    expect(record.rid).toBe('202609080591234');
    expect(record.date).toBe('2026-09-08');
    expect(record.tocCode).toBe('SN');
    expect(record.calls.map((c) => c.location)).toEqual(['BTN', 'HHE', 'VIC']);
  });

  it('turns an absent time into null rather than an empty string', () => {
    const record = parseServiceDetails(fixture('serviceDetails-delayed.json'));
    const origin = record.calls[0];
    expect(origin?.scheduledDeparture).toBe('0715');
    expect(origin?.scheduledArrival).toBeNull();
    expect(origin?.actualArrival).toBeNull();
    expect(origin?.lateCancReason).toBeNull();
  });

  it('preserves a cancelled service as missing times, not as zeroes', () => {
    const record = parseServiceDetails(fixture('serviceDetails-cancelled.json'));
    for (const stop of record.calls) {
      expect(stop.actualArrival).toBeNull();
      expect(stop.actualDeparture).toBeNull();
    }
    expect(record.calls.at(-1)?.scheduledArrival).toBe('0817');
  });

  it('keeps the ambiguous reason code instead of dropping it', () => {
    const record = parseServiceDetails(fixture('serviceDetails-delayed.json'));
    expect(record.calls.at(-1)?.lateCancReason).toBe('574');
  });

  it('rejects a response it cannot read', () => {
    expect(() => parseServiceDetails({})).toThrow(HspSchemaError);
    expect(() => parseServiceDetails({ serviceAttributesDetails: {} })).toThrow(HspSchemaError);
    expect(() =>
      parseServiceDetails({ serviceAttributesDetails: { rid: 'R', date_of_service: '2026-09-08', locations: [{}] } }),
    ).toThrow(HspSchemaError);
  });
});
