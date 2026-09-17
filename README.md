# Delay Repay Checker

Scans a UK rail commute against historical performance data and flags journeys
that look claimable under Delay Repay.

It is a checker, not a claims submitter. See `CLAUDE.md` for the product
boundaries — they are deliberate, and the code is built to hold them.

## Status

v0. The lookup core is built and tested, and has been run against live HSP on
the author's own commute; there is no UI yet. See **Before this is usable**
below for where each operator's terms came from.

## Setup

```sh
npm install
cp .env.example .env    # then fill in your HSP credentials
npm test
```

Credentials come from `HSP_EMAIL` and `HSP_PASSWORD`. Register at the National
Rail Data Portal with the Historical Service Performance subscription ticked.
`.env` is gitignored and must stay that way.

## Running a scan

```sh
npm run scan -- --from LBG --to HSK --depart 1835 --days 7
```

`--via CRS` checks a journey with a change: the connection is taken from the
timetable, not asked for. `--on weekday|saturday|sunday` picks which days, `--days N` how far back
(default 28, the claim window), `--window MINS` overrides the operator's
threshold, `--today YYYY-MM-DD` pretends it is another date. The time band is
derived as five minutes either side of `--depart`, because the point is the one
train you actually take, and wide bands are unusable at a busy station.

Marks in the output: `>>` looks claimable, ` ?` could not be checked.

## Use as a library

```ts
import { clientFromEnv, runScan, scanRange, FileCache } from './src/index.js';

const today = new Date().toISOString().slice(0, 10);
const { from, to } = scanRange(today);   // the 28 days that still have something to claim

const result = await runScan(
  clientFromEnv(),
  {
    from: 'BTN',
    to: 'VIC',
    fromDate: from,
    toDate: to,
    fromTime: '0700',
    toTime: '0730',
    scheduledDeparture: '0715',  // the train you actually take
    today,
  },
  { cache: new FileCache('.cache/hsp') },
);

console.log(result.summary);
for (const journey of result.assessments.filter((j) => j.looksClaimable)) {
  console.log(journey.date, describeOutcome(journey), describeExpiry(journey.claimWindow));
}
```

Keep the time band narrow. At a busy station a wide band returns a response
large enough to be unusable, and pinning `scheduledDeparture` is what makes the
results *your* journeys rather than every service in the band.

## How it is put together

| Path | What it does |
| --- | --- |
| `src/domain/classify.ts` | Turns one service record into one verdict. Pure; no network, no clock. **This is the product.** |
| `src/domain/time.ts` | HHMM parsing and delay arithmetic, including the midnight wrap. |
| `src/domain/window.ts` | The 28-day claim window and the scan range it implies. |
| `src/domain/copy.ts` | Every user-facing sentence, in one file so the language stays fixed. |
| `src/domain/operators.ts` | TOC codes → operator, threshold, claim page. |
| `src/domain/onward.ts` | The first train onward after a service stops short of the destination. |
| `src/domain/changeTimes.ts` | Minimum change time at a station, from the timetable feed. |
| `src/domain/connection.ts` | A journey with a change: planned connection, train caught, delay, operator responsible, and gaps in the data. |
| `src/domain/classifyChange.ts` | Scores a journey with a change into the same result as any other. |
| `scripts/import-change-times.mjs` | Regenerates `changeTimes.data.ts` from the feed's MSN and TSI files. Rerun at each timetable change. |
| `src/domain/clockChange.ts` | Detects the two nights a year when clock arithmetic lies. |
| `src/domain/bankHolidays.ts` | Bank holidays in England and Wales and in Scotland, named when a train is missing on one. |
| `scripts/import-bank-holidays.mjs` | Regenerates `bankHolidays.data.ts` from GOV.UK. Rerun yearly, or when a one-off holiday is announced. |
| `src/hsp/` | The HSP client, response parsing, typed failures, and the route+date cache. |
| `src/scan.ts` | Fetch, cache, classify. Thin by design. |
| `src/cli.ts` | The verification tool: run a real commute, check it against memory. |

The domain layer has no dependency on the HSP layer, so the judgement can be
tested without a network. 238 tests, all offline.

## What the checker will and will not say

It says a journey **"looks claimable"**. It never says a claim is valid and
never puts a figure on one, because the data cannot support either claim.
`test/copy.test.ts` asserts that no banned construction can reach the user
across every outcome the classifier can produce — if you add an outcome, that
test needs updating before it can honestly claim to have checked it.

Three behaviours follow directly from HSP's limitations, and all three are load-bearing:

- **A cancelled train is inferred, never reported.** HSP has no cancellation
  field, so a missing arrival is the strongest signal available. Those journeys
  come back as `arrival-not-recorded`, flagged claimable *and* flagged for a
  manual check. Reason code 574 is attached to both delays and cancellations,
  so it is surfaced and explicitly described as settling nothing.
- **A train HSP never saw is surfaced, not dropped.** A service struck from the
  day's plan — as happens during industrial action — is simply absent. Silence
  would read as "your train was fine", so those days come back as
  `service-not-found` with the reason named.
- **A gap caused by our own failed lookup is never reported as a missing train.**
  If a `serviceDetails` call fails, the affected dates come back as scan
  *failures*, not as findings. Saying "we could not see this service" when the
  truth is "we could not ask" would be a lie in the direction that matters most.
- **Nor is a date the data has not reached yet.** HSP lags the railway, and
  today's train may not have run. Inside `DATA_SETTLING_DAYS` an absent service
  comes back as `awaiting-data` — not claimable, but nothing asked of the user
  either, because there is nothing yet to check.

A scan also degrades rather than collapses: if HSP is slow, rate-limiting, or
down, `runScan` returns whatever it could check, names what it could not, and
hands the request back intact so the user never retypes their route.

## Before this is usable

Every operator in `src/domain/operators.ts` has a threshold, read on
2026-09-16/17 and stamped with where it came from:

All of them come from the operator's own Delay Repay page or conditions, with
a claim link, and agree with the rail regulator's table of schemes. Most were
fetched directly. CrossCountry, East Midlands Railway, Grand Central, Greater
Anglia, Hull Trains, Merseyrail, Northern and ScotRail refuse automated reading,
so their pages were read in a browser and the figures and claim links copied
in. Heathrow Express has no claim link on file; its conditions of carriage are
the source.

Thresholds are not all 15 minutes. LNER, Lumo, Hull Trains, CrossCountry,
ScotRail, Caledonian Sleeper, Heathrow Express and Merseyrail pay from 30; Grand
Central from 60; London Overground and the Elizabeth line for more than 30, and
only for delays TfL treats as within its control.

These are facts about published policy that change without notice. Recheck them
against `policySource`; for the eight read in a browser, that means reading them
in a browser again.

A journey whose train terminated short is measured to the first train that
left for the destination afterwards, which is what operators check a claim
against. See "How a delay is measured" in `CLAUDE.md`.

Also outstanding, per `CLAUDE.md`, and both to confirm rather than assume before
any money changes hands: Rail Data Marketplace terms on commercial use of HSP
data and the RDG timetable feed, and whether flagging claims carries
claims-management regulatory implications.

## Verification

The tests prove the logic is self-consistent. They do not prove it is right
about the railway — only a real route can do that.

Run a scan on the author's own commute and check the results against memory.
If the tool says a train was fine and you remember standing on a platform for
25 minutes, that discrepancy is the most important bug report available. Chase
it; do not explain it away. Start there before adding a second route.
