/**
 * A command-line scan, so a real commute can be checked against real memory.
 *
 * This is the verification tool, not a product surface. It exists because the
 * only thing the test suite cannot prove is whether the checker is right about
 * the railway.
 */

import { clientFromEnv } from './hsp/client.js';
import { HspError } from './hsp/errors.js';
import { FileCache } from './hsp/cache.js';
import { runScan, type ScanRequest } from './scan.js';
import { addDays } from './domain/window.js';
import { describeExpiry, describeOutcome, describeWhereToClaim } from './domain/copy.js';
import type { DayType } from './hsp/client.js';
import type { JourneyAssessment } from './domain/types.js';

const USAGE = `
Scan a commute for journeys that look claimable.

  npm run scan -- --from LBG --to HSK --depart 1835 --days 7
  npm run scan -- --from HSK --via CLJ --to SPB --depart 0703

Options:
  --from CRS        Origin station code.            (required)
  --to CRS          Destination station code.       (required)
  --depart HHMM     Timetabled departure you take.  (required)
  --via CRS         Where you change trains, if you do. The connection is
                    taken from the timetable, not asked for.
  --days N          How many days back to look. Default 28, the claim window.
  --on weekday|saturday|sunday
                    Which days to check. Default weekday.
  --window MINS     Override the operator's Delay Repay threshold.
  --today YYYY-MM-DD
                    Pretend today is this date.
  --no-cache        Skip the on-disk cache.
`.trim();

interface Options {
  readonly request: ScanRequest;
  readonly useCache: boolean;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  const bare = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      bare.add(name);
    } else {
      flags.set(name, next);
      i += 1;
    }
  }

  if (bare.has('help') || flags.has('help')) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const from = flags.get('from')?.toUpperCase();
  const to = flags.get('to')?.toUpperCase();
  const depart = flags.get('depart');
  const via = flags.get('via')?.toUpperCase() ?? null;
  if (via !== null && !/^[A-Z0-9]{3}$/.test(via)) fail(`--via must be a station code like CLJ, not "${via}".`);

  if (!from || !to || !depart) fail(`Missing --from, --to or --depart.\n\n${USAGE}`);
  if (!/^\d{4}$/.test(depart)) fail(`--depart must be a 24-hour time like 1835, not "${depart}".`);

  const today = flags.get('today') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) fail(`--today must look like 2026-09-15.`);

  const days = Number(flags.get('days') ?? 28);
  if (!Number.isInteger(days) || days < 1) fail('--days must be a whole number of days.');

  const onRaw = (flags.get('on') ?? 'weekday').toUpperCase();
  const on = onRaw as DayType;
  if (!['WEEKDAY', 'SATURDAY', 'SUNDAY'].includes(on)) {
    fail('--on must be weekday, saturday or sunday.');
  }

  const thresholdRaw = flags.get('window');
  const thresholdMinutes = thresholdRaw === undefined ? null : Number(thresholdRaw);
  if (thresholdMinutes !== null && !Number.isInteger(thresholdMinutes)) {
    fail('--window must be a whole number of minutes.');
  }

  // A narrow band around the departure. Wide bands are unusable at a busy
  // station, and the point is the one train the commuter actually takes.
  const departMinutes = Number(depart.slice(0, 2)) * 60 + Number(depart.slice(2));
  const pad = (minutes: number): string => {
    const wrapped = ((minutes % 1440) + 1440) % 1440;
    return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}${String(wrapped % 60).padStart(2, '0')}`;
  };

  return {
    useCache: !bare.has('no-cache'),
    request: {
      from,
      to,
      via,
      fromDate: addDays(today, -days),
      toDate: today,
      fromTime: pad(departMinutes - 5),
      toTime: pad(departMinutes + 5),
      scheduledDeparture: depart,
      days: on,
      today,
      thresholdMinutes,
    },
  };
}

function formatJourney(journey: JourneyAssessment): string {
  const lines: string[] = [];
  const marker = journey.looksClaimable ? '>>' : journey.needsManualCheck ? ' ?' : '  ';
  lines.push(`${marker} ${journey.date}  ${describeOutcome(journey)}`);

  const times = [
    journey.scheduledDeparture ? `dep ${journey.scheduledDeparture}` : null,
    journey.actualDeparture ? `actual ${journey.actualDeparture}` : null,
    journey.scheduledArrival ? `arr ${journey.scheduledArrival}` : null,
    journey.actualArrival ? `actual ${journey.actualArrival}` : null,
  ].filter((part): part is string => part !== null);
  if (times.length > 0) lines.push(`     ${times.join('  ')}`);

  if (journey.looksClaimable) {
    lines.push(`     ${describeExpiry(journey.claimWindow)} ${describeWhereToClaim(journey)}`);
  }
  for (const note of journey.notes) lines.push(`     note: ${note}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { request, useCache } = parseArgs(process.argv.slice(2));

  let client;
  try {
    client = clientFromEnv();
  } catch (error) {
    if (error instanceof HspError && error.kind === 'auth') fail(error.message);
    throw error;
  }

  process.stdout.write(
    `Scanning ${request.from} to ${request.to}` +
      (request.via ? `, changing at ${request.via},` : '') +
      ` the ${request.scheduledDeparture} ` +
      `departure, ${request.fromDate} to ${request.toDate}.\n\n`,
  );

  const result = await runScan(client, request, useCache ? { cache: new FileCache('.cache/hsp') } : {});

  for (const journey of result.assessments) {
    process.stdout.write(`${formatJourney(journey)}\n`);
  }

  // The scan's own summary, not one recomputed from the assessments here. A
  // scan that read nothing has no assessments, and summarising that list alone
  // would announce "no journeys look claimable" about journeys never checked.
  process.stdout.write(`\n${result.summary}\n`);

  // The "could not check" list itemises which journeys were lost. A failure the
  // summary has already spelled out in full adds nothing by being repeated -
  // but anything it has not said still has to be shown, so this filters on what
  // the summary actually contains rather than assuming.
  const itemised = result.failures.filter((failure) => !result.summary.includes(failure.message));

  if (itemised.length > 0) {
    process.stdout.write('\nCould not check:\n');
    for (const failure of itemised) {
      // A failure with neither date nor RID cost us the whole range, not one
      // journey. Printing a bare "-" hid the difference.
      const scope = failure.date ?? failure.rid ?? 'the whole range';
      process.stdout.write(`  ${scope.padEnd(12)}  ${failure.message}\n`);
    }
  }

  if (result.coverage.checked > 0) {
    process.stdout.write(
      '\nCheck these against your own memory of the journey. If one is wrong, that ' +
        'is the bug worth chasing.\n',
    );
  }

  // Nothing was read. Exit non-zero so this cannot be mistaken - by a script or
  // by a tired person - for a clean scan that found nothing to claim.
  if (result.coverage.checked === 0 && result.coverage.expected > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
