export { classifyJourney, type ClassifyInput } from './domain/classify.js';
export {
  claimWindowFor,
  scanRange,
  addDays,
  daysBetween,
  CLAIM_WINDOW_DAYS,
  EXPIRING_SOON_DAYS,
  type ClaimWindow,
  type ClaimWindowStatus,
} from './domain/window.js';
export {
  minutesLate,
  minutesLateFromClockTimes,
  parseClockTime,
  formatClockTime,
} from './domain/time.js';
export {
  allOperators,
  findOperator,
  resolveThreshold,
  DEFAULT_MINIMUM_DELAY_MINUTES,
  type Operator,
  type ResolvedThreshold,
} from './domain/operators.js';
export { clockChangeOn, spansClockChange, type ClockChange } from './domain/clockChange.js';
export {
  describeExpiry,
  describeOutcome,
  describeWhereToClaim,
  summariseScan,
} from './domain/copy.js';
export type {
  Evidence,
  JourneyAssessment,
  JourneyOutcome,
  ServiceCall,
  ServiceRecord,
} from './domain/types.js';

export { HspClient, clientFromEnv, DEFAULT_BASE_URL, type DayType } from './hsp/client.js';
export { HspError, describeHspFailure, type HspFailureKind } from './hsp/errors.js';
export {
  parseServiceDetails,
  parseServiceMetrics,
  HspSchemaError,
  type MatchedService,
} from './hsp/schema.js';
export {
  cacheKey,
  isCacheable,
  FileCache,
  MemoryCache,
  NullCache,
  type ResponseCache,
} from './hsp/cache.js';

export { runScan, expectedDates, type ScanRequest, type ScanResult, type ScanFailure } from './scan.js';
