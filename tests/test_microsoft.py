import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DESK_CONFIG", str(ROOT / "tests" / "no-config.json"))

import microsoft  # noqa: E402
import server  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
START = datetime(2026, 11, 3, tzinfo=IST)
END = START + timedelta(days=2)


def graph_event(subject, start, end, all_day=False, cancelled=False, location=""):
    return {
        "subject": subject,
        "start": {"dateTime": start + ".0000000", "timeZone": "UTC"},
        "end": {"dateTime": end + ".0000000", "timeZone": "UTC"},
        "isAllDay": all_day,
        "isCancelled": cancelled,
        "location": {"displayName": location},
    }


class MappingTest(unittest.TestCase):
    def test_timed_event(self):
        ev = microsoft.to_agenda_event(graph_event("Standup", "2026-11-03T04:00:00", "2026-11-03T04:15:00", location="Teams"), START.utcoffset())
        self.assertEqual(ev, {"title": "Standup", "location": "Teams", "start": "2026-11-03T04:00:00Z",
                              "end": "2026-11-03T04:15:00Z", "allDay": False})

    def test_all_day_event_keeps_local_date(self):
        # An all-day event on 3 Nov in IST arrives as 2 Nov 18:30 UTC.
        ev = microsoft.to_agenda_event(graph_event("Holiday", "2026-11-02T18:30:00", "2026-11-03T18:30:00", all_day=True), START.utcoffset())
        self.assertEqual((ev["start"], ev["end"], ev["allDay"], ev["location"]), ("2026-11-03", "2026-11-04", True, None))


class CalendarTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.token_path = Path(self.tmp.name) / "token.json"
        self.cal = microsoft.MicrosoftCalendar("client-123", "contoso.onmicrosoft.com", self.token_path)

    def tearDown(self):
        self.tmp.cleanup()

    def write_token(self, expires_at):
        self.token_path.write_text(json.dumps({"access_token": "old", "refresh_token": "r1", "expires_at": expires_at}))

    def test_not_signed_in(self):
        with self.assertRaises(microsoft.NotSignedIn):
            self.cal.events(START, END)

    def test_refreshes_expired_token_and_follows_pages(self):
        self.write_token(time.time() - 10)
        calls = []

        def fake_request(url, data=None, headers=None):
            calls.append((url, data, headers))
            if url.endswith("/token"):
                return 200, {"access_token": "new", "refresh_token": "r2", "expires_in": 3600}
            if "page2" in url:
                return 200, {"value": [graph_event("Review", "2026-11-04T08:00:00", "2026-11-04T09:00:00")]}
            return 200, {"value": [graph_event("Standup", "2026-11-03T04:00:00", "2026-11-03T04:15:00"),
                                   graph_event("Dropped", "2026-11-03T06:00:00", "2026-11-03T07:00:00", cancelled=True)],
                         "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?page2"}

        with mock.patch.object(microsoft, "_request", fake_request):
            events, stale = self.cal.events(START, END)

        self.assertFalse(stale)
        self.assertEqual([e["title"] for e in events], ["Standup", "Review"])
        token_call = calls[0]
        self.assertEqual(token_call[0], "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token")
        self.assertEqual(token_call[1]["refresh_token"], "r1")
        self.assertEqual(calls[1][2]["Authorization"], "Bearer new")
        self.assertIn("startDateTime=2026-11-02T18%3A30%3A00%2B00%3A00", calls[1][0])
        saved = json.loads(self.token_path.read_text())
        self.assertEqual(saved["refresh_token"], "r2")
        self.assertEqual(oct(self.token_path.stat().st_mode & 0o777), "0o600")

    def test_expired_refresh_token_asks_to_sign_in_again(self):
        self.write_token(time.time() - 10)
        with mock.patch.object(microsoft, "_request", return_value=(400, {"error": "invalid_grant"})):
            with self.assertRaisesRegex(microsoft.NotSignedIn, "expired"):
                self.cal.events(START, END)

    def test_serves_cached_events_when_graph_fails(self):
        self.write_token(time.time() + 3600)
        ok = (200, {"value": [graph_event("Standup", "2026-11-03T04:00:00", "2026-11-03T04:15:00")]})
        with mock.patch.object(microsoft, "_request", return_value=ok):
            self.cal.events(START, END)
        self.cal._cache = {k: (0, v[1]) for k, v in self.cal._cache.items()}  # expire the cache
        with mock.patch.object(microsoft, "_request", return_value=(503, {"error": {"message": "busy"}})):
            events, stale = self.cal.events(START, END)
        self.assertTrue(stale)
        self.assertEqual(events[0]["title"], "Standup")


class AgendaIntegrationTest(unittest.TestCase):
    def test_reports_sign_in_needed(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(server, "TOKEN_PATH", Path(tmp) / "token.json"), \
                mock.patch.object(server, "_microsoft", None), \
                mock.patch.object(server, "load_config", return_value={"microsoft": {"client_id": "abc"}}), \
                mock.patch.dict(os.environ, {"OUTLOOK_ICS_URL": ""}):
            agenda = server.build_agenda(START, END)
        self.assertTrue(agenda["configured"])
        self.assertEqual(agenda["events"], [])
        self.assertIn("--login", agenda["errors"][0])


if __name__ == "__main__":
    unittest.main()
