import pytest

from mpltalkies_bms.app import BmsBrowserSession, UpstreamError, parse_layout, parse_schedule


def _seats(area: str, status: int, count: int, start: int = 1) -> list[str]:
    return [f"{area}{status}{number:03d}+{number}" for number in range(start, start + count)]


def test_ravi_layout_counts_only_real_seats() -> None:
    header = "BALCONY:A:BA:1|RESERVED:B:RE:2|FIRST CLASS:C:FC:3|SECOND CLASS:D:SC:4"
    rows = [
        "1:A:" + ":".join(_seats("A", 1, 100) + _seats("A", 2, 32, 101) + _seats("A", 0, 2, 900)),
        "2:B:" + ":".join(_seats("B", 4, 200) + _seats("B", 2, 13, 201)),
        "3:C:" + ":".join(_seats("C", 1, 90) + _seats("C", 2, 22, 91)),
        "4:D:" + ":".join(_seats("D", 1, 150) + _seats("D", 2, 30, 151)),
    ]
    prices = [{"name": name, "listPricePaise": 10_500} for name in ("BALCONY", "RESERVED", "FIRST CLASS", "SECOND CLASS")]
    result = parse_layout(header + "||" + "|".join(rows), prices)
    assert sum(item["capacity"] for item in result) == 637
    assert sum(item["unavailable"] for item in result) == 97


def test_schedule_parser_returns_ravi_session_metadata() -> None:
    state = {"venueShowtimesFunctionalApi": {"queries": {"getShowtimesByVenue-RTDM-20261127": {"data": {"showDetailsTransformed": {"Event": [{
        "EventTitle": "Test Movie", "ChildEvents": [{"EventCode": "ET001", "EventName": "Test Movie - Telugu", "EventLanguage": "Telugu", "EventDimension": "2D", "ShowTimes": [{
            "SessionId": "1234", "ShowTimeCode": "1100", "ShowTime": "11:00 AM", "ShowDateTime": "202611271100", "CutOffDateTime": "202611271115",
            "Categories": [{"PriceDesc": "BALCONY", "PriceCode": "BA", "CurPrice": 105}]
        }]}]
    }]}}}}}}
    html = f"<script>window.__INITIAL_STATE__ = {__import__('json').dumps(state)};</script>"
    shows = parse_schedule(html, "2026-11-27")
    assert len(shows) == 1
    assert shows[0]["sessionId"] == "1234"
    assert shows[0]["cutoffAt"] == "2026-11-27T05:45:00Z"


def test_browser_transport_reports_provider_blocks() -> None:
    with pytest.raises(UpstreamError, match="Chromium with HTTP 403") as blocked:
        BmsBrowserSession._assert_page_status(403, "Ravi schedule request")
    assert blocked.value.code == "forbidden"
    assert blocked.value.status == 403


def test_browser_transport_rejects_verification_pages() -> None:
    with pytest.raises(UpstreamError, match="verification page") as blocked:
        BmsBrowserSession._assert_not_challenge("<title>Just a moment...</title>", "browser warm-up")
    assert blocked.value.code == "browser_verification_required"

