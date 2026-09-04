# flex-route-optimizer

Two small phone-first web apps, no install and no account. Both run entirely in the
browser and keep their data on your device.

| App | Live link | What it does |
|---|---|---|
| **Flex Route Optimizer** | [`/`](https://hrhynds.github.io/flex-route-optimizer/) | Reads Amazon Flex stop screenshots and builds an optimised driving route. |
| **Bill Cushion** | [`/bills/`](https://hrhynds.github.io/flex-route-optimizer/bills/) | Works out exactly what to set aside each workday so every bill is fully funded days before it's due. |

---

## Bill Cushion

### The rule it enforces

Every bill has to be **fully funded before its due date**, not on it. That gap is the
cushion — 5 days by default.

```
cushion date = due date − cushion (counted in workdays, or calendar days)
per day      = money still needed ÷ funding days left until the cushion date
```

Funding days are the days you actually earn, so a $95 phone bill due the 15th with a
5-day cushion is spread across the workdays up to the 10th — not across every calendar
day, and not right up to the wire.

It recalculates from what you've genuinely banked, every day. Miss a day and tomorrow's
number rises just enough to stay on time; put aside extra and every later day gets
cheaper. You cannot quietly drift behind.

The same recalculation runs the moment anything changes — add a bill, delete one, fix a
wrong due date or a wrong amount — and every figure re-prices immediately: today's total,
each bill's daily share, the month calendar and the month totals.

Every bill card holds to one invariant, so the numbers can be trusted at a glance:

```
daily rate × funding days left = money still needed
```

### What's in it

- **Today** — one number: what to set aside right now, split per bill. One tap logs it
  and marks the day complete. "Different amount" takes whatever you actually have and
  splits it most-urgent-first; "Couldn't today" logs the day honestly and re-spreads
  the shortfall.
- **Bills** — a progress bar per bill showing money banked against the total, a pace
  marker for where you should be, and a status badge (on track / behind / due now /
  fully funded). Mark one paid and it rolls to the next cycle, carrying any surplus.
  Tap any bill to correct its amount or due date on the spot — with −1 day / +1 day /
  +1 week / +1 month nudges and a preview of the new daily figure before you commit.
  Add a bill from the ＋ in the header on any tab; delete one from its own sheet.
- **Plan** — a month calendar with the required amount on every future day, dropping
  as bills finish. Completed days, missed days and days off are all marked.
- **More** — your workday pattern, cushion length, rounding, and backup/restore.

### Details worth knowing

- **Days off cost nothing.** Only the days you work carry a target. Any single day can
  be flipped between workday and day off from the calendar.
- **The cushion counts workdays by default** (six of them), so "fully funded before it's
  due" means six *working* days of margin, not six calendar days that a weekend can eat.
  Switch it to calendar days under More.
- **Bills on a payment plan** can follow a set list of debit dates instead of a day of the
  month — paste the dates in and each payment steps to the next one. Once the list runs
  out it keeps the same rhythm.
- **Money you already have** goes in under More → "Money I already have set aside". It
  fills the most urgent bills first and lowers every daily amount from there.
- **Overpaying is never lost.** It fills every bill, and anything beyond that is banked
  as buffer.
- **Rounding.** The daily ask can round up to the nearest $1, $5 or $10 for easier
  cash handling — which finishes each bill slightly early.
- **Storage.** Everything lives in this device's browser storage. Nothing is uploaded.
  Clearing Safari data erases it, so use **More → Save backup** now and then.

### Add it to your iPhone

Open the link in Safari, tap **Share ⬆︎ → Add to Home Screen**. It then opens full
screen like a normal app and works with no signal.
