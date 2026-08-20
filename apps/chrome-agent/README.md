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

- today's schedule refreshes every five minutes
- tomorrow is never opened early; discovery rolls to the new India date just after 12:00 AM IST
- Sri Krishna backup capture starts shortly after showtime +10 minutes
- Sai Chitra backup capture starts shortly after showtime +10 minutes
- Ravi backup capture starts shortly after showtime +15 minutes
- ASR backup capture starts shortly after showtime +10 minutes
- a second preflight refreshes the schedule before the final attempt
- a successful backup waits until the final minute; a failed backup retries once per minute
- the newest successful snapshot is finalized after cutoff, so a failed final attempt keeps the backup
- simultaneous theatre captures use independent tabs and pending jobs
- capture starts/failures/successes are stored in the server audit log
- a Chrome notification requests attention when a booking platform requires human verification
- no seat is selected and no booking/payment action is performed

## Permissions

The extension needs:

- BookMyShow and TicketNew page access to read show and seat availability
- tab/alarms/storage access to maintain the pinned session and exact alarms
- notification access for capture success or human-attention alerts
- HTTPS access to upload normalized results to the configured API

The agent token is stored only in local extension storage and is not synced through the Chrome account. Use a dedicated random token and rotate it if the Chrome profile is shared or compromised.
