import json
import unittest
from pathlib import Path

from scrape import active_sessions


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "web" / "data"
FIRST_YEAR_PROGRAMS = (
    "computer",
    "mechanical",
    "industrial",
    "chemical",
    "materials",
    "civil",
    "mineral",
    "trackone",
)
SECOND_YEAR_PROGRAMS = (
    "computer",
    "electrical",
    "mechanical",
    "industrial",
    "chemical",
    "materials",
    "civil",
    "mineral",
)


class DataContractTests(unittest.TestCase):
    def load(self, program, session, year="1"):
        path = DATA_DIR / f"{program}-{year}-{session}.json"
        self.assertTrue(path.exists(), f"missing generated dataset: {path.name}")
        with path.open(encoding="utf-8") as handle:
            data = json.load(handle)
        self.assertIsInstance(data, list)
        self.assertTrue(data, f"empty generated dataset: {path.name}")
        return data

    def assert_valid_course_and_section_shapes(self, data, expected_session):
        codes = set()
        for course in data:
            self.assertRegex(course.get("code", ""),
                             r"^[A-Z]{3,4}\d{3}[HY]\d$")
            self.assertIn(expected_session, course.get("sessions", []))
            codes.add(course["code"])
            self.assertIsInstance(course.get("sections"), list)
            for section in course["sections"]:
                self.assertIn(section.get("teachMethod"),
                              {"LEC", "TUT", "PRA", "SEM", "LAB"})
                meetings = section.get("meetingTimes") or []
                sort_keys = [
                    (m["start"].get("day", 0),
                     m["start"].get("millisofday", 0))
                    for m in meetings
                ]
                self.assertEqual(sort_keys, sorted(sort_keys))
        self.assertTrue(codes)

    def test_first_year_matrix_has_valid_course_and_section_shapes(self):
        sessions = active_sessions()
        for program in FIRST_YEAR_PROGRAMS:
            for semester in ("fall", "winter"):
                with self.subTest(program=program, semester=semester):
                    expected_session = sessions[semester][0]
                    self.assert_valid_course_and_section_shapes(
                        self.load(program, semester), expected_session,
                    )

    def test_second_year_matrix_has_valid_course_and_section_shapes(self):
        sessions = active_sessions()
        for program in SECOND_YEAR_PROGRAMS:
            for semester in ("fall", "winter"):
                with self.subTest(program=program, semester=semester):
                    expected_session = sessions[semester][0]
                    self.assert_valid_course_and_section_shapes(
                        self.load(program, semester, year="2"), expected_session,
                    )

    def test_trackone_and_ece_first_year_course_sets_match(self):
        for semester in ("fall", "winter"):
            with self.subTest(semester=semester):
                ece = self.load("computer", semester)
                trackone = self.load("trackone", semester)
                self.assertEqual(
                    {course["code"] for course in ece},
                    {course["code"] for course in trackone},
                )

    def test_mechanical_and_chemical_winter_caches_match_required_courses(self):
        expected = {
            "mechanical": {
                "APS106H1", "APS112H1", "ECE110H1", "MAT187H1",
                "MIE100H1", "MIE191H1",
            },
            "chemical": {
                "APS106H1", "APS112H1", "CHE112H1", "CHE113H1",
                "CHE191H1", "MAT187H1",
            },
        }
        for program, required in expected.items():
            with self.subTest(program=program):
                data = self.load(program, "winter")
                self.assertEqual({course["code"] for course in data}, required)

    def test_existing_second_year_ece_tracks_are_preserved(self):
        with (DATA_DIR / "computer-2-winter.json").open(encoding="utf-8") as handle:
            computer = {course["code"] for course in json.load(handle)}
        with (DATA_DIR / "electrical-2-winter.json").open(encoding="utf-8") as handle:
            electrical = {course["code"] for course in json.load(handle)}
        self.assertIn("ECE297H1", computer)
        self.assertNotIn("ECE295H1", computer)
        self.assertIn("ECE295H1", electrical)
        self.assertNotIn("ECE297H1", electrical)


if __name__ == "__main__":
    unittest.main()
