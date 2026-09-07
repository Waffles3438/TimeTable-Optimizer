import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import call, patch

import scrape


class ScrapeTests(unittest.TestCase):
    def test_first_year_uses_100_api_level_and_exact_curriculum_codes(self):
        raw = [
            {"code": "APS100H1", "sections": []},
            {"code": "MSE120H1", "sections": []},
            {"code": "NOT999H1", "sections": []},
        ]
        args = Namespace(
            sessions=["20269"],
            divisions=["APSC"],
            levels=None,
            year="1",
            prefix=None,
            department=None,
            curriculum="materials",
            codes=None,
            out=None,
            session="fall",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            args.out = str(Path(temp_dir) / "courses.json")
            with patch("scrape.get_program_courses", return_value={
                "fall": ["APS100H1", "MSE120H1"]
            }) as get_curriculum, patch(
                "scrape.fetch_courses", return_value=raw
            ) as fetch, patch("scrape.save_cached") as save_cached, patch(
                "scrape.os.path.isdir", return_value=False
            ):
                scrape.scrape_session(args, "fall")

            fetch.assert_called_once_with(["20269"], ["APSC"], ["100/A"])
            get_curriculum.assert_called_once_with("materials", "1")
            save_cached.assert_called_once()
            saved = json.loads(Path(args.out).read_text())
            self.assertEqual({course["code"] for course in saved},
                             {"APS100H1", "MSE120H1"})

    def test_curriculum_retries_non_apsc_division_for_missing_codes(self):
        first_response = [{"code": "MIE210H1", "sections": []}]
        fallback_response = [
            {"code": "MIE210H1", "sections": []},
            {"code": "ESS262H1", "sections": []},
        ]
        args = Namespace(
            sessions=["20269"],
            divisions=["APSC"],
            levels=None,
            year="2",
            prefix=None,
            department=None,
            curriculum="mineral",
            codes=None,
            out=None,
            session="fall",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            args.out = str(Path(temp_dir) / "courses.json")
            with patch("scrape.get_program_courses", return_value={
                "fall": ["MIE210H1", "ESS262H1"],
            }), patch(
                "scrape.fetch_courses",
                side_effect=[first_response, fallback_response],
            ) as fetch, patch("scrape.save_cached"):
                scrape.scrape_session(args, "fall")

            self.assertEqual(fetch.call_args_list, [
                call(["20269"], ["APSC"], ["200/B"]),
                call(["20269"], ["APSC", "ARTSC"], ["200/B"]),
            ])
            self.assertEqual(
                {course["code"] for course in json.loads(Path(args.out).read_text())},
                {"MIE210H1", "ESS262H1"},
            )

    def test_curriculum_missing_codes_fail_before_writing_cache(self):
        args = Namespace(
            sessions=["20269"],
            divisions=["APSC"],
            levels=None,
            year="2",
            prefix=None,
            department=None,
            curriculum="mineral",
            codes=None,
            out="courses.json",
            session="fall",
        )
        with patch("scrape.get_program_courses", return_value={
            "fall": ["ESS262H1"],
        }), patch(
            "scrape.fetch_courses",
            return_value=[{"code": "MIE210H1", "sections": []}],
        ), patch("scrape.save_cached") as save_cached:
            with self.assertRaises(SystemExit):
                scrape.scrape_session(args, "fall")
        save_cached.assert_not_called()

        args = Namespace(curriculum="trackone", year="1", session="fall")
        self.assertEqual(scrape.cached_filename(args), "trackone-1-fall.json")

    def test_program_ids_are_available_to_the_cli(self):
        self.assertEqual(
            set(scrape.PROGRAM_IDS),
            {
                "computer",
                "electrical",
                "mechanical",
                "industrial",
                "chemical",
                "materials",
                "civil",
                "mineral",
                "trackone",
            },
        )

    def test_normalize_courses_sorts_meetings(self):
        courses = [{
            "code": "MSE120H1",
            "sections": [{
                "meetingTimes": [
                    {"start": {"day": 5, "millisofday": 2}},
                    {"start": {"day": 1, "millisofday": 3}},
                ]
            }],
        }]
        scrape.normalize_courses(courses)
        meetings = courses[0]["sections"][0]["meetingTimes"]
        self.assertEqual([m["start"]["day"] for m in meetings], [1, 5])


if __name__ == "__main__":
    unittest.main()
