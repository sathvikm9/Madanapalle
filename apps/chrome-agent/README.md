# Local Chrome Capture Agent

This unpacked Chrome extension is the primary BookMyShow collector. It uses a normal visible Chrome tab and the computer's ordinary network connection instead of a cloud/datacenter browser.

## Install

1. In Chrome, open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this `apps/chrome-agent` directory.
4. In the settings page, enter the public API base URL and the Worker's `AGENT_TOKEN`.
5. Enable automatic capture and click **Save and test now**.

The extension creates one pinned BookMyShow tab. Keep Chrome and the computer awake during theatre hours.

## Behavior

- today's schedule refreshes every five minutes
- tomorrow's schedule refreshes hourly
- a fresh preflight occurs 90 seconds before the final minute
- seat capture starts roughly 15 seconds into that minute
- page failures retry while the cutoff remains open
- a Chrome notification requests attention when BookMyShow/Cloudflare requires human verification
- no seat is selected and no booking/payment action is performed

## Permissions

The extension needs:

- BookMyShow page access to read show and seat availability
- tab/alarms/storage access to maintain the pinned session and exact alarms
- notification access for capture success or human-attention alerts
- HTTPS access to upload normalized results to the configured API

The agent token is stored only in local extension storage and is not synced through the Chrome account. Use a dedicated random token and rotate it if the Chrome profile is shared or compromised.
