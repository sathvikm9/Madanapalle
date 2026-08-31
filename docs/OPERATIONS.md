# Operations runbook

## First deployment

1. Create a free Cloudflare D1 database and apply `apps/worker/migrations`.
2. Deploy `apps/worker` with a secret `AGENT_TOKEN` and the exact Pages `CORS_ORIGINS` value.
3. Verify `https://your-worker.workers.dev/health` returns `ok: true`.
4. Load `apps/chrome-agent` as an unpacked extension in the always-on local Chrome browser.
5. Configure the Worker URL/token, enable it, and run **Save and test now**.
6. Set the GitHub Actions variable `VITE_API_BASE=https://your-worker.workers.dev` and deploy Pages.
7. Follow `docs/LAPTOP_SETUP.md` so macOS does not sleep and Chrome starts after login.

Configure the local computer not to sleep during theatre hours. Chrome must remain running; closing the browser also closes the capture agent.

The `workers.dev` API is HTTPS by default.

## Daily checks

- `/health` is reachable.
- the Chrome extension status shows a recent successful discovery.
- the dashboard lists today's shows.
- finalized shows have a successful backup or final-attempt capture timestamp.
- `missedShows` remains zero.

## Before the first real capture

Use a future show to verify discovery, keep both pinned BookMyShow tabs available, then watch Worker logs from the backup window through cutoff:

```bash
npx wrangler tail
```

Do not choose seats or proceed to payment. The extension only reads the accessible seat grid.

## Recovery

### BookMyShow layout changed

Symptoms: `No seat categories`, `zero-seat layout`, or unknown seat-state errors.

1. Keep the failed records; do not edit them to zero.
2. Open the target seat page manually and inspect its accessibility modal.
3. Update `apps/chrome-agent/content.js` selectors.
4. run tests and a future-show read before redeploying.

### Chrome or the local computer restarted

Restart Chrome and confirm the extension is enabled. It reconstructs alarms immediately from its last known schedule and then performs a fresh discovery. If it returns after cutoff with no snapshot, the show is correctly marked `missed`.

### A theatre tab remains loading

The agent waits up to 30 seconds, replaces the stuck extension-owned tab once, and retries discovery immediately. If the replacement also fails, that theatre retries after 2, 5, then 15 minutes while the other theatres continue normally. The India-date rollover also starts with fresh collector tabs. Unrelated tabs are never closed. Repeated Cloudflare verification still requires manual completion.

### Cloudflare verification appeared

The extension raises a notification and leaves the pinned BookMyShow tab visible. Complete the verification manually. Do not add CAPTCHA solvers or rotating proxy bypasses; they are unreliable and can violate site controls. If challenges become frequent, reduce discovery frequency or pursue an authorized partner data feed.

### Movie changed suddenly

The next fifteen-minute discovery pass creates a replacement revision. A preflight before the backup and final windows performs additional refreshes close to capture time.

### Database backup

Export D1 periodically with `npx wrangler d1 export sri-krishna-tracker --remote --output=backup.sql` and retain multiple dated copies. Browser profile data is helpful but replaceable; captured audit data is not.

## Security

- keep `AGENT_TOKEN` only in the Worker secret store and Chrome extension
- restrict `CORS_ORIGINS`
- rotate the agent token after accidental exposure
- apply Worker dependency and security updates regularly

## Accuracy note

BookMyShow's unavailable state can include short-lived holds or operational blocks. The application reports what the public booking map exposes at the final capture time. Treat it as the best externally observable ticket count, not theatre accounting-system settlement data.
