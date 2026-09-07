import unittest
from unittest.mock import Mock, patch

import curriculum


PROGRAM_TITLES = {
    "computer": "COMPUTER ENGINEERING",
    "electrical": "ELECTRICAL ENGINEERING",
    "mechanical": "MECHANICAL ENGINEERING",
    "industrial": "INDUSTRIAL ENGINEERING",
    "chemical": "CHEMICAL ENGINEERING",
    "materials": "MATERIALS ENGINEERING",
    "civil": "CIVIL ENGINEERING",
    "mineral": "MINERAL ENGINEERING",
}


def course_link(code):
    return f'<a href="/course/{code}">{code}</a>'


def year_fixture(title, fall_codes, winter_codes, second_year_code):
    fall = " ".join(course_link(code) for code in fall_codes)
    winter = " ".join(course_link(code) for code in winter_codes)
    return f"""
        <p><strong>First Year {title.title()}</strong></p>
        <table><thead><tr><th>Fall Session - Year 1</th></tr></thead>
        <tbody><tr><td>{fall}</td></tr></tbody></table>
        <table><thead><tr><th>Winter Session – Year 1</th></tr></thead>
        <tbody><tr><td>{winter}</td></tr></tbody></table>
        <p>Approved Course Substitution {course_link('SUB999H1')}</p>
        <p><strong>SECOND YEAR {title}</strong></p>
        <table><thead><tr><th>Fall Session - Year 2</th></tr></thead>
        <tbody><tr><td>{course_link(second_year_code)}</td></tr></tbody></table>
        <p>Approved Course Substitutions {course_link('SUB998H1')}</p>
    """


def ece_fixture():
    computer = year_fixture(
        PROGRAM_TITLES["computer"],
        ["ECE100H1"],
        ["ECE101H1"],
        "ECE200H1",
    )
    electrical = year_fixture(
        PROGRAM_TITLES["electrical"],
        ["ECE100H1"],
        ["ECE101H1"],
        "ECE201H1",
    )
    return computer + electrical


FIXTURES = {
    "Electrical-and-Computer-Engineering": ece_fixture(),
    "Mechanical-Engineering": year_fixture(
        PROGRAM_TITLES["mechanical"], ["MECH100H1"], ["MECH101H1"], "MECH200H1"
    ),
    "Industrial-Engineering": year_fixture(
        PROGRAM_TITLES["industrial"], ["INDU100H1"], ["INDU101H1"], "INDU200H1"
    ),
    "Chemical-Engineering-and-Applied-Chemistry": year_fixture(
        PROGRAM_TITLES["chemical"], ["CHEM100H1"], ["CHEM101H1"], "CHEM200H1"
    ),
    "Materials-Science-and-Engineering": year_fixture(
        PROGRAM_TITLES["materials"], ["MSE100H1"], ["MSE101H1"], "MSE200H1"
    ),
    "Civil-Engineering": year_fixture(
        PROGRAM_TITLES["civil"], ["CIV100H1"], ["CIV101H1"], "CIV200H1"
    ),
    "Mineral-Engineering": year_fixture(
        PROGRAM_TITLES["mineral"], ["MIN100H1"], ["MIN101H1"], "MIN200H1"
    ),
}


class CurriculumTests(unittest.TestCase):
    def mock_response(self, url, timeout=30):
        slug = url.rsplit("/", 1)[-1]
        response = Mock()
        response.text = FIXTURES[slug]
        return response

    def test_registry_contains_all_requested_programs(self):
        expected = {
            "computer",
            "electrical",
            "mechanical",
            "industrial",
            "chemical",
            "materials",
            "civil",
            "mineral",
            "trackone",
        }
        self.assertTrue(expected.issubset(set(curriculum.PROGRAM_IDS)))
        for program in expected:
            self.assertIn(program, curriculum.PROGRAM_SLUG)

    @patch("curriculum.requests.get")
    def test_all_programs_extract_first_year_fall_and_winter(self, get):
        get.side_effect = self.mock_response
        expected_by_program = {
            "computer": ({"ECE100H1"}, {"ECE101H1"}),
            "electrical": ({"ECE100H1"}, {"ECE101H1"}),
            "mechanical": ({"MECH100H1"}, {"MECH101H1"}),
            "industrial": ({"INDU100H1"}, {"INDU101H1"}),
            "chemical": ({"CHEM100H1"}, {"CHEM101H1"}),
            "materials": ({"MSE100H1"}, {"MSE101H1"}),
            "civil": ({"CIV100H1"}, {"CIV101H1"}),
            "mineral": ({"MIN100H1"}, {"MIN101H1"}),
        }
        for program, (fall, winter) in expected_by_program.items():
            with self.subTest(program=program):
                result = curriculum.get_program_courses(program, "1")
                self.assertEqual(set(result["fall"]), fall)
                self.assertEqual(set(result["winter"]), winter)

    @patch("curriculum.requests.get")
    def test_trackone_matches_shared_ece_first_year(self, get):
        get.side_effect = self.mock_response
        self.assertEqual(
            curriculum.get_program_courses("trackone", "1"),
            curriculum.get_program_courses("computer", "1"),
        )

    @patch("curriculum.requests.get")
    def test_year_block_excludes_later_year_and_substitution_courses(self, get):
        get.side_effect = self.mock_response
        result = curriculum.get_program_courses("mechanical", "1")
        extracted = set(result["fall"] + result["winter"])
        self.assertNotIn("MECH200H1", extracted)
        self.assertNotIn("SUB999H1", extracted)
        self.assertNotIn("SUB998H1", extracted)

    @patch("curriculum.requests.get")
    def test_ece_second_year_tracks_remain_distinct(self, get):
        get.side_effect = self.mock_response
        computer = curriculum.get_program_courses("computer", "2")
        electrical = curriculum.get_program_courses("electrical", "2")
        self.assertEqual(computer["fall"], ["ECE200H1"])
        self.assertEqual(electrical["fall"], ["ECE201H1"])

    @patch("curriculum.requests.get")
    def test_legacy_track_argument_still_selects_ece_track(self, get):
        get.side_effect = self.mock_response
        result = curriculum.get_program_courses(
            "computer", "2", track="electrical"
        )
        self.assertEqual(result["fall"], ["ECE201H1"])

    def test_invalid_program_and_trackone_year_fail_clearly(self):
        with self.assertRaisesRegex(ValueError, "Unknown program"):
            curriculum.program_source("not-a-program")
        with self.assertRaisesRegex(ValueError, "only supported for year 1"):
            curriculum.get_program_courses("trackone", "2")

    @patch("curriculum.requests.get")
    def test_calendar_http_errors_are_not_treated_as_empty_curricula(self, get):
        response = Mock()
        response.raise_for_status.side_effect = RuntimeError("calendar unavailable")
        get.return_value = response
        with self.assertRaisesRegex(RuntimeError, "calendar unavailable"):
            curriculum.get_program_courses("mechanical", "1")
        response.raise_for_status.assert_called_once()


if __name__ == "__main__":
    unittest.main()
