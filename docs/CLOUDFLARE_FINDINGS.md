# Cloudflare research findings

The linked community discussions were reviewed on 20 August 2026. They are anecdotal rather than authoritative documentation, but their consistent observations match our direct test.

## What is useful

- Cloud/datacenter IP ranges and ASNs are commonly treated as higher-risk than ordinary end-user connections. One scraper author reported the same Puppeteer code working locally and failing on both DigitalOcean and Google Cloud.
- Visible/headed mode, fake user agents, random delays and persistent sessions did not overcome an IP-reputation block in that report.
- Defenders combine IP/ASN signals with session request patterns and browser/OS/fingerprint consistency.
- Low request frequency and one stable, real browser session reduce false bot signals and site load.
- An authenticated, authorized API is the structurally reliable alternative when the site provides one.

## What is not a production answer

- TLS/browser impersonation libraries
- harvested `cf_clearance` cookies
- “undetected” browser modes and fingerprint spoofing
- CAPTCHA-solving services
- proxy or residential-IP rotation
- origin-server or queue bypasses

These try to defeat access controls, can violate site terms, and remain brittle because Cloudflare can bind signals across IP, TLS, JavaScript state, cookies and behavior. None can promise an exact final-minute capture.

## BookMyShow-specific thread

The BookMyShow discussion concerns high-demand Coldplay ticket queues. It includes speculation about Queue-it and bot/scalper behavior, but no verified cinema showtime/seat API or backend details useful to this tracker. It does include another report of Cloudflare blocking a BookMyShow notifier scraper.

## TheSpeedX public proxy list

The public proxy list is not suitable for this application:

- The repository publishes arbitrary public HTTP, SOCKS4 and SOCKS5 exit nodes and explicitly says its maintainer is not responsible for them. It does not provide the trust, location, uptime or anonymity guarantees needed for a production collector.
- The GitHub Actions workflow runs every three hours, but downloads the actual updater from a secret URL and executes it. The sourcing and validation logic therefore cannot be audited from the repository.
- Public proxies are commonly short-lived and abused, so their IP reputation is likely to make Cloudflare challenges more frequent. Rotating exits also destroys the stable IP/session relationship that a Cloudflare clearance may depend on.
- Sending a logged-in browser profile, cookies or BookMyShow traffic through an unknown operator would create an unacceptable privacy and account-security risk.

The tracker deliberately has no public-proxy rotation mode. These lists should not be used even as an automatic fallback.

## Decision

The primary collector is a personal Chrome extension on an always-on local machine. It uses a normal visible browser, stable profile, stable ordinary network, one pinned tab and conservative refresh intervals. It never solves or bypasses a challenge; it asks the user to complete verification. The cloud backend stores and serves results but does not need to access BookMyShow.

Sources:

- https://www.reddit.com/r/webscraping/comments/1j7mqs7/cloudflare_blocking_my_scraper_in_the_cloud_but/
- https://www.reddit.com/r/webscraping/comments/1d9j6kh/how_to_bypass_cloudflare/
- https://www.reddit.com/r/programming/comments/1rte5ui/what_i_learned_trying_to_block_web_scraping_and/
- https://www.reddit.com/r/developersIndia/comments/1fmpk5p/someone_working_at_bookmyshow_drop_the_backend/
- https://github.com/TheSpeedX/PROXY-List
- https://github.com/TheSpeedX/PROXY-List/blob/master/.github/workflows/action.yml
- https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt
