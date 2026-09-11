# Local Chrome Capture Agent

This unpacked Chrome extension is the primary local collector. It uses separate normal Chrome tabs for Sri Krishna, Sai Chitra, Ravi, and ASR and the computer's ordinary network connection instead of a cloud/datacenter browser.

## Install

1. In Chrome, open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this `apps/chrome-agent` directory.
4. In the settings page, enter the public API base URL and the Worker's `AGENT_TOKEN`.
5. Enable automatic capture and click **Save and test now**.

The extension creates one pinned BookMyShow or TicketNew tab per theatre. Keep Chrome and the computer awake during theatre hours.

## Behavior

- today's schedule refreshes every fifteen minutes
- each theatre's routine discovery pauses after its final known show has a successful capture and passes cutoff
- **Save and test now** forces a fresh discovery and verifies an exact District live route for every discovered Sai Chitra show
- tomorrow is never opened early; discovery rolls to the new India date just after 12:00 AM IST
- the India-date rollover discards the extension-owned collector tabs and opens fresh current-date tabs
- a tab that remains loading or cannot run discovery is replaced once immediately; continued failures retry only that theatre after 2, 5, then 15 minutes
- Sri Krishna backup capture starts shortly after showtime +10 minutes
- Sai Chitra opens the exact District seat layout at showtime +10:05 and retries it every minute through cutoff −0:55, counting every live seat in both classes
- if the +10:05 live map fails, a separate fresh TicketNew cinema page saves its exact-session availability summary as an **estimated backup** without interrupting live retries
- at cutoff −0:50, a fresh final TicketNew summary tab is cache-bypass refreshed immediately before reading; it is saved only when no District live result has been protected, and any successful District live result remains authoritative
- Ravi backup capture starts shortly after showtime +15 minutes
- ASR backup capture starts shortly after showtime +15 minutes
- a second preflight refreshes the schedule before the final attempt
- a successful backup waits until the final minute; a failed backup retries once per minute
- a failed Sri Krishna, Ravi, or ASR page read refreshes that exact session, then switches the show to a separate active recovery tab and a state-aware BookMyShow reader for every remaining attempt
- Sai Chitra reads the exact movie, showtime and session route from District during both capture preflights, then verifies the District session token before counting seats
- District session URLs remain valid when movie and screen identifiers follow the exact session token; partial or different session IDs are rejected
- after a Sai Chitra live failure, every remaining attempt rebuilds or reuses only the exact District session route; a movie replacement in the same theatre slot is adopted during recovery discovery
- a successfully counted District seat-layout URL is cached only for that exact natural key, date, and session; it is never reused for another movie or day
- TicketNew remains the isolated ESTIMATED summary fallback when District never yields a live seat map; even an earlier verified District live capture outranks a later TicketNew estimate
- the newest successful snapshot is finalized after cutoff, so a failed final attempt keeps the backup
- simultaneous theatre captures use independent tabs and pending jobs
- every successful seat count is written to a durable Chrome-storage outbox before its browser attempt is closed
- uploads are retried every minute, including after cutoff, after Chrome restarts, and while automatic booking capture is disabled
- the server accepts queued captures for up to seven days and uses the stable client capture ID to make every retry idempotent
- a locally protected backup still waits for the final attempt; a locally protected final capture stops further booking-site reloads
- the extension removes an outbox item only after D1 confirms it, and the settings status shows any safely stored pending upload
- a late Chrome page-loading error is ignored when that exact capture attempt was already protected in the local outbox
- the last 60 tab-repair and discovery-retry diagnostics stay in local extension storage for troubleshooting
- a Chrome notification requests attention when a booking platform requires human verification
- no seat is selected and no booking/payment action is performed

## Permissions

The extension needs:

- BookMyShow and TicketNew page access to read show and seat availability
- tab/alarms/storage access to maintain the pinned session and exact alarms
- notification access for capture success or human-attention alerts
- HTTPS access to upload normalized results to the configured API

The agent token is stored only in local extension storage and is not synced through the Chrome account. Use a dedicated random token and rotate it if the Chrome profile is shared or compromised.
