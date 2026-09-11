# Putting this online

You need somewhere to run it, and that somewhere needs **HTTPS**. Not as good
practice — as a hard requirement. Browsers refuse to give a page your location
unless it arrived over a secure connection, so **"I'm on my way" cannot work
over plain HTTP.** Everything below gets you a certificate without thinking
about it.

The recommendation is **Fly.io**: a few dollars a month, a certificate and a
domain included, and a real disk that survives restarts. The whole thing is
three commands. If you would rather own the box, skip to
[On your own server](#on-your-own-server) — it is the same container either way.

---

## The quick version

```bash
cd graceful-auto-detailing

fly launch --no-deploy                       # pick a name; it reads fly.toml
fly volumes create graceful_data --size 1    # the disk your data lives on
fly secrets set APP_SECRET="$(openssl rand -base64 48)"
fly deploy
```

Then open `https://<your-app>.fly.dev/admin`, and read the setup code out of
`fly logs`.

That is it. The rest of this page explains each step and what to do next.

---

## Step by step

### 1. Install the Fly command line and sign in

```bash
curl -L https://fly.io/install.sh | sh
fly auth signup      # or: fly auth login
```

It asks for a card. A machine this size runs a few dollars a month.

### 2. Create the app

```bash
cd graceful-auto-detailing
fly launch --no-deploy
```

It will ask for a name — something like `graceful-auto-detailing`. Say **no**
to a database and **no** to Redis; this app needs neither. `--no-deploy` is
there because a couple of things have to exist before the first deploy.

### 3. Create the disk

```bash
fly volumes create graceful_data --region ord --size 1
```

This is where the database and every before-and-after photo live. One gigabyte
is a lot of photos; you can grow it later with `fly volumes extend`.

Use the same region you picked in step 2. `ord` is Chicago, the closest Fly
region to Michigan.

### 4. Set the secret

```bash
fly secrets set APP_SECRET="$(openssl rand -base64 48)"
```

This one value protects every sign-in session. You never need to see it or
remember it. Do not reuse it anywhere else.

### 5. Tell it its own address

Open `fly.toml` and set `PUBLIC_BASE_URL` to the address customers will
actually reach:

```toml
PUBLIC_BASE_URL = "https://graceful-auto-detailing.fly.dev"
```

**This matters more than it looks.** Every link you text a customer is built
from it. Point it at the wrong place and every link is dead. The app refuses to
start if you leave it pointing at localhost.

### 6. Deploy

```bash
fly deploy
```

A minute or two later it is live.

### 7. Sign in for the first time

```bash
fly logs
```

Look for the box that says **No owner account yet** and copy the setup code.
Open `https://<your-app>.fly.dev/admin`, enter the code, and pick your email
and password. That account is the only way into the dashboard, ever, and the
setup code stops working the moment you use it.

---

## Your own domain

A customer tapping a link from your website should not land on `fly.dev`.

```bash
fly certs add app.gracefulautodetail.com
fly certs show app.gracefulautodetail.com     # shows the DNS records to add
```

Add the records it prints wherever gracefulautodetail.com's DNS lives. Once the
certificate goes green, change `PUBLIC_BASE_URL` in `fly.toml` to
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
fly ssh console -C "npm run backup"                  # make one
fly ssh sftp get /data/backups/graceful-....tar.gz   # bring it home
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
