from __future__ import annotations

import base64
import json
import os
import secrets
from datetime import datetime, timezone
from typing import Any

import httpx
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7
from fastapi import Depends, FastAPI, Header, HTTPException

RAVI_CODE = "RTDM"
RAVI_SLUG = "ravi-a-c-4k-laser-dolby-surround-71-madanapalle"
BMS_BASE = "https://in.bookmyshow.com"
BMS_SEAT_ENDPOINT = "https://services-in.bookmyshow.com/doTrans.aspx"
RAVI_CAPACITIES = {
    "BALCONY": 132,
    "RESERVED": 213,
    "FIRST CLASS": 112,
    "SECOND CLASS": 180,
}


class UpstreamError(Exception):
    def __init__(self, message: str, *, status: int = 502, code: str = "upstream_error") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def _normalized(value: Any) -> str:
    return " ".join(str(value or "").strip().upper().split())


def _date_code(value: str) -> str:
    result = value.replace("-", "")
    if len(result) != 8 or not result.isdigit():
        raise ValueError("showDate must be YYYY-MM-DD")
    return result


def _bms_time(value: Any) -> str:
    raw = str(value or "")
    if len(raw) != 12 or not raw.isdigit():
        raise UpstreamError("BMS returned an invalid show timestamp", code="schema_changed")
    parsed = datetime.strptime(raw, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    # The source value is India wall-clock time. Convert it to UTC without
    # depending on the host's local timezone.
    return datetime.fromtimestamp(parsed.timestamp() - 19_800, timezone.utc).isoformat().replace("+00:00", "Z")


def extract_initial_state(html: str) -> dict[str, Any]:
    marker = "window.__INITIAL_STATE__"
    position = html.find(marker)
    if position < 0:
        raise UpstreamError("BMS schedule state was not found", code="verification_or_schema_changed")
    start = html.find("{", position)
    if start < 0:
        raise UpstreamError("BMS schedule state was incomplete", code="schema_changed")
    try:
        state, _ = json.JSONDecoder().raw_decode(html[start:])
    except json.JSONDecodeError as error:
        raise UpstreamError("BMS schedule state was invalid JSON", code="schema_changed") from error
    if not isinstance(state, dict):
        raise UpstreamError("BMS schedule state was not an object", code="schema_changed")
    return state


def parse_schedule(html: str, show_date: str) -> list[dict[str, Any]]:
    code = _date_code(show_date)
    state = extract_initial_state(html)
    queries = state.get("venueShowtimesFunctionalApi", {}).get("queries", {})
    query = queries.get(f"getShowtimesByVenue-{RAVI_CODE}-{code}")
    if query is None:
        query = next((value for key, value in queries.items() if RAVI_CODE in key and code in key), None)
    details = (query or {}).get("data", {}).get("showDetailsTransformed")
    if not isinstance(details, dict):
        raise UpstreamError("BMS did not include Ravi's requested schedule", code="schedule_missing")

    shows: list[dict[str, Any]] = []
    for event in details.get("Event", []):
        for child in event.get("ChildEvents", []):
            for show in child.get("ShowTimes", []):
                session_id = str(show.get("SessionId") or "").strip()
                event_code = str(child.get("EventCode") or "").strip()
                show_time_code = str(show.get("ShowTimeCode") or "").strip()
                if not session_id or not event_code or not show_time_code:
                    continue
                categories = []
                for category in show.get("Categories", []):
                    price = round(float(category.get("CurPrice") or 0) * 100)
                    if price <= 0:
                        raise UpstreamError("BMS returned a Ravi category without a price", code="schema_changed")
                    categories.append({
                        "name": str(category.get("PriceDesc") or "Category"),
                        "priceCode": str(category.get("PriceCode") or ""),
                        "listPricePaise": price,
                        "availabilityStatus": str(category.get("AvailStatus") or ""),
                    })
                shows.append({
                    "showTimeCode": show_time_code,
                    "showTimeLabel": str(show.get("ShowTime") or ""),
                    "startAt": _bms_time(show.get("ShowDateTime")),
                    "cutoffAt": _bms_time(show.get("CutOffDateTime")),
                    "sessionId": session_id,
                    "eventCode": event_code,
                    "movieTitle": str(event.get("EventTitle") or child.get("EventName") or "Untitled movie"),
                    "movieVariant": str(child.get("EventName") or event.get("EventTitle") or ""),
                    "language": str(child.get("EventLanguage") or child.get("EventLang") or ""),
                    "format": str(child.get("EventDimension") or ""),
                    "screenName": str(show.get("ScreenName") or ""),
                    "categories": categories,
                })
    return shows


def decrypt_layout(encoded: str, key_text: str) -> str:
    if len(key_text.encode("utf-8")) != 32:
        raise RuntimeError("BMS_LAYOUT_KEY must be exactly 32 bytes")
    try:
        ciphertext = base64.b64decode(encoded, validate=True)
        decryptor = Cipher(algorithms.AES(key_text.encode("utf-8")), modes.CBC(bytes(16))).decryptor()
        padded = decryptor.update(ciphertext) + decryptor.finalize()
        unpadder = PKCS7(128).unpadder()
        return (unpadder.update(padded) + unpadder.finalize()).decode("utf-8")
    except Exception as error:
        raise UpstreamError("BMS seat layout could not be decoded", code="decode_failed") from error


def parse_layout(layout: str, advertised_categories: list[dict[str, Any]]) -> list[dict[str, Any]]:
    try:
        area_section, row_section = layout.split("||", 1)
    except ValueError as error:
        raise UpstreamError("BMS returned an unknown seat-layout shape", code="schema_changed") from error

    areas: dict[str, dict[str, Any]] = {}
    for raw_area in filter(None, area_section.split("|")):
        fields = raw_area.split(":")
        if len(fields) < 4:
            raise UpstreamError("BMS returned a malformed seat category", code="schema_changed")
        name, area_id, area_code = fields[:3]
        areas[area_id] = {"name": _normalized(name), "priceCode": area_code, "available": 0, "unavailable": 0, "unknown": 0}

    for raw_row in filter(None, row_section.split("|")):
        fields = raw_row.split(":")
        if len(fields) < 2:
            raise UpstreamError("BMS returned a malformed seat row", code="schema_changed")
        for raw_seat in fields[2:]:
            token = raw_seat.split("+", 1)[0]
            if len(token) < 2 or not token[1].isdigit() or token[0] not in areas:
                raise UpstreamError("BMS returned an unrecognized seat token", code="schema_changed")
            status = int(token[1])
            if status == 0:
                continue
            if status in (1, 4):
                areas[token[0]]["available"] += 1
            elif status == 2:
                areas[token[0]]["unavailable"] += 1
            else:
                areas[token[0]]["unknown"] += 1

    prices = {_normalized(item.get("name")): int(item.get("listPricePaise") or 0) for item in advertised_categories}
    categories = []
    for area in areas.values():
        name = area["name"]
        capacity = area["available"] + area["unavailable"] + area["unknown"]
        expected = RAVI_CAPACITIES.get(name)
        if expected is None or capacity != expected or area["unknown"]:
            raise UpstreamError(f"Rejected Ravi {name}: expected a complete verified layout", code="layout_mismatch")
        price = prices.get(name, 0)
        if price <= 0:
            raise UpstreamError(f"Rejected Ravi {name}: no advertised price", code="price_mismatch")
        categories.append({
            "name": name,
            "listPricePaise": price,
            "capacity": capacity,
            "available": area["available"],
            "unavailable": area["unavailable"],
            "unknown": 0,
        })
    if set(RAVI_CAPACITIES) != {item["name"] for item in categories}:
        raise UpstreamError("Rejected Ravi layout: category set changed", code="layout_mismatch")
    return categories


def _settings() -> tuple[str, str]:
    token = os.environ.get("BMS_CAPTURE_SERVICE_TOKEN", "")
    key = os.environ.get("BMS_LAYOUT_KEY", "")
    if len(token) < 24:
        raise RuntimeError("BMS_CAPTURE_SERVICE_TOKEN must be at least 24 characters")
    if len(key.encode("utf-8")) != 32:
        raise RuntimeError("BMS_LAYOUT_KEY must be exactly 32 bytes")
    return token, key


def authorize(authorization: str = Header(default="")) -> None:
    token, _ = _settings()
    supplied = authorization.removeprefix("Bearer ").strip()
    if not supplied or not secrets.compare_digest(supplied, token):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _assert_ravi(payload: dict[str, Any]) -> None:
    if payload.get("venueCode") != RAVI_CODE or payload.get("venueSlug") != RAVI_SLUG:
        raise HTTPException(status_code=400, detail="This testing service accepts Ravi only")


def _headers() -> dict[str, str]:
    return {
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
    }


async def _checked(response: httpx.Response, action: str) -> httpx.Response:
    if response.status_code in (403, 429):
        raise UpstreamError(f"BMS blocked {action} with HTTP {response.status_code}", status=response.status_code, code="forbidden" if response.status_code == 403 else "rate_limited")
    if response.status_code >= 400:
        raise UpstreamError(f"BMS {action} returned HTTP {response.status_code}", status=502, code="http_error")
    return response


app = FastAPI(title="MPLTalkies Ravi BMS Testing", docs_url=None, redoc_url=None)


@app.exception_handler(UpstreamError)
async def upstream_error_handler(_request: Any, error: UpstreamError):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=error.status, content={"code": error.code, "message": str(error)})


@app.get("/healthz")
async def health() -> dict[str, str]:
    return {"status": "ok", "venueCode": RAVI_CODE}


@app.post("/v1/ravi/discover", dependencies=[Depends(authorize)])
async def discover(payload: dict[str, Any]) -> dict[str, Any]:
    _assert_ravi(payload)
    show_date = str(payload.get("showDate") or "")
    code = _date_code(show_date)
    url = f"{BMS_BASE}/cinemas/mdnp/{RAVI_SLUG}/buytickets/{RAVI_CODE}/{code}"
    async with httpx.AsyncClient(headers=_headers(), follow_redirects=True, timeout=15) as client:
        response = await _checked(await client.get(url), "Ravi schedule request")
    return {"venueCode": RAVI_CODE, "showDate": show_date, "shows": parse_schedule(response.text, show_date)}


@app.post("/v1/ravi/capture", dependencies=[Depends(authorize)])
async def capture(payload: dict[str, Any]) -> dict[str, Any]:
    _assert_ravi(payload)
    show_date = str(payload.get("showDate") or "")
    session_id = str(payload.get("sessionId") or "").strip()
    event_code = str(payload.get("eventCode") or "").strip()
    categories = payload.get("categories")
    if not session_id or not event_code or not isinstance(categories, list):
        raise HTTPException(status_code=400, detail="Incomplete Ravi show request")

    code = _date_code(show_date)
    page_url = f"{BMS_BASE}/cinemas/mdnp/{RAVI_SLUG}/buytickets/{RAVI_CODE}/{code}"
    fields = {
        "strAppCode": "WEB",
        "lngTransactionIdentifier": "0",
        "strCommand": "GETSEATLAYOUT",
        "strVenueCode": RAVI_CODE,
        "strParam1": session_id,
        "strParam2": "WEB",
        "strParam3": "",
        "strParam4": "",
        "strParam5": "Y",
        "strParam6": "N",
        "strParam7": "N",
        "strParam8": "",
        "strParam9": "",
        "strParam10": "",
        "strFormat": "json",
    }
    request_id = f"1.{secrets.randbelow(1_000_000_000)}.{secrets.randbelow(10**13)}"
    async with httpx.AsyncClient(headers=_headers(), follow_redirects=True, timeout=15) as client:
        await _checked(await client.get(page_url), "show warm-up request")
        response = await _checked(await client.post(
            BMS_SEAT_ENDPOINT,
            headers={"Accept": "application/json, text/plain, */*", "Origin": BMS_BASE, "Referer": f"{BMS_BASE}/", "x-app-code": "WEB", "x-bms-id": request_id},
            files={name: (None, value) for name, value in fields.items()},
        ), "seat-layout request")
    try:
        envelope = response.json().get("BookMyShow", {})
    except ValueError as error:
        raise UpstreamError("BMS seat response was not JSON", code="schema_changed") from error
    if str(envelope.get("blnSuccess")).lower() != "true" or not envelope.get("strData"):
        raise UpstreamError(str(envelope.get("strException") or "BMS returned no seat layout"), code="no_seat_data")
    _, key = _settings()
    parsed = parse_layout(decrypt_layout(envelope["strData"], key), categories)
    captured_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {"venueCode": RAVI_CODE, "sessionId": session_id, "capturedAt": captured_at, "categories": parsed}

