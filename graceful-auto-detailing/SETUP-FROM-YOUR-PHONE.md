# Setting it up without a terminal

Everything here happens on web pages. It works on a phone, and it works better
on a computer because there is a lot of tapping between tabs. Budget about
twenty minutes.

You will end up with a live address like `https://graceful-auto-detailing.fly.dev`
that you text to customers.

---

## Step 1 — Make a Fly account

Go to **[fly.io](https://fly.io)** and sign up. It asks for a card. A machine
this size costs roughly **$4 a month**, and the disk about 15¢.

## Step 2 — Make a token

A token is a long password that lets GitHub deploy on your behalf.

1. Go to **[fly.io/user/personal_access_tokens](https://fly.io/user/personal_access_tokens)**
2. **Create token** — call it `github`, leave the expiry alone
3. **Copy it.** It is shown once and never again.

## Step 3 — Give the token to GitHub

1. Open your repository on **github.com**
2. **Settings** → left side, **Secrets and variables** → **Actions**
3. **New repository secret**
   - Name: `FLY_API_TOKEN`
   - Secret: paste the token
4. **Add secret**

> On a phone, GitHub's Settings tab can be hard to reach. If you cannot find
> it, switch your browser to "Desktop site" and it appears.

## Step 4 — Press the button

1. Still on github.com, go to the **Actions** tab
2. Pick **Deploy** on the left
3. **Run workflow** (right-hand side)
   - **Name:** `graceful-auto-detailing`, or anything not already taken — it
     becomes your web address
   - **Region:** leave it as `ord` (Chicago, the closest to Michigan)
4. **Run workflow**

It takes three or four minutes. When the green tick appears, tap into the run
and the summary at the top shows **your address and your setup code**.

## Step 5 — Make your account

Open the address it gave you, with `/admin` on the end:

```
https://your-name.fly.dev/admin
```

Enter the setup code, pick your email and a password of at least 12 characters.
That is the only account, and the setup code stops working the moment you use it.

**If you lose the code before using it,** run the Deploy workflow again — it
prints it every time, and it does not change.

## Step 6 — Make it yours

Inside the dashboard:

1. **Setup → Business details** — your phone number, and check the timezone
2. **Setup → Services** and **Add-ons** — your real prices. Yours are already
   in (trim $20, spray wax $10, clay bar $60, pet hair $40, headlights from
   $80), so mostly you are confirming them
3. **Customers → +** — add a real customer
4. **Schedule → +** — book them in

Then open the job and press **Copy their link** to see exactly what they will get.

---

## Texting: what to expect

**You can start today, but not with automatic texting.** That part is not up to
me or to Fly — US carriers require every business sending automated texts to
register first, and Twilio cannot skip it.

**Today, with no account and no cost:** every message is written out ready in
your dashboard. Press the button, tap **Open Messages**, and it hands the whole
thing to your own phone with the customer and the words already filled in. It
sends from your own number, which customers recognise. Nothing pretends to have
been sent that was not.

**In parallel, start the Twilio registration**, because it takes days, not
minutes:

1. Sign up at **[twilio.com](https://www.twilio.com)**
2. Buy a phone number with SMS (about **$1.15/month**)
3. Register for **A2P 10DLC**. If it is just you, choose the **Sole Proprietor**
   brand — it is the quickest route and allows about 3,000 message parts a day,
   far more than you will use. There are small one-off and monthly fees
4. Wait for approval

**When it is approved,** three more secrets and one button:

1. GitHub → **Settings → Secrets and variables → Actions**, add:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_FROM` (your Twilio number, like `+18105550134`)
2. **Actions → Deploy → Run workflow**

That is the whole switch. Texts start sending themselves, at about a cent each.
Nothing else in the app changes.

---

## Afterwards

**Updating.** Actions → Deploy → Run workflow. Same button, any time.

**Backing up.** Worth doing monthly. This one does need a terminal, or ask me
and I will add a button for it too:

```
flyctl ssh console -a your-name -C "npm run backup"
```

**If you forget your password.** There is no email reset, on purpose — for a
one-person business, needing access to the server is a stronger lock than an
inbox. Ask me and I will walk you through it.

**Checking it is alive.** Open `https://your-name.fly.dev/healthz`. It should
say `{"ok":true,"owner":true}`.

---

## When something goes wrong

**The workflow fails on the very first step.** The token is missing or was
pasted with a space. Make a new one and replace the secret.

**"Could not create — the name is probably taken."** Fly names are global. Run
it again with something less obvious: `graceful-detail-mi`, `gad-fenton`.

**The app loads but a customer says the link does not work.** Check the address
in the workflow summary matches the one in the link. The workflow sets this for
you, so this should not happen — but that is the thing to check.

**Anything else:** copy the red text from the failed step and send it to me.
