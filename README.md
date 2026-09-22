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

The daily figure is a **suggestion, not a deduction**. Nothing leaves your money until
you tap **Set aside $X**, and you can put in more or less than it asks. What you keep
today only ever drops by money that has actually gone across.

Put in less and nothing is lost: once the day is closed out, the shortfall is spread
over the days that are left, and tomorrow's figure goes up to match. Put in more and it
goes down. Either way it adds up to the same bills, and the day says what the next one
will ask for before you decide.

Nobody is paid a share automatically. Every time you log money the switch is there and
**off**; you turn it on for the jobs that are theirs. Their running balance and a
**Record a payment** button sit on the first screen whether or not anything is owed, so
the option never disappears just because a day owed nothing.

Got it wrong? Tap the chip on any job for that one, or use **Paying <name> for this day**
to fix a whole day at once — today or any day gone by.

Anyone who prefers it moved for them can switch on **More → Move it without asking**,
which sends each day's takings — after costs, the cut and tax — to the bills on its own,
nearest due date first.

Run backwards, that same chain gives **break-even**: what the day has to bring in
before you are working for nothing. It's on the Today screen while the day is still
short, and as a dashed line across the 14-day chart.

Logging is two taps: amount, then **Log it**. Service, who paid, the customer, the date
and the note sit behind **Add details**, which opens by itself when a job already carries
any of them — nothing is hidden from you, it just isn't in the way. Costs behave the same
and assume supplies bought today. A job you've logged before comes back as a chip under
the hero buttons, so repeating it costs one tap.

Nothing is a lump sum. A job is logged with its amount, service, customer and how it
was paid; a cost with what it was and what kind. Both are editable and deletable, and
every figure re-runs the moment either changes.

**Costs are per day, never a standing amount.** Some days you buy wax, most days you
buy nothing — a day with nothing logged costs nothing, and no background figure is
quietly assumed. Anything bought before comes back as a one-tap chip carrying the price
last paid, so a repeat purchase is one tap rather than typing it out again. Tapping a
cost category on the Business tab opens that category on its own: what it has cost this
month and all time, what you buy ranked by spend with repeat counts, how many of your
working days actually involved buying any, and every purchase, editable.

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

Across the whole run the same thing holds: add up every daily figure the plan asks for
between today and the last funding date and you get exactly the sum of the bills — no
more, no less. Miss a day and nothing is lost; the money reappears spread across the
days that are left, and the app says so in as many words.

A bill that has fallen off its original pace reads **Catching up**, not a warning: the
daily figure has already absorbed it and the bill is still funded before it is due. Only
a bill past its funding date is flagged as urgent.

### What's in it

### Simple and Advanced

The app opens in **Simple**, where the first screen answers only today's questions —
what's yours, what to set aside, what you logged — and nothing else. **Advanced** puts
every figure back: the where-it-went chain, the week's running totals, and jobs and
costs as separate cards. The switch lives under **More → How much do you want to see**,
with a shortcut at the bottom of Today. Nothing is ever removed by Simple, only folded,
and the choice is remembered.

In Advanced, the full where-it-went chain folds away behind its own heading, which
carries the one-line version (`$200.00 in · $70.00 spoken for · $130.00 yours`).

### Every number explains itself

Figures carry a small **?**. Tapping it says what the number means in plain words and
shows the sum it came from, using the amounts actually in play — not an example. It
covers what you keep, today's suggested bill money, days to spare, what the day needs
to make, the partner's share, tax, the month's total, and the per-day rate.

There is no finance jargon in the interface. "Break-even" is *what today needs to make*,
the cushion is *how early to be ready*, and money set aside is money set aside.

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
  as bills finish. Past days are judged by the money that actually went across, not by
  whether a button was pressed: covered, part paid, or nothing set aside. Tap any day to
  put it right: add a job or a cost, switch the whole day's partner share, correct a
  set-aside amount rather than deleting it, add more, or reopen it.

The month summary is three lines that follow on from each other, so the month reads as one
sum rather than three competing ones:

```
Left to pay in September                                   $650.00
  $600.00 of that is already set aside, so $50.00 is still to find
In your bill money now                                     $720.00
```

**Left to pay in \<month\>** is every bill landing in the month you're looking at, whatever
rhythm it keeps, minus the ones already marked paid. A weekly bill counts each time it
lands, a monthly one follows its anchor day into months its current cycle hasn't reached
yet, and cycles already paid come from the record. Tap the **?** for the itemised list.
The line beneath splits that figure in two — what you are already holding for those bills,
and what is still to find — and the two always add back to it.

**In your bill money now** is the whole pot, this month's bills and later ones together. It
is deliberately the same number as the one at the top of the Bills tab: the same words have
to mean the same figure on every tab, or the app is lying somewhere.

Its sub-line carries one more figure — *the days left in \<month\> ask for $X more* — and that
is a third thing again: what the daily amounts on the calendar above add up to over the days
you have left. It is read straight off the same cells the calendar draws, so the row and the
calendar can't disagree, and its **?** spells out which figure is which.

### The plan doesn't stop at the round it's funding now

Each bill is saved for one round at a time, and the day after a bill is due it starts saving
for the next one. Without that, the plan went silent the moment the current round was
covered — so a month whose bills hadn't come round yet looked free. October could say it
cost $1,787 above a calendar asking for $25.

```
October 2026     calendar $1,727.97   month costs $1,822.18   ratio 0.95
November 2026    calendar $1,711.78   month costs $1,653.12   ratio 1.04
December 2026    calendar $1,721.25   month costs $1,653.12   ratio 1.04
```

A full month ahead now asks for what that month actually costs. They don't tie out to the
penny and shouldn't: a bill landing near the 1st was part-funded the month before, and one
landing near the 31st is still being funded into the next.

The current month is the exception — its calendar only counts days from today forward, while
its cost includes bills already past due. A one-off never re-arms; it's funded once and filed
away.

**Today is never projected forward.** Whether the bill sitting on today's due date has
actually been handed over is something only you know, so today's figure stays on the rounds
that exist in your data. Money can only be filed against a real round, which is also why
`allocate` refuses a projected one outright.

### "This bill has come due"

The projection assumes a bill gets paid on its due date. That assumption is only worth
anything if the app tells you when it's waiting on you, so Today carries a card listing every
bill whose date has passed without being marked paid — how late it is, what's being held for
it, and a **✓ Paid** button.

Tap it and the money leaves the pot, the next round starts saving, and the daily amount picks
it up. Leave it and the app keeps holding that money for the bill in front of it, which is
correct but means the daily figure sits lower than the plan expects. It's the one thing the
app needs from you that it can't work out on its own.

Earlier versions put *already set aside this month* here as a running total of everything
paid in during the month. That broke the moment you marked a bill paid: the money left the
pot but not the total, so the Bills tab said $220 and the Plan tab said $720, both calling
it "set aside". The chain above can't drift that way — every line is derived from the same
bills and the same pot, at the moment you look at it.

A bill whose due date has gone by without being marked paid still counts as this month's.
The window runs from the first of the month, not from today, because an overdue bill is
very much still something you have to pay.

The **Still to find** stat above the calendar is a different figure on purpose: it counts
every bill you track, in any month, which is why it's larger. Tap its **?** and it lists
each bill with what it still needs — and explains why paying a bill makes it go *up*.

### Backups

Everything lives in `localStorage` on one device, so losing it is a real failure mode rather
than a hypothetical. There are two layers, and they protect against different things.

**Dated copies, kept automatically.** Every save writes a snapshot under
`billcushion.snap.<date>` (throttled to one every two minutes), and the six most recent days
are kept. An empty state never writes one, so opening a blank app can't push a real copy out.
**More → On this device** lists them with their bill and job counts and restores any one.
`billcushion.lastgood` — the state as of the last clean open — sits alongside them.

These undo a bad edit, a bad day, or a bill deleted by mistake. They cannot survive the
browser discarding the origin, because they go with it.

**A copy off the phone, which is the one that matters.** iOS won't let a page write a file
unprompted, so this is one tap: **💾 Back up now** hands a real `File` to `navigator.share`,
and it lands in Files, iCloud or Notes. Where the share sheet isn't available it falls back to
a download, then to copying the JSON.

The app tracks when a copy last left the device and puts a banner on Today after seven days —
harder after twenty-one, and from the start if there has never been one. *Later* snoozes it
for the day only; there's no dismissing it for good. A cancelled share sheet is not recorded
as a backup.

**Erase everything** clears the snapshots and the fallback along with the live copy. Without
that, erasing was undone by the next open offering it all back.

### When the ledger and the bank disagree

Money gets spent, a day goes unlogged, a transfer lands late. **Set the real amount** on
the Bills tab takes the true figure and squares the app up to it rather than carrying on
with a number you know is wrong.

More than the app has goes onto the bills nearest due first, so the daily amount drops.
Less comes back off the bills with the *most* time left — the ones due soonest keep their
funding, and the daily figure climbs to make it back. The sheet says which way it will go
before you commit, and the change can be undone.

The pot itself is what you are holding right now: money spent on a bill you marked paid
stops counting, which is why it falls each time you pay one.

### Marking a bill paid

Every bill on the Bills tab carries **✓ Mark paid** and **＋ Add money** under it — the
thing you come here to do on the day a bill lands should not be three taps down inside a
sheet. The confirm spells out what moves before you commit:

```
$300.00 comes out of your bill money.
Bill money goes from $340.00 to $40.00.
The next Rent is due Oct 1, so it starts saving from today
 — expect "still to find" to go up by about $300.00.
```

Then it answers the question you were about to ask anyway — **what is left to pay this
month**. A bill you have marked paid drops out of that figure, which is the whole point
of marking it: the same number appears on the Plan tab under the calendar and on the
Bills tab under the totals, both headed **Left to pay in \<month\>**, and both fall by
exactly the bill you just settled. The confirm projects it for after the payment (worked out by applying the
payment to a copy of your data and reading the result, so "after this" is never a figure
measured before the change), and the message afterwards repeats the same number. The Bills
tab carries it permanently under its totals, with a tap-to-see list of the bills still to
land, what each still needs, and how much of the month is already covered.

That last line matters: a repeating bill re-arms the moment you pay it, so the balance
still to find goes *up*. It is next month's, not a mistake, and the app says so rather
than letting you discover it. Paying while short says where the rest comes from; saving
past the amount carries the extra into the next cycle; a one-off is filed away and stops
asking. Afterwards the card reads **✓ Paid today · next one Oct 1** instead of looking
untouched.

### Free and clear

The day ends with the figure that answers "how much of this is actually mine?" — money
**no bill has a claim on**:

```
everything the work has made you
− what has already gone to bills
+ any bill money no bill needs
− what the bills still want
= free and clear
```

Until the bills are covered it sits at zero and says how much further there is to go,
rather than showing a negative number. It is a forward-looking figure, not a bank
balance: it says what is left once every bill is paid for, whether or not you have
already spent it. Tap the **?** for the sum with your own numbers.

A day's bill money can come from that day's takings or from savings you already had.
Only the first kind reduces what the day kept, so the two are listed apart and the
second is named and explained rather than silently left out. Paging
  forward keeps projecting from today, so a later month accounts for everything banked
  between now and then instead of re-charging bills that will already be paid.
- **More** — automatic bill funding on or off, your workday pattern, cushion length,
  rounding, and backup/restore.

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
