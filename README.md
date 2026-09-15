# Delay Repay Checker

Scans a UK rail commute against historical performance data and flags journeys
that look claimable under Delay Repay.

It is a checker, not a claims submitter. See `CLAUDE.md` for the product
boundaries — they are deliberate, and the code is built to hold them.

## Status

v0. The lookup core is built and tested; there is no UI. Nothing has been run
against live HSP yet, and two pieces of operator data are deliberately blank —
see **Before this is usable** below.

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

`--on weekday|saturday|sunday` picks which days, `--days N` how far back
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
| `src/domain/clockChange.ts` | Detects the two nights a year when clock arithmetic lies. |
| `src/hsp/` | The HSP client, response parsing, typed failures, and the route+date cache. |
| `src/scan.ts` | Fetch, cache, classify. Thin by design. |
| `src/cli.ts` | The verification tool: run a real commute, check it against memory. |

The domain layer has no dependency on the HSP layer, so the judgement can be
tested without a network. 117 tests, all offline.

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

Thameslink (`TL`) is filled in: Delay Repay from 15 minutes, claims at
`delayrepay.thameslinkrailway.com`. That was recorded from search results
quoting Thameslink's own published terms — the operator's domain is blocked
from this environment, so it has not been read at source. Worth thirty seconds
to confirm before relying on it.

Every other operator still has two `null` fields in
`src/domain/operators.ts`, and the checker is honest about it rather than
guessing:

1. **`minimumDelayMinutes`** — the shortest delay each operator pays out on.
   Until it is filled in, journeys are scored against a 15-minute fallback and
   every such result carries a note saying the threshold was assumed. Some
   operators only pay from 30 minutes.
2. **`claimUrl`** — the operator's own Delay Repay page. Until it is filled in,
   results name the operator but cannot link to the claim form.

Both are facts about published policy that change without notice. A wrong
threshold silently loses the user money and a wrong claim link is worse than no
link in a product whose whole value is trustworthiness, so both must be read
from the operator's own terms and stamped with `policyLastConfirmed`. Start
with the one operator on the author's route.

Also outstanding, per `CLAUDE.md`, and both to confirm rather than assume before
any money changes hands: Rail Data Marketplace terms on commercial use of HSP
data, and whether flagging claims carries claims-management regulatory
implications.

## Verification

The tests prove the logic is self-consistent. They do not prove it is right
about the railway — only a real route can do that.

Run a scan on the author's own commute and check the results against memory.
If the tool says a train was fine and you remember standing on a platform for
25 minutes, that discrepancy is the most important bug report available. Chase
it; do not explain it away. Start there before adding a second route.
