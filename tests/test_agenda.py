import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ["DESK_CONFIG"] = str(ROOT / "tests" / "no-config.json")
os.environ["OUTLOOK_ICS_URL"] = (ROOT / "tests" / "fixtures" / "outlook.ics").as_uri()

import server  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))


class AgendaTest(unittest.TestCase):
    def agenda_for(self, day):
        start = datetime(2026, 11, day, tzinfo=IST)
        return server.build_agenda(start, start + timedelta(days=1))

    def titles(self, agenda):
        return sorted(e["title"] for e in agenda["events"])

    def test_recurring_event_expands_in_its_windows_timezone(self):
        agenda = self.agenda_for(4)
        standup = next(e for e in agenda["events"] if e["title"] == "Team standup")
        self.assertEqual(standup["start"], "2026-11-04T04:00:00Z")  # 09:30 IST
        self.assertEqual(standup["end"], "2026-11-04T04:15:00Z")
        self.assertEqual(standup["location"], "Teams")
        self.assertFalse(standup["allDay"])

    def test_exdate_skips_occurrence(self):
        self.assertNotIn("Team standup", self.titles(self.agenda_for(2)))

    def test_all_day_and_cancelled(self):
        agenda = self.agenda_for(3)
        self.assertEqual(self.titles(agenda), ["Company holiday", "Design review", "Team standup"])
        holiday = next(e for e in agenda["events"] if e["allDay"])
        self.assertEqual((holiday["start"], holiday["end"]), ("2026-11-03", "2026-11-04"))

    def test_weekend_has_no_standup(self):
        self.assertEqual(self.agenda_for(7)["events"], [])

    def test_range_validation(self):
        with self.assertRaises(ValueError):
            server.parse_range({"start": ["2026-11-01T00:00:00"], "end": ["2026-11-02T00:00:00"]})
        with self.assertRaises(ValueError):
            server.parse_range({"start": ["2026-11-01T00:00:00+05:30"], "end": ["2026-12-01T00:00:00+05:30"]})


if __name__ == "__main__":
    unittest.main()
