#!/usr/bin/env bash
#
# Sets the app up on Fly.io and deploys it, in one go.
#
# Safe to run again: it checks what already exists before creating anything,
# so if a step fails you can fix it and re-run without starting over.
#
#   ./scripts/deploy-fly.sh

set -euo pipefail

cd "$(dirname "$0")/.."

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }

# Fly ships the command as `fly`, but older installs still answer to `flyctl`.
FLY=""
for candidate in fly flyctl; do
  if command -v "$candidate" >/dev/null 2>&1; then FLY="$candidate"; break; fi
done
[ -n "$FLY" ] || die "The Fly command is not installed.

  macOS or Linux:  curl -L https://fly.io/install.sh | sh
  Windows:         powershell -Command \"iwr https://fly.io/install.ps1 -useb | iex\"

Then close and reopen your terminal and run this again."

bold ""
bold "Graceful Auto Detailing — setting up on Fly.io"
bold ""

# ---------------------------------------------------------------- account ---

if ! "$FLY" auth whoami >/dev/null 2>&1; then
  info "You are not signed in to Fly yet. Opening the sign-in page…"
  "$FLY" auth login || die "Sign-in did not complete. Run '$FLY auth login' and try again."
fi
ok "Signed in as $("$FLY" auth whoami 2>/dev/null)"

# ------------------------------------------------------------------- name ---

APP_NAME="${APP_NAME:-}"
if [ -z "$APP_NAME" ]; then
  DEFAULT_NAME="graceful-auto-detailing"
  printf '\n  Pick a name for the app. It becomes your address:\n'
  printf '    https://NAME.fly.dev\n\n'
  printf '  Name [%s]: ' "$DEFAULT_NAME"
  read -r APP_NAME || true
  APP_NAME="${APP_NAME:-$DEFAULT_NAME}"
fi

# Fly names may hold lowercase letters, digits and hyphens. Spaces and
# underscores become hyphens so "Graceful Auto Detailing" reads as you would
# expect rather than running together.
APP_NAME="$(printf '%s' "$APP_NAME" \
  | tr '[:upper:]' '[:lower:]' \
  | tr ' _' '--' \
  | tr -cd 'a-z0-9-' \
  | sed -e 's/--*/-/g' -e 's/^-//' -e 's/-$//')"
[ -n "$APP_NAME" ] || die "That name has no usable characters in it."

BASE_URL="https://${APP_NAME}.fly.dev"

if "$FLY" apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP_NAME"; then
  ok "App '$APP_NAME' already exists — using it"
else
  info "Creating the app…"
  "$FLY" apps create "$APP_NAME" \
    || die "Could not create '$APP_NAME'. The name is probably taken — run this again and pick another."
  ok "App '$APP_NAME' created"
fi

# ------------------------------------------------------------ config file ---

REGION="$(awk -F'"' '/^primary_region/ {print $2}' fly.toml)"
REGION="${REGION:-ord}"

# Point fly.toml at this app, and at the address customers will actually open.
# Getting that second one wrong is the single easiest way to text people dead
# links, so it is written from the app name rather than left to be edited.
tmp="$(mktemp)"
sed -e "s|^app = .*|app = \"${APP_NAME}\"|" \
    -e "s|^  PUBLIC_BASE_URL = .*|  PUBLIC_BASE_URL = \"${BASE_URL}\"|" \
    fly.toml > "$tmp" && mv "$tmp" fly.toml
ok "Links will be built on ${BASE_URL}"

# ----------------------------------------------------------------- volume ---

if "$FLY" volumes list -a "$APP_NAME" 2>/dev/null | grep -q graceful_data; then
  ok "Disk already exists"
else
  info "Creating the disk your customers, jobs and photos live on…"
  "$FLY" volumes create graceful_data --app "$APP_NAME" --region "$REGION" --size 1 --yes \
    || die "Could not create the disk. Run '$FLY volumes create graceful_data --app $APP_NAME --region $REGION --size 1'."
  ok "1 GB disk created in $REGION"
fi

# ----------------------------------------------------------------- secret ---

if "$FLY" secrets list -a "$APP_NAME" 2>/dev/null | grep -q APP_SECRET; then
  ok "Sign-in secret already set"
else
  if command -v openssl >/dev/null 2>&1; then
    SECRET="$(openssl rand -base64 48)"
  else
    SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
  fi
  "$FLY" secrets set APP_SECRET="$SECRET" -a "$APP_NAME" >/dev/null \
    || die "Could not set the sign-in secret."
  ok "Sign-in secret generated and stored"
  unset SECRET
fi

# ----------------------------------------------------------------- deploy ---

printf '\n'
info "Deploying. The first one takes a couple of minutes…"
printf '\n'
"$FLY" deploy -a "$APP_NAME" || die "The deploy failed. The output above says why; fix it and run this again."

# ------------------------------------------------------------- setup code ---

printf '\n'
bold "Deployed."
printf '\n'

CODE="$("$FLY" ssh console -a "$APP_NAME" -C "npm run --silent setup-code" 2>/dev/null | grep -oE '[A-Z0-9_-]{12}' | head -1 || true)"

if [ -n "$CODE" ]; then
  printf '  Open   \033[1m%s/admin\033[0m\n' "$BASE_URL"
  printf '  Code   \033[1;36m%s\033[0m\n\n' "$CODE"
  info "Enter that code to create your account. It only works once."
else
  printf '  Open   \033[1m%s/admin\033[0m\n\n' "$BASE_URL"
  info "To get your setup code, run:"
  info "  $FLY ssh console -a $APP_NAME -C \"npm run setup-code\""
fi

printf '\n'
info "Afterwards:"
info "  Back up      $FLY ssh console -a $APP_NAME -C \"npm run backup\""
info "  Watch logs   $FLY logs -a $APP_NAME"
info "  Send texts   see DEPLOY.md for connecting Twilio"
printf '\n'
