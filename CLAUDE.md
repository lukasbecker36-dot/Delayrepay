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

### Verification

The author commutes on this route. Every result must be checkable against their
own memory of whether that train was actually late. Build for that route first
and check real journeys before adding anyone else.

If the tool says a train was fine and the author remembers standing on a platform
for 25 minutes, that discrepancy is the most important bug report available.
Chase it rather than explaining it away.

---

## Before charging money

Three things to confirm, not assume:

1. Rail Data Marketplace terms on commercial use of HSP data.
2. Whether flagging claims (as opposed to submitting them) carries any
   claims-management regulatory implications. Flagging is very likely fine —
   confirm rather than hope.
3. How a delay is assessed when the booked train terminates short and the
   passenger completes the journey on another one. The tool measures to the
   first train that could have carried them on, and the scheme is understood to
   work the same way — but that has not been read from the National Rail
   Conditions of Travel or from an operator's terms. It decides whether
   `src/domain/onward.ts` is doing the operator's own arithmetic or merely a
   defensible approximation of it, and the result copy differs between the two.

---

## Out of scope

- Submitting claims
- Handling compensation money
- Affiliate links, gift guides, or commuter product content — the user arrives
  wanting money they are owed, not shopping. Intent mismatch, and it undermines
  trust in the one thing the product is for.
