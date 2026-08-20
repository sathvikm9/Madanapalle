# Madanapalle Theatre Collection Tracker

A production-oriented tracker for **Sri Krishna (`SKMD`)**, **Sai Chitra (`SCM`)**, **Ravi (`RTDM`)**, and **ASR (`ASRM`)** in Madanapalle. It discovers BookMyShow and TicketNew sessions, notices movie replacements, saves an early backup and then a final capture, subtracts ₹5 MC from each category's ticket price, and stores an auditable final result.

## What it records

For every show:

- movie, event code, session ID, date and time
- the booking platform's live cutoff time
- exact capture timestamp in `Asia/Kolkata`
- sold/unavailable seats by ticket category
- listed price and counted price (`listed price - ₹5`)
- final ticket total, gross and occupancy
- schedule replacements, removals, failures and retry attempts

The label “sold” follows the availability state exposed by the booking platform. A held or operationally blocked seat can look unavailable; the raw counts and capture time are retained so this remains auditable.

## Reliable capture policy

If a show starts at 7:00 AM and BookMyShow gives a 7:15 AM cutoff:

1. the Chrome agent saves a backup shortly after 7:10 AM;
2. if that backup fails, it retries once per minute;
3. it makes a final attempt shortly after 7:14 AM;
4. at 7:15 AM, the newest successful capture is locked as final, including the backup when the final attempt fails;
5. discovery work pauses around the capture window so it cannot delay the seat count;
6. every attempt and failure is retained in the server audit log.

This requires an always-on collector. GitHub Actions schedules are not used for the final-minute job because their start times are not exact.

## Architecture

- `apps/web` — static React/Vite dashboard, suitable for GitHub Pages
- `apps/worker` — primary Cloudflare Worker API and D1 database writer
- `apps/api` — optional self-hosted Express/PostgreSQL/Playwright fallback
- `apps/chrome-agent` — primary collector running in a normal local Chrome session
- `packages/core` — booking parser, time, money and schedule-change rules
- Cloudflare D1 — shows, revisions, snapshots, category totals and collector audit log

The recommended production layout is GitHub Pages for the dashboard, Cloudflare Workers/D1 for the always-online API and storage, and the Chrome capture agent on an always-on local Mac/PC. It requires no paid VPS. See [Architecture](docs/ARCHITECTURE.md), [Cloudflare deployment](docs/CLOUDFLARE_DEPLOY.md), [Laptop setup](docs/LAPTOP_SETUP.md) and [Operations](docs/OPERATIONS.md).

The Cloudflare investigation and rejected bypass approaches are documented in [Cloudflare findings](docs/CLOUDFLARE_FINDINGS.md).

## Local setup

Requirements: Node.js 22+, npm and Chrome. Docker is needed only for the optional PostgreSQL fallback.

```bash
nvm use
npm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
npm run worker:migrate:local
npm run check
npm run dev
```

Open `http://localhost:5173`. For a UI-only preview without live data, open `http://localhost:5173/?demo=1`.

Useful commands:

```bash
npm run check
npm run worker:deploy
```

## Production configuration

Set at minimum:

- Worker secret `AGENT_TOKEN`, shared only with the local Chrome extension
- Worker variable `CORS_ORIGINS`, set to the exact GitHub Pages origin
- `VITE_API_BASE` in the GitHub repository Actions variables/secrets

The health endpoint is `GET /health`. The Worker cron finalizes received snapshots but never accesses a booking platform. See the Cloudflare deployment guide for database creation, migrations, secrets and backup commands.

## Install the local Chrome agent

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select `apps/chrome-agent` from this repository.
3. Enter the HTTPS API URL and the same `AGENT_TOKEN` stored as a Worker secret.
4. Enable automatic capture and click **Save and test now**.
5. Keep Chrome and all four pinned theatre tabs running.

If Cloudflare asks for verification, complete it manually in that pinned tab. The extension reuses the normal Chrome session and never attempts to bypass a challenge.

## GitHub Pages

The workflow in `.github/workflows/pages.yml` builds and deploys only the static frontend. Set the repository variable `VITE_API_BASE` to the public HTTPS API URL, then enable **Settings → Pages → GitHub Actions**.

## Verified theatre facts

Live BookMyShow inspection on 20 August 2026 confirmed:

- venue code: `SKMD`
- each show has its own `SessionId`
- `CutOffDateTime` is 15 minutes after `ShowDateTime`
- example current categories: ₹105 and ₹84, counted by this app as ₹100 and ₹79

Live Ravi inspection on the same date confirmed:

- venue code: `RTDM`
- all four observed shows had a 20-minute BookMyShow cutoff
- the collector reads each session's actual cutoff instead of hard-coding 20 minutes
- current categories included ₹105 and ₹84, counted as ₹100 and ₹79

Prices are never hard-coded; the ₹5 adjustment is applied to each live category price.
