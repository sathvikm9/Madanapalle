# Always-on laptop setup

The laptop is the BookMyShow collector. The Cloudflare Worker and dashboard remain online without it, but a final seat capture can only happen while this laptop, Chrome and the extension are running.

## One-time Chrome setup

1. Open `chrome://extensions`.
2. Enable **Developer mode**, choose **Load unpacked**, and select `apps/chrome-agent`.
3. Pin the extension and open its settings.
4. Enter the deployed Worker URL and the same agent token stored as the Worker's `AGENT_TOKEN` secret.
5. Enable automatic capture and choose **Save and test now**.
6. Add Google Chrome to **System Settings → General → Login Items**.

Use the same Chrome profile permanently. Do not clear its BookMyShow cookies, use a rotating VPN/proxy, or run the collector in Incognito mode.

## Prevent sleep on macOS

Keep the charger connected. In **System Settings → Battery → Options**, enable the setting that prevents automatic sleeping on the power adapter when the display is off. The display itself may turn off.

For an additional restart-safe guard, install the included LaunchAgent:

```bash
mkdir -p "$HOME/Library/LaunchAgents"
cp deploy/macos/com.skct.keep-awake.plist "$HOME/Library/LaunchAgents/"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.skct.keep-awake.plist"
```

The LaunchAgent runs macOS `caffeinate -s`, which prevents system sleep only while AC power is connected. It does not prevent the display from turning off.

To remove it:

```bash
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.skct.keep-awake.plist"
rm "$HOME/Library/LaunchAgents/com.skct.keep-awake.plist"
```

## Daily health check

- Chrome is open and the pinned Sri Krishna and Ravi tabs exist.
- The extension settings show a recent successful discovery.
- The laptop has internet and AC power.
- There is no Cloudflare verification page waiting in either pinned tab.
- The dashboard shows today's sessions and their capture times.

Chrome alarms are rebuilt at browser startup only for the current India date. Discovery refreshes that date every fifteen minutes, pauses per theatre after its final known show has been captured and passes cutoff, and switches to the new date just after 12:00 AM IST. It never opens tomorrow's schedule early.
