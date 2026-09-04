# flex-route-optimizer

Two small phone-first web apps, no install and no account. Both run entirely in the
browser and keep their data on your device.

| App | Live link | What it does |
|---|---|---|
| **Flex Route Optimizer** | [`/`](https://hrhynds.github.io/flex-route-optimizer/) | Reads Amazon Flex stop screenshots and builds an optimised driving route. |
| **Ledger** | [`/bills/`](https://hrhynds.github.io/flex-route-optimizer/bills/) | Money in, money out, and what's genuinely left after a partner's cut, tax and the day's share of the bills. |

---

## Ledger

Two halves that answer one question — *what is actually mine today?*

### The day's chain

Every day runs the same way:

```
money in                       what jobs brought in
− what it cost you             supplies, fuel, equipment
− your partner's cut           % of takings, % of profit, per job, or per day
− tax put by                   off by default; a share of what's left when on
− today's share of the bills   the cushion, below
= what you keep
```

Run backwards, that same chain gives **break-even**: what the day has to bring in
before you are working for nothing. It's on the Today screen while the day is still
short, and as a dashed line across the 14-day chart.

Nothing is a lump sum. A job is logged with its amount, service, customer and how it
was paid; an expense with its category. Both are editable and deletable, and every
figure in the app re-runs the moment either changes.

**Money that isn't yours** is tracked as a running balance rather than a vague
feeling — what has built up for your partner, and what tax is being held. Record a
payment against either and the balance clears down.

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

- **Today** — what you keep, the chain that gets there, the jobs and costs behind it,
  and the bill money still to move. One tap sets the bills aside and completes the day.
  "Different amount" takes whatever you actually have and splits it most-urgent-first;
  "Couldn't today" logs the day honestly and re-spreads the shortfall.
- **Business** — the month so far, a 14-day chart of money in against break-even, where
  the month's money went, balances owed, your best-earning services, what the work costs
  you, and a day-by-day list.
- **Bills** — a progress bar per bill showing money banked against the total, a pace
  marker for where you should be, and a status badge (on track / behind / due now /
  fully funded). Mark one paid and it rolls to the next cycle, carrying any surplus.
  Tap any bill to correct its amount or due date on the spot — with −1 day / +1 day /
  +1 week / +1 month nudges and a preview of the new daily figure before you commit.
  Add a bill from the ＋ in the header on any tab; delete one from its own sheet.
  A bill can be added before you know its due date — it sits flagged as "needs a date"
  and stays out of the daily figure until you set one, rather than quietly skewing it.
- **Plan** — a month calendar with the required amount on every future day, dropping
  as bills finish. Completed days, missed days and days off are all marked.
- **More** — your workday pattern, cushion length, rounding, and backup/restore.

### Details worth knowing

- **Days off cost nothing.** Only the days you work carry a target. Any single day can
  be flipped between workday and day off from the calendar.
- **The cushion counts workdays by default** (six of them), so "fully funded before it's
  due" means six *working* days of margin, not six calendar days that a weekend can eat.
  Switch it to calendar days under More.
- **Unpredictable work is a first-class case.** If you don't know which days you'll earn,
  set the schedule to *Unpredictable* and say roughly how many days a week you work. Every
  day can then take money, the expected number of earning days before each due date is
  scaled by that rate, and six working days of cushion stretches to however long that
  actually takes — nine calendar days at five a week, fourteen at three. The app also
  measures what you really averaged over the last four weeks and says so if your estimate
  is off.
- **Slack: how many days you can still lose.** Each bill shows how many days you could set
  nothing aside and still pay on time. It starts at the cushion, drops a day for every idle
  day, and climbs back when you work more than your estimate — so the cost of a day off is
  visible before it becomes a problem rather than after.
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

### Setup links

A whole list of bills can arrive in one tap. Two forms, both of which open the app, show
what the link contains, and ask before doing anything — with the choice to replace what's
there or add to it. The fragment is cleared afterwards so a refresh won't ask twice, a
damaged link changes nothing, and both work whether or not the app is already open.

**Short form** — readable, and about a fifth the length, so it survives being pasted
through a chat app:

```
.../bills/#add=Name,amount,YYYY-MM-DD[,date1/date2/...];Name,amount,...&w=5&c=6&p=Logan:perJob:40&tax=0
```

`+` reads as a space, the optional fourth field is a list of payment dates, and the
parameters set: `w=` days worked a week, `c=` the cushion, `p=` who takes a cut
(`Name:mode:value`, where mode is `pctRevenue`, `pctProfit`, `perJob`, `perDay` or
`none`), `tax=` the rate held back (`0` turns it off). Rows that don't parse are skipped
rather than failing the whole link; a row with no date arrives as "needs a date". Icons
are worked out from the names.

**Settings-only** — the same parameters with no `add=` at all changes just those
settings, names in plain words what it is about to do, and leaves bills, jobs and
expenses exactly as they are:

```
.../bills/#p=Logan:perJob:40&tax=0
```

**Long form** — `#import=<url-safe base64 of a full backup>`, which carries everything a
backup does including contribution history.

Bill data rides in the URL *fragment*, which browsers never send to the server — so a
setup link doesn't leak amounts into anyone's access logs.

### Add it to your iPhone

Open the link in Safari, tap **Share ⬆︎ → Add to Home Screen**. It then opens full
screen like a normal app and works with no signal.
