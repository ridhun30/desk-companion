"""Microsoft 365 calendar via Microsoft Graph.

Uses the OAuth device code flow, so you sign in once from any browser
(`python server.py --login`) and the server keeps itself signed in with the
refresh token. Only the delegated Calendars.Read permission is requested.
Standard library only, so nothing extra to install on Termux.
"""
import json
import os
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

SCOPES = "https://graph.microsoft.com/Calendars.Read offline_access"
GRAPH = "https://graph.microsoft.com/v1.0"
CACHE_SECONDS = 120


class NotSignedIn(Exception):
    pass


def _request(url, data=None, headers=None):
    """Return (status, parsed JSON). OAuth errors come back as JSON bodies with 4xx codes."""
    body = urlencode(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as err:
        try:
            return err.code, json.loads(err.read() or b"{}")
        except ValueError:
            return err.code, {"error": err.reason}


def _utc(graph_datetime):
    # Graph returns e.g. "2026-11-03T04:00:00.0000000"; the zone comes from the Prefer header.
    return datetime.fromisoformat(graph_datetime[:19]).replace(tzinfo=timezone.utc)


def to_agenda_event(item, local_offset):
    """Convert a Graph event to the same shape as ICS events in server.py."""
    start, end = _utc(item["start"]["dateTime"]), _utc(item["end"]["dateTime"])
    if item.get("isAllDay"):
        # All-day events are midnight-to-midnight in the mailbox timezone; shift
        # back to the phone's offset before taking the date.
        start_s = (start + local_offset).date().isoformat()
        end_s = (end + local_offset).date().isoformat()
    else:
        start_s = start.isoformat().replace("+00:00", "Z")
        end_s = end.isoformat().replace("+00:00", "Z")
    return {
        "title": (item.get("subject") or "").strip() or "(No title)",
        "location": ((item.get("location") or {}).get("displayName") or "").strip() or None,
        "start": start_s,
        "end": end_s,
        "allDay": bool(item.get("isAllDay")),
    }


class MicrosoftCalendar:
    def __init__(self, client_id, tenant, token_path):
        self.client_id = client_id
        self.authority = f"https://login.microsoftonline.com/{tenant or 'organizations'}/oauth2/v2.0"
        self.token_path = token_path
        self._lock = threading.Lock()
        self._cache = {}  # (start, end) -> (fetched_at, events)

    # ---- tokens ----

    def _load_token(self):
        try:
            return json.loads(self.token_path.read_text())
        except (OSError, ValueError):
            return None

    def _save_token(self, token):
        token["expires_at"] = time.time() + int(token.get("expires_in", 3600))
        self.token_path.write_text(json.dumps(token))
        os.chmod(self.token_path, 0o600)

    def login(self):
        """Interactive device code sign-in, run from the terminal."""
        status, flow = _request(f"{self.authority}/devicecode", {"client_id": self.client_id, "scope": SCOPES})
        if status != 200:
            raise RuntimeError(flow.get("error_description") or flow.get("error") or f"HTTP {status}")
        print(flow["message"], flush=True)

        interval = int(flow.get("interval", 5))
        deadline = time.time() + int(flow.get("expires_in", 900))
        while time.time() < deadline:
            time.sleep(interval)
            status, token = _request(f"{self.authority}/token", {
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "client_id": self.client_id,
                "device_code": flow["device_code"],
            })
            if status == 200:
                self._save_token(token)
                return
            error = token.get("error")
            if error == "authorization_pending":
                continue
            if error == "slow_down":
                interval += 5
                continue
            raise RuntimeError(token.get("error_description") or error or f"HTTP {status}")
        raise RuntimeError("Sign-in timed out, run --login again")

    def logout(self):
        self.token_path.unlink(missing_ok=True)

    def access_token(self):
        with self._lock:
            token = self._load_token()
            if not token or "refresh_token" not in token:
                raise NotSignedIn("Microsoft 365 not signed in: run `python server.py --login` on the phone")
            if token.get("expires_at", 0) > time.time() + 60:
                return token["access_token"]
            status, fresh = _request(f"{self.authority}/token", {
                "grant_type": "refresh_token",
                "client_id": self.client_id,
                "refresh_token": token["refresh_token"],
                "scope": SCOPES,
            })
            if status != 200:
                if fresh.get("error") == "invalid_grant":
                    raise NotSignedIn("Microsoft 365 sign-in expired: run `python server.py --login` again")
                raise RuntimeError(fresh.get("error_description") or fresh.get("error") or f"HTTP {status}")
            fresh.setdefault("refresh_token", token["refresh_token"])
            self._save_token(fresh)
            return fresh["access_token"]

    # ---- calendar ----

    def events(self, start, end):
        """Return (events, stale) for [start, end). Falls back to the last good result on errors."""
        key = (start.isoformat(), end.isoformat())
        hit = self._cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1], False
        try:
            events = self._fetch(start, end)
        except NotSignedIn:
            raise
        except Exception:
            if hit:
                return hit[1], True
            raise
        self._cache = {key: (time.time(), events)}  # only the current range matters
        return events, False

    def _fetch(self, start, end):
        headers = {
            "Authorization": f"Bearer {self.access_token()}",
            "Prefer": 'outlook.timezone="UTC"',
        }
        params = urlencode({
            "startDateTime": start.astimezone(timezone.utc).isoformat(),
            "endDateTime": end.astimezone(timezone.utc).isoformat(),
            "$select": "subject,start,end,isAllDay,isCancelled,location",
            "$orderby": "start/dateTime",
            "$top": "100",
        })
        url = f"{GRAPH}/me/calendarView?{params}"
        offset = start.utcoffset() or timedelta(0)
        events = []
        while url:
            status, page = _request(url, headers=headers)
            if status != 200:
                message = (page.get("error") or {}).get("message") if isinstance(page.get("error"), dict) else page.get("error")
                raise RuntimeError(f"Graph HTTP {status}: {message}")
            events += [to_agenda_event(item, offset) for item in page.get("value", []) if not item.get("isCancelled")]
            url = page.get("@odata.nextLink")
        return events
