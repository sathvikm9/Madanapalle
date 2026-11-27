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

The adapter uses ordinary HTTPS requests, keeps one short-lived cookie session, and stops on HTTP 403/429. It does not rotate fingerprints or proxies. A provider rejection is reported as missing test data, never as zero seats.

