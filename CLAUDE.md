# Delay Repay Checker

A tool that scans a UK rail commute against historical performance data and flags
journeys that look claimable under Delay Repay.

**Status:** v0, built for a single user's own commute. No accounts, no payments,
no other users yet. Do not build for scale before the core lookup is proven correct.

---

## What this is and isn't

**It is:** a checker. It tells someone which of their recent journeys appear to
qualify, and links them to the operator's claim page.

**It is not:** a claims submitter. It never files a claim on anyone's behalf,
never handles claim money, never asks for bank details. This is a deliberate
product boundary, not a missing feature — submitting on behalf of users changes
the regulatory position and creates liability for rejected claims. Do not add it.

The gap being served: every automatic Delay Repay scheme (operator ADR, Trainline
notifications) excludes season tickets and open returns. Daily commuters — the
people with the most claims — are the group no automation currently covers.

---

## Data source: HSP

Historical Service Performance, via the National Rail Data Portal. Free, requires
registration with the HSP subscription box ticked. Powered by Darwin. Holds up to
one year of history.

Two calls: `serviceMetrics` (summary across a station pair, time band, date range)
and `serviceDetails` (one service by RID).

### Known limitations — these shape the product, treat them as load-bearing

1. **No CORS.** No `Access-Control-Allow-Origin` header. Cannot be called from
   browser JS. All HSP calls go server-side. This is fine — credentials should
   never reach the client anyway.

2. **Cancellations are inferred, not reported.** HSP returns actual times at the
   end of the service. A cancelled leg shows up as an *absent* actual time, and
   reason code 574 can mean either a delay or a cancellation. Since cancellations
   are a large share of real claims, the tool is systematically less reliable on
   exactly the cases that matter most.

3. **Industrial action services can be invisible.** If a service was removed from
   the day's train plan entirely, it never appears in Darwin and therefore never
   in HSP. Those journeys cannot be detected at all.

4. **Time bands must be limited** at busy stations or responses become unwieldy.

### Because of 2 and 3, the output language is fixed

Say **"this looks claimable"**. Never "you are owed £X" or "you have a valid
claim". The tool surfaces candidates for the user to check; it does not
adjudicate. Any copy that implies certainty is a bug — fix the copy, don't
caveat it in a footnote.

---

## The 28-day window is the product

Delay Repay claims must be made within 28 days of the journey. That constraint
drives everything:

- The free scan covers exactly 28 days. Not a paywall — beyond that there is
  nothing to claim, so nothing is being withheld.
- Reminders are driven by **time to expiry**, not fixed intervals. "Expires in
  3 days" is the message that works; "you have an unclaimed delay" is not.
- Batch reminders. One email listing four claimable journeys, never four emails.

---

## Free vs paid

**Free:** enter route + date range, get every claimable-looking journey with
links. No account required for a scan. Do not gate the first result behind an
email — it kills the one moment that makes people tell colleagues, and it reads
as bait-and-switch in a product whose entire value is trustworthiness.

**Paid (later):** automatic monitoring of a registered commute, expiry-driven
reminders, multiple routes.

The retrospective scan is one-time value and is the advert for the recurring
product. It does not cannibalise it.

---

## Privacy

Commute data is sensitive — it reveals where someone lives, works, and when they
travel. Rules:

- Store the minimum needed. Route, dates, claim status. Nothing else.
- No third-party analytics or trackers on pages handling journey data.
- Never share or sell journey data. If a B2B route ever happens, the employer
  pays but never sees user data — that separation must hold in the schema, not
  just in policy.
- Deletion must actually delete.

---

## Engineering notes

- **Cache aggressively by route + date.** Every user on the same line asks the
  same question. HSP results for a past date never change.
- Credentials in env vars, never committed.
- Handle HSP being down or slow without losing the user's input.
- Build the lookup logic as a testable unit separate from any UI — correctness
  here is the whole product.
- **Bank holidays change the timetable.** A commuter's usual train may not exist
  on one: on 31 August 2026 (England and Wales) the 07:03 from Hassocks ran as a
  07:02. England and Wales and Scotland keep different lists - that year's
  summer bank holiday was 31 August in one, 3 August in the other - so both are
  checked, and a train missing on either's holiday says so. Dates come from
  GOV.UK via `scripts/import-bank-holidays.mjs`; rerun it yearly.

### Verification

The author commutes on this route. Every result must be checkable against their
own memory of whether that train was actually late. Build for that route first
and check real journeys before adding anyone else.

If the tool says a train was fine and the author remembers standing on a platform
for 25 minutes, that discrepancy is the most important bug report available.
Chase it rather than explaining it away.

---

## How a delay is measured

Against the arrival time in the published timetable for the day, at the
destination station — not the delay to any one train (National Rail Conditions
of Travel 33.1; GTR Passenger's Charter §14).

When the booked train is cancelled or terminates short, the journey is measured
to the **first train that actually left for the destination** after the
passenger was set down (`src/domain/onward.ts`). The terms, read 2026-09-16:

- GTR's Charter asks for "the time of the train you took if you are delayed due
  to a cancellation", and checks claims for "impossible journey combinations".
- South Western Railway states the check outright: operators "base their
  assessment for compensation on you catching the next available train".

So the passenger names a train and the operator tests it against what was
available. Waiting for a later train does not raise the delay.

The same rule covers every way a train can fail to take someone to their
destination, on a single train and on either side of a change:

| What the data shows | Measured from |
| --- | --- |
| No time recorded anywhere from the origin on (**cancelled**) | the origin, at the booked departure, no change time |
| Recorded before and after the origin but not at it (did not stop there) | the origin, at the booked departure, no change time |
| Last recorded before the destination, never after (stopped short) | that station, at the time recorded, plus its change time |
| Recorded after the destination but not at it (ran past without calling) | **both** the last station before, and the next station after (a train back) |
| A connecting train left, was recorded further on, but never reached the destination | not a way on; measured to the next train that got there |

A train that ran past without calling raises a question the data cannot
answer: was the change of plan announced in time to get off before it, or was
the passenger carried on? Both are measured. The result uses getting off
before, unless only being carried on is over the threshold - a possible claim
is not dropped on a guess - and a note gives the other figure.

**A train with no recorded times is cancelled.** Decided 2026-09-17: when
nothing is recorded for it from the origin on - not there, not at any stop
after - the result says it was cancelled rather than hedging. A train that ran
leaves times behind. One that left the origin and was never recorded again is
not called cancelled; the data does not say what happened to it.

A train at the start of its run with no departure recorded, but recorded
later, is a gap in the data, not a skipped stop: a train cannot skip where it
starts. Unverified: whether HSP ever records a pass time at a station a train
ran through as an arrival, which would read as the train having called.

**The app never asks which train was taken.** There is no input for it, by
design. The first available train is the figure to report, and the copy says
so; it must not invite the user to claim on a later arrival. The only exception
it names is a train they could not board.

"Could have caught" means leaving at least the timetable's **minimum change
time** after the passenger was set down. Every station has one (Haywards Heath
3 minutes, Clapham Junction 10), and some pairs of operators have their own
(Clapham Junction Southern to Southern: 5). They come from the RDG timetable
feed on the National Rail Data Portal - the MSN and TSI files - via
`scripts/import-change-times.mjs`, into `src/domain/changeTimes.data.ts`. Rerun
the import when the timetable changes. A train that left inside the change time
is not counted, but the result names it.

### Journeys with a change

`src/domain/connection.ts`, scored by `classifyChange.ts`; `--via` on the CLI.
Decided 2026-09-16, for a route like Hassocks to Shepherd's Bush via Clapham
Junction:

- **The planned connection** is the first timetabled train, of any operator,
  leaving the change station at least the change time after the planned
  arrival there - what a journey planner would give. It sets the planned
  arrival at the destination.
- **After a delay**, any operator's train counts as a way onward.
- **London Overground is left out of connections**, decided 2026-09-17: never
  the planned connection, never the way on, never counted as missing
  (`CONNECTION_OPERATORS_LEFT_OUT` in `src/scan.ts`). Results say so when an
  Overground train was left out. Single-train Overground journeys are unaffected.
- The delay is measured at the final destination. The operator responsible is
  the one whose delay first broke the plan; if every connection was made, the
  operator of the last leg.
- **A first train that never reaches the change station** is followed from
  where it left the passenger, by the same first-train-available rule: from
  the origin at its booked departure if it never ran (no change time - they
  were on the platform), or from the last station it was recorded at, allowing
  that station's change time, if it stopped short. That train's arrival goes
  through the connection against the original plan, and the first train's
  operator answers for a broken plan. Always flagged to check. On 25 August 2026
  the 07:03 from Hassocks never ran; the 07:32 reached Clapham Junction at 08:28,
  in time for the planned 08:38 - 2 minutes late, not a claim.

**HSP's London Overground data has gaps, and they decide results.** Over 21
weekdays at Clapham Junction, Southern's 07:39 was recorded every day; each
Overground departure on 4 to 10 of them, and some recorded trains have no
arrival. A gap can only make a delay look worse - the missing train may have
been the way on. So the planned timetable is taken from every day in the range,
and each result carries a best case as if every gap ran to time. Where the
threshold falls between the recorded delay and the best case, the outcome is
`unconfirmed`: not claimable, flagged to check. On Hassocks to Shepherd's Bush
that was most days, which is why the Overground is now left out.

Darwin itself looks complete: on 16 September it showed four Overground trains
from Clapham Junction to Shepherd's Bush running with actual times that HSP did
not have (not yet re-checked once HSP had settled). Darwin's FTP keeps only
about an hour of push port logs, so it cannot fill past gaps; recording it
continuously is the route to complete Overground data if it is ever wanted.

---

## Before charging money

Two things to confirm, not assume:

1. Rail Data Marketplace terms on commercial use of HSP data, and of the RDG
   timetable feed that the change times are generated from.
2. Whether flagging claims (as opposed to submitting them) carries any
   claims-management regulatory implications. Flagging is very likely fine —
   confirm rather than hope.

---

## Out of scope

- Submitting claims
- Handling compensation money
- Affiliate links, gift guides, or commuter product content — the user arrives
  wanting money they are owed, not shopping. Intent mismatch, and it undermines
  trust in the one thing the product is for.
