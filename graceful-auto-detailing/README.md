# Graceful Auto Detailing

Two experiences on one small server: a **private dashboard** only the owner can
reach, and a **customer page** reached by a link sent in a text — no account, no
app, no subscription.

Runs on Node 22.5 or newer with **no dependencies at all** — `node:sqlite`,
`node:crypto` and `node:http` are enough. There is no build step; the browser
runs the files as written.

```bash
npm start              # http://localhost:8080
```

On the first run with no owner account, a one-time setup code is printed to the
console. Open `/admin`, enter it, and pick your email and password. That account
is the only way into the dashboard, ever.

```bash
npm run seed           # optional: a believable day's work to look at
npm test               # 123 tests, including the security properties below
```

---

## The two sides

### The owner's dashboard — `/admin`

* **Today** — what is on, what came in this week, what is still owed.
* **Schedule** — book a job against a customer, a vehicle and a service.
* **Customers** — profiles with vehicles, notes and their whole history.
* **Money** — invoices built from what was actually done, and payments.
* **Setup** — services, add-ons, text templates, tax, timezone, tracking window.

Statuses move in ways that make sense: *scheduled → confirmed → on my way →
arrived → in progress → completed*, with *cancelled* and *no show* where they
belong. The app refuses a jump that would not happen in real life.

### The customer's page — `/p/<link>`

Their appointment, the extras worth considering written in plain words, a total
that moves the instant they tap one, before-and-after photos, the invoice, and a
review afterwards if they want to leave one. The extras sit high enough to see
without scrolling and low enough that the page says hello first.

**Nobody is ever asked for a tip.** There is no tip prompt anywhere a customer
can see. If one is handed over on the day it is recorded against the payment
that brought it, for the owner's own books — never as something the invoice
asked for.

---

## "I'm on my way"

This is the feature the rest of the app is arranged around, so it is worth being
precise about what it does.

**Location exists only between pressing the button and arriving.** There is no
background mode, no start-on-launch, and no way for a customer — or anyone else
— to switch it on. Specifically:

* Pressing the button creates a *trip*, takes one position fix, sends the text
  and starts watching. A tracking link goes out in that text.
* The link lasts **one hour by default** (adjustable, capped). A timer on the
  server ends and purges expired trips whether or not anyone presses stop, so
  the limit does not depend on the owner remembering.
* Ending a trip — arriving, stopping, cancelling the job, or the hour running
  out — **deletes the breadcrumb trail and blanks the last known position**.
  Nothing about the journey is kept.
* Expired, ended and never-existed links all answer identically, so a dead link
  cannot be used to work out whether a job is running.
* The customer sees a map, a distance, an ETA and a countdown to the link
  expiring. They can also open it from their own appointment page, so there is
  no second link to pass around.

The map is **drawn by the app**, not fetched from a tile service, so no third
party learns who is watching or where either person is.

### Destination pins

An address alone cannot produce an ETA — the app needs a point on the map. Each
appointment can carry a pin, set three ways: from where you are standing, by
pasting a link copied out of Google or Apple Maps, or offered once when you
arrive somewhere that has none. Without a pin, tracking still works; the
customer sees you moving, just without a countdown.

---

## Text messages

Every message is a template you can reword, with `{{placeholders}}` filled in
when it is sent. Built-in ones cover booking, a reminder, *I'm on my way*,
arrival, job complete, the invoice and a low-key review request. You can add
your own.

**Out of the box nothing is sent automatically and nothing pretends to be.**
With no provider configured, each message is written out ready in the dashboard
with a one-tap handoff to your own Messages app — which costs nothing and needs
no account. To send automatically, set the Twilio variables below.

A customer marked as not wanting texts is never texted; the app refuses.

---

## Look and feel

The app wears the same clothes as **gracefulautodetail.com**, so a customer
tapping through from a text finds the business they recognise rather than a
generic booking tool. Nothing here is a guess — the palette and the faces were
read off the site itself.

| | |
|---|---|
| Ground | `#000000`, panels `#080808` / `#0d0d0f` |
| Accent | `#2b8af5`, with `#1565c8` and `#5aaeff` either side of it |
| Text | chrome `#e2e5ea` for headings, silver `#b8bdc8` for copy |
| Highlight | gold `#d4a017` for reviews and anything owed |
| Headings | Barlow Condensed 900, italic, uppercase |
| Body | Rajdhani |
| Corners | 2–6px, as the site keeps them — never pill-shaped |

Both typefaces are **served from this app**, not from Google. That keeps the
content policy strict with no exception for a third-party origin, and means a
customer opening their appointment does not quietly announce the visit to
anyone else. They are SIL Open Font License 1.1; see
`public/shared/fonts/OFL.txt`.

The badge is the real logo, and the small mark is its GA monogram redrawn as an
SVG so it stays legible down to 38px. Icons throughout are inline SVG rather
than emoji — colour emoji sit badly against a black-and-chrome brand.

The theme is **dark everywhere, deliberately**, because the brand is. There is
no light variant to drift out of step with it. Tests hold the palette, the
self-hosted faces and the no-emoji rule in place so a later change cannot
quietly undo any of it.

The tagline under the logo on a customer's page is a setting, so it can be
reworded without touching code.

---

## Configuration

All optional except `APP_SECRET` in production.

| Variable | What it does | Default |
|---|---|---|
| `PORT` / `HOST` | Where to listen | `8080` / `0.0.0.0` |
| `APP_SECRET` | Signing secret, 32+ characters. **Required in production** | random per run in dev |
| `PUBLIC_BASE_URL` | The address links are built on | `http://localhost:<port>` |
| `DATA_DIR` | Where the database and photos live | `./data` |
| `TRUST_PROXY` | `1` when behind a reverse proxy, so `X-Forwarded-*` is believed | off |
| `TRACKING_MINUTES` | Default life of a tracking link | `60` |
| `TRACKING_MAX_MINUTES` | Hard ceiling the settings screen cannot exceed | `180` |
| `SESSION_IDLE_MINUTES` | Idle timeout | `720` |
| `SESSION_ABSOLUTE_DAYS` | Longest a session can live | `7` |
| `UPLOAD_MAX_BYTES` | Photo size cap | `8 MB` |
| `OWNER_EMAIL` / `OWNER_PASSWORD` | Create the owner at boot instead of using a setup code | — |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | Send texts for real | — |

A `.env` file in this folder is read for convenience in local runs.

```bash
npm run setup-code                                   # the one-time code, any time
npm run owner -- you@example.com 'a long passphrase' 'Your Name'
npm run reset-password -- 'a new long passphrase'    # ends every session
```

The setup code is kept in the database until it is used, so a missed line in a
log is not a dead end, and it is deleted the moment an owner exists.

Password recovery is deliberately a command on the server rather than an email
loop: for a one-person business, needing access to the machine is a stronger
gate than an inbox.

---

## Deploying

**Without a terminal:** **[SETUP-FROM-YOUR-PHONE.md](SETUP-FROM-YOUR-PHONE.md)**
— add a Fly token to GitHub and press a button. Works on a phone.

**With one:** `./scripts/deploy-fly.sh` creates the app on Fly, its disk and its
secret, points it at its own address, deploys, and prints your setup code. Safe
to re-run. **[DEPLOY.md](DEPLOY.md)** covers the rest, plus `docker compose up -d`
if you would rather own the box.

Put it behind HTTPS. Two reasons, both hard requirements rather than advice:

1. Browsers refuse `navigator.geolocation` outside a secure context, so
   **"I'm on my way" cannot work over plain HTTP**.
2. Session cookies are only marked `Secure` when the app knows it is on HTTPS.

Behind nginx, Caddy or a platform proxy, set `TRUST_PROXY=1` and
`PUBLIC_BASE_URL=https://your-domain`. Everything lives in `DATA_DIR` — the
SQLite database and the photo files — so backing up is copying that folder.

---

## How it is kept secure

Worth stating plainly, because the app handles someone's home address, their
phone number and the owner's real-time location.

**Getting in**

* One owner account. Password hashed with scrypt (N=2¹⁵), never stored or
  logged in any recoverable form.
* Sessions are 256-bit random tokens; only their SHA-256 is stored, so a copy of
  the database does not hand anyone a session. Idle and absolute expiry both
  apply, and changing the password ends every session everywhere.
* Sign-in is rate limited per address *and* per account, then the account locks
  for fifteen minutes. A wrong password takes the same time whether or not the
  account exists, so the response cannot be used to enumerate accounts.
* Every write needs a CSRF token matching the session, and must come from this
  origin. No CORS is offered to anyone.

**Customer links**

* 256 bits of randomness, stored only as a SHA-256 hash, time limited, and
  revocable in one tap.
* A link reaches exactly one appointment. It cannot see another customer,
  another job, or the owner's private notes — the customer view is built field
  by field rather than by removing fields from the admin view, so a column added
  later stays private until someone shares it on purpose.
* A customer can add extras the owner has marked as theirs to pick, and take
  back only what they added themselves. **Prices come from the price list, never
  from the request.**
* Saying how they intend to pay is a heads-up, not a payment. Nothing is marked
  as received until the owner records it.

**Everything else**

* Content-Security-Policy of `default-src 'none'` with no `unsafe-inline`: no
  inline script or style exists anywhere, and nothing loads from another origin.
  Plus `nosniff`, `DENY` framing, `no-referrer`, and HSTS on HTTPS.
* No `innerHTML` in any browser file — every element is built and every string
  goes in as text. A test enforces this, so it cannot quietly come back.
* All SQL goes through prepared statements. Every field is validated by type,
  range and length before it reaches the database. JSON bodies carrying
  `__proto__` are refused outright and oversized ones are cut off rather than
  buffered.
* Photos are identified by their actual bytes, not the header the uploader sent;
  anything that is not a JPEG, PNG or WebP is refused. Files get random names and
  are served with a fixed content type.
* Static files are served from one folder, with the resolved path proved to be
  inside it and only known extensions served at all.
* Money is integer cents end to end, and every total is worked out on the server.
  A client only ever says *which* add-on it wants.
* Editing the price list never re-prices a job already booked — name, wording and
  price are copied onto the appointment when it is added.

**Tests.** `npm test` runs 123 of them. Roughly half are the security properties
above, checked one at a time: that no route hands out a position unless a trip is
running, that a customer link cannot reach another appointment, that a path
cannot climb out of the public folder, that a search term is data rather than
SQL, that rate limits answer 429 rather than 500, and that ending a trip really
does erase the trail.

---

## What this deliberately does not do

* **It does not take card payments.** It produces a proper invoice and records
  what arrived and how — but it will not ask a customer for card details,
  because doing that safely means PCI scope this does not have. Cash, card in
  person, Zelle, Venmo and the rest are recorded as they happen.
* **It does not geocode addresses**, which would mean sending every customer's
  home address to a third party. Pins are set by hand, once, and remembered.
* **It does not charge a subscription and has no customer accounts.** A customer
  opens a link and that is the whole of it.

---

## Layout

```
server.js            wiring, page routes, housekeeping timer
src/
  config.js          environment and defaults
  db.js              schema, settings, first-run content
  security.js        passwords, tokens, cookies, headers, rate limits
  auth.js            owner account, sessions, CSRF
  http.js            router, bodies, responses, static files
  validate.js        every field that reaches the database
  links.js           customer links and trips — the only place location lives
  appointments.js    statuses and the two serialisers
  billing.js         totals, invoices and payments
  sms.js             templates and sending
  photos.js          uploads, sniffed by magic bytes
  geo.js             distance and ETA
  routes/            admin, portal, track
public/
  admin/             the owner's dashboard
  portal/            the customer's appointment page
  track/             the arrival map
  shared/            design system and DOM helpers
scripts/             owner, password reset, seed
test/                flow, security and client suites
```
