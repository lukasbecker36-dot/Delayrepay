/**
 * Parsing HSP responses into the domain's shapes.
 *
 * Hand-rolled rather than schema-library-driven, because the interesting part
 * is not rejecting malformed JSON but preserving the difference between a field
 * that says "no time applies here" and one that says "no time was recorded".
 * HSP spells both as the empty string. Everything downstream turns on that
 * distinction, so it is normalised to null exactly once, here, and the reason
 * is documented rather than inferred.
 */

import type { ServiceCall, ServiceRecord } from '../domain/types.js';

export class HspSchemaError extends Error {
  override readonly name = 'HspSchemaError';
}

/** A service matching a station pair and time band, from `serviceMetrics`. */
export interface MatchedService {
  readonly rids: readonly string[];
  readonly originLocation: string;
  readonly destinationLocation: string;
  /** Public timetable departure, "HHMM". */
  readonly scheduledDeparture: string | null;
  /** Public timetable arrival, "HHMM". */
  readonly scheduledArrival: string | null;
  readonly tocCode: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** HSP writes an absent time as "". Everything downstream wants null. */
function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value);
  if (parsed === null) {
    throw new HspSchemaError(`HSP response is missing "${field}"`);
  }
  return parsed;
}

export function parseServiceMetrics(payload: unknown): readonly MatchedService[] {
  if (!isRecord(payload)) {
    throw new HspSchemaError('serviceMetrics response was not an object');
  }

  const services = payload['Services'];
  // No services in the band is a legitimate answer, not a malformed response.
  if (services === undefined || services === null) return [];
  if (!Array.isArray(services)) {
    throw new HspSchemaError('serviceMetrics "Services" was not an array');
  }

  return services.map((service, index) => {
    if (!isRecord(service)) {
      throw new HspSchemaError(`serviceMetrics Services[${index}] was not an object`);
    }
    const attributes = service['serviceAttributesMetrics'];
    if (!isRecord(attributes)) {
      throw new HspSchemaError(
        `serviceMetrics Services[${index}] is missing serviceAttributesMetrics`,
      );
    }

    const rawRids = attributes['rids'];
    const rids = Array.isArray(rawRids)
      ? rawRids.flatMap((rid) => {
          const parsed = optionalString(rid);
          return parsed === null ? [] : [parsed];
        })
      : [];

    return {
      rids,
      originLocation: requiredString(attributes['origin_location'], 'origin_location'),
      destinationLocation: requiredString(
        attributes['destination_location'],
        'destination_location',
      ),
      scheduledDeparture: optionalString(attributes['gbtt_ptd']),
      scheduledArrival: optionalString(attributes['gbtt_pta']),
      tocCode: optionalString(attributes['toc_code']),
    };
  });
}

export function parseServiceDetails(payload: unknown): ServiceRecord {
  if (!isRecord(payload)) {
    throw new HspSchemaError('serviceDetails response was not an object');
  }
  const attributes = payload['serviceAttributesDetails'];
  if (!isRecord(attributes)) {
    throw new HspSchemaError('serviceDetails is missing serviceAttributesDetails');
  }

  const rawLocations = attributes['locations'];
  if (!Array.isArray(rawLocations)) {
    throw new HspSchemaError('serviceDetails "locations" was not an array');
  }

  const calls: ServiceCall[] = rawLocations.map((location, index) => {
    if (!isRecord(location)) {
      throw new HspSchemaError(`serviceDetails locations[${index}] was not an object`);
    }
    return {
      location: requiredString(location['location'], `locations[${index}].location`),
      scheduledDeparture: optionalString(location['gbtt_ptd']),
      scheduledArrival: optionalString(location['gbtt_pta']),
      actualDeparture: optionalString(location['actual_td']),
      actualArrival: optionalString(location['actual_ta']),
      lateCancReason: optionalString(location['late_canc_reason']),
    };
  });

  return {
    rid: requiredString(attributes['rid'], 'rid'),
    date: requiredString(attributes['date_of_service'], 'date_of_service'),
    tocCode: optionalString(attributes['toc_code']),
    calls,
  };
}
