# Getting this online

You need somewhere to run it, and that somewhere needs **HTTPS**. Not as good
practice — as a hard requirement: browsers refuse to give a page your location
unless it arrived securely, so **"I'm on my way" cannot work over plain HTTP.**

The recommendation is **Fly.io**. A few dollars a month, a secure address
included, and a real disk that survives restarts. You do not need your own
domain — the address Fly gives you works fine for a link sent by text.

---

## The whole thing, in one command

```bash
cd graceful-auto-detailing
./scripts/deploy-fly.sh
```

It asks you to sign in, asks what to call the app, then creates everything,
deploys, and prints your setup code. Roughly five minutes, most of it waiting.

Safe to run again if anything goes wrong — it checks what already exists before
creating anything, so you never have to start over.

### What you need first

**The Fly command**, once:

```bash
# macOS or Linux
curl -L https://fly.io/install.sh | sh

# Windows (PowerShell)
powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

Close and reopen your terminal afterwards so it can find the command.

**A Fly account.** The script opens the sign-up page if you do not have one. It
asks for a card; a machine this size runs a few dollars a month.

### What it does

| | |
|---|---|
| 1 | Signs you in to Fly |
| 2 | Creates the app under the name you pick — that becomes `https://yourname.fly.dev` |
| 3 | Creates a 1 GB disk for your customers, jobs and photos |
| 4 | Generates the secret that protects your sign-in |
| 5 | Points the app at its own address, so texted links work |
| 6 | Deploys |
| 7 | Prints your setup code |

Step 5 is the one people get wrong by hand. Every link you text is built from
that address, so if it is wrong every link is dead. The script writes it from
the name you chose rather than leaving it for you to remember.

### Then

Open `https://yourname.fly.dev/admin`, enter the setup code, and pick your email
and password. That account is the only way into the dashboard, ever, and the
code stops working the moment you use it.

**Lost the code?** It is kept until you use it:

```bash
fly ssh console -a yourname -C "npm run setup-code"
```

### First things to do inside

1. **Setup → Business details** — your phone number, and check the timezone.
2. **Setup → Services and Add-ons** — your real prices. They ship with yours
   already in (trim $20, spray wax $10, clay bar $60, pet hair $40, headlights
   from $80), so mostly you are just confirming them.
3. **Customers → +** — add someone real and book them in.
4. On the job, press **Where to → Use where I am now** when you are standing at
   their address, and every future job there gets a real ETA.

---

## Your own domain — optional, later

You do not need this. A link sent by text works the same whether it says
`fly.dev` or your own name, and nobody types it in. Do it when you want the
link to look like you, not before.

Your website stays exactly where it is — this only adds a subdomain beside it.

```bash
fly certs add app.gracefulautodetail.com -a yourname
fly certs show app.gracefulautodetail.com -a yourname   # prints the DNS records to add
```

Add those records wherever gracefulautodetail.com's DNS lives — your site is on
Netlify, so that is Netlify's DNS panel unless you moved it. Nothing about the
website changes; you are adding one name beside it.

Once the certificate goes green, change `PUBLIC_BASE_URL` in `fly.toml` to
`https://app.gracefulautodetail.com` and run `fly deploy` again.

Old links issued under the `fly.dev` address stop working at that point, which
is fine — links are short-lived by design. Send anyone mid-appointment a fresh
one from their job screen.

---

## Turning on real texting

Out of the box nothing is sent automatically and **nothing pretends to be**.
Every message is written out ready in the dashboard, and one tap hands it to
your own Messages app. That costs nothing and needs no account, and for a
one-person business it is often enough.

When you want them to send themselves, get a number from Twilio and:

```bash
fly secrets set \
  TWILIO_ACCOUNT_SID=AC... \
  TWILIO_AUTH_TOKEN=... \
  TWILIO_FROM=+1810...
```

Setting secrets restarts the app on its own. Roughly a cent a text.

---

## Backups

Your customer list, every job, every invoice and every photo live on that one
disk. Fly keeps its own volume snapshots, but a backup you hold yourself is the
one that is definitely there.

```bash
fly ssh console -a yourname -C "npm run backup"       # make one
fly ssh sftp get /data/backups/graceful-....tar.gz    # bring it home
```

That file is a complete copy: the database plus every photo. Keep it somewhere
that is not Fly — a laptop, a cloud drive, anywhere else.

Putting one back:

```bash
fly ssh sftp shell
put graceful-2026-09-11T12-00-00.tar.gz /data/restore.tar.gz
exit
fly ssh console -C "npm run restore -- /data/restore.tar.gz"
fly apps restart
```

Restore refuses to run over a database that already has customers in it unless
you pass `--force`, because the usual way to lose data twice is to restore on
top of the wrong thing.

Worth doing once a month, and once before anything you are nervous about.

---

## On your own server

Any box with Docker will do — a $5 VPS is plenty. Caddy sits in front and gets
the certificate itself.

```bash
# 1. Point an A record at the box, e.g. app.gracefulautodetail.com
# 2. Then, on the box:
git clone <this repo> && cd graceful-auto-detailing
cp .env.example .env
```

Fill in `.env`:

```
APP_DOMAIN=app.gracefulautodetail.com
APP_SECRET=<paste the output of: openssl rand -base64 48>
```

Then:

```bash
docker compose up -d
docker compose logs app        # the setup code is in here
```

Backups are the same idea:

```bash
docker compose exec app npm run backup
docker compose cp app:/data/backups ./backups
```

---

## What it costs

| | |
|---|---|
| Fly machine (always on, 512 MB) | around $3–5 a month |
| 1 GB volume | about 15¢ a month |
| Certificate and `fly.dev` address | free |
| Your own domain on it | free (you already own the domain) |
| Texts, if you connect Twilio | about 1¢ each, plus ~$1.15/month for the number |

No per-customer cost, and nothing your customers pay.

---

## A few things worth knowing

**Run exactly one machine.** The database is a file on the disk and the photos
sit beside it, so a second machine would be a second, diverging copy of your
business. `fly.toml` is already set up this way — leave `auto_stop_machines` off
and `min_machines_running` at 1. A sleeping app is worse than slow: the timer
that erases expired location data would stop running.

**Scaling up, not out.** If it ever feels slow, give the one machine more
memory (`fly scale memory 1024`) rather than adding machines.

**Updating.** `git pull` then `fly deploy`, or `docker compose up -d --build`
on your own box. Take a backup first.

**If you forget your password**, there is no email reset — deliberately. For a
one-person business, needing access to the server is a stronger gate than an
inbox:

```bash
fly ssh console -C "npm run reset-password -- 'a new long passphrase'"
```

That also signs out every device.

**Checking it is healthy.** `https://your-address/healthz` answers
`{"ok":true,"owner":true}` when everything is up.
