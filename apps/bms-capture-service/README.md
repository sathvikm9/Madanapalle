# Ravi BMS capture service

This small service is the network adapter for the isolated MPLTalkies **Testing** tab. It discovers only Ravi (`RTDM`) and reads only a requested Ravi session. It never writes to the production database; the Cloudflare Worker validates its response and stores accepted results in `bms_testing_*` tables.

Required secrets:

- `BMS_CAPTURE_SERVICE_TOKEN`: long random token shared only with the Worker.
- `BMS_LAYOUT_KEY`: 32-byte seat-layout decoding key. Keep this in the service secret store, never GitHub or the web app.

Run locally:

```sh
python -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
export BMS_CAPTURE_SERVICE_TOKEN='replace-with-a-long-random-token'
export BMS_LAYOUT_KEY='replace-with-the-32-byte-key'
uvicorn mpltalkies_bms.app:app --reload --port 8791
```

The adapter uses one real persistent Chromium context for schedule discovery and seat-layout requests. It warms the normal BookMyShow and Madanapalle pages once, preserves cookies between discovery and final capture, and sends the seat request from inside that same browser page. It stops on HTTP 403/429 or a browser-verification page; it does not rotate identities, solve challenges, or use proxies. A provider rejection is reported as missing test data, never as zero seats.

The Cloudflare Worker must point `BMS_CAPTURE_SERVICE_URL` to this deployed HTTPS service. Setting it to `internal` bypasses Chromium and uses the Worker's plain `fetch()`, which is retained only for unit testing.

