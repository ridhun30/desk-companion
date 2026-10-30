#!/usr/bin/env python3
"""Desk Companion server.

Serves the web app from ./public and exposes /api/agenda, which merges
Microsoft 365 (via Graph, see microsoft.py) and published ICS calendars into a
JSON list of events. Browsers can't fetch Outlook ICS links directly (no CORS
headers), and recurring events need expanding, so both happen here.
"""
import argparse
import json
import os
import sys
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from microsoft import MicrosoftCalendar, NotSignedIn

try:
    import icalendar
    import recurring_ical_events
except ImportError:  # the app still runs; only the agenda needs these
    icalendar = None

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
CONFIG_PATH = Path(os.environ.get("DESK_CONFIG", ROOT / "config.json"))
TOKEN_PATH = ROOT / ".ms-token.json"
CACHE_SECONDS = 600
MAX_RANGE = timedelta(days=14)

_cache = {}  # url -> (fetched_at, icalendar.Calendar)
_cache_lock = threading.Lock()
_microsoft = None


def load_config():
    return json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}


def load_ics_urls(config):
    """ICS links from config.json and/or the OUTLOOK_ICS_URL env var."""
    urls = list(config.get("ics_urls", []))
    urls += [u.strip() for u in os.environ.get("OUTLOOK_ICS_URL", "").split(",") if u.strip()]
    return [("https://" + u[len("webcal://"):]) if u.startswith("webcal://") else u for u in urls]


def microsoft_calendar(config):
    """The MicrosoftCalendar for config["microsoft"], or None if not set up."""
    global _microsoft
    ms = config.get("microsoft") or {}
    if not ms.get("client_id"):
        return None
    if _microsoft is None or _microsoft.client_id != ms["client_id"]:
        _microsoft = MicrosoftCalendar(ms["client_id"], ms.get("tenant"), TOKEN_PATH)
    return _microsoft


def get_calendar(url):
    """Return (calendar, stale). Falls back to the last good copy if a fetch fails."""
    with _cache_lock:
        hit = _cache.get(url)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1], False
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "desk-companion/1.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            cal = icalendar.Calendar.from_ical(resp.read())
    except Exception:
        if hit:
            return hit[1], True
        raise
    with _cache_lock:
        _cache[url] = (time.time(), cal)
    return cal, False


def serialize_time(value, floating_tz):
    """Timed events become UTC ISO strings; all-day events stay YYYY-MM-DD."""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=floating_tz)
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"), False
    return value.isoformat(), True


def ics_events(url, start, end):
    """Return (events, stale) for one ICS feed."""
    if icalendar is None:
        raise RuntimeError("calendar libraries missing: pip install -r requirements.txt")
    cal, stale = get_calendar(url)
    events = []
    for ev in recurring_ical_events.of(cal).between(start, end):
        if str(ev.get("STATUS", "")).upper() == "CANCELLED":
            continue
        dtstart = ev.decoded("DTSTART")
        if "DTEND" in ev:
            dtend = ev.decoded("DTEND")
        elif "DURATION" in ev:
            dtend = dtstart + ev.decoded("DURATION")
        else:
            dtend = dtstart if isinstance(dtstart, datetime) else dtstart + timedelta(days=1)

        start_s, all_day = serialize_time(dtstart, start.tzinfo)
        end_s, _ = serialize_time(dtend, start.tzinfo)
        events.append({
            "title": str(ev.get("SUMMARY", "")).strip() or "(No title)",
            "location": str(ev.get("LOCATION", "")).strip() or None,
            "start": start_s,
            "end": end_s,
            "allDay": all_day,
        })
    return events, stale


def build_agenda(start, end):
    config = load_config()
    sources = []  # (label, fetch) pairs
    ms = microsoft_calendar(config)
    if ms:
        sources.append(("Microsoft 365", ms.events))
    for url in load_ics_urls(config):
        sources.append((urlparse(url).hostname or "calendar", lambda s, e, url=url: ics_events(url, s, e)))
    if not sources:
        return {"configured": False, "events": []}

    events, errors, stale, seen = [], [], False, set()
    for label, fetch in sources:
        try:
            source_events, source_stale = fetch(start, end)
        except NotSignedIn as exc:
            errors.append(str(exc))
            continue
        except Exception as exc:
            errors.append(f"{label}: {exc}")
            continue
        stale = stale or source_stale
        for ev in source_events:
            # The same meeting can show up in several feeds.
            key = (ev["title"], ev["start"], ev["end"])
            if key not in seen:
                seen.add(key)
                events.append(ev)
    return {"configured": True, "events": events, "stale": stale, "errors": errors}


def parse_range(query):
    local_midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    start = datetime.fromisoformat(query["start"][0]) if "start" in query else local_midnight
    end = datetime.fromisoformat(query["end"][0]) if "end" in query else start + timedelta(days=2)
    if start.tzinfo is None or end.tzinfo is None:
        raise ValueError("start and end need a UTC offset")
    if not start < end <= start + MAX_RANGE:
        raise ValueError("end must be after start and within 14 days")
    return start, end


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/health":
            return self.send_json({"ok": True})
        if url.path == "/api/agenda":
            return self.handle_agenda(parse_qs(url.query))
        return super().do_GET()

    def handle_agenda(self, query):
        try:
            start, end = parse_range(query)
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        try:
            agenda = build_agenda(start, end)
        except Exception as exc:
            return self.send_json({"error": f"Could not read calendar: {exc}"}, HTTPStatus.BAD_GATEWAY)
        if agenda["configured"] and agenda["errors"] and not agenda["events"]:
            return self.send_json({**agenda, "error": "; ".join(agenda["errors"])}, HTTPStatus.BAD_GATEWAY)
        return self.send_json(agenda)

    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to reach it from other devices")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--login", action="store_true", help="sign in to Microsoft 365 and exit")
    parser.add_argument("--logout", action="store_true", help="forget the Microsoft 365 sign-in and exit")
    args = parser.parse_args()

    if args.login or args.logout:
        ms = microsoft_calendar(load_config())
        if ms is None:
            sys.exit('Add a "microsoft": {"client_id": ..., "tenant": ...} section to config.json first (see README).')
        if args.logout:
            ms.logout()
            print("Signed out of Microsoft 365.")
            return
        try:
            ms.login()
        except RuntimeError as exc:
            sys.exit(f"Sign-in failed: {exc}")
        print("Signed in. Start the server and the agenda will appear within a few minutes.")
        return

    if icalendar is None:
        print("Note: icalendar not installed; ICS calendars won't load (Microsoft 365 still works).", file=sys.stderr)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Desk Companion running at http://{'localhost' if args.host == '127.0.0.1' else args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
