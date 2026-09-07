import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "web" / "index.html"
MANIFEST = ROOT / "web" / "data" / "manifest.json"
DATA_DIR = MANIFEST.parent
REQUESTED_PROGRAMS = {
    "computer",
    "mechanical",
    "industrial",
    "chemical",
    "materials",
    "civil",
    "mineral",
    "trackone",
    "electrical",
}
SECOND_YEAR_PROGRAMS = {
    "computer",
    "electrical",
    "mechanical",
    "industrial",
    "chemical",
    "materials",
    "civil",
    "mineral",
}


class FrontendCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = INDEX.read_text(encoding="utf-8")
        cls.manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    def test_program_selector_contains_all_requested_labels(self):
        for program in REQUESTED_PROGRAMS:
            with self.subTest(program=program):
                self.assertRegex(
                    self.html,
                    rf'<option value="{re.escape(program)}"[^>]*>',
                )

    def test_manifest_has_both_first_year_semesters_for_each_program(self):
        combos = {
            (item["program"], item["year"], item["session"])
            for item in self.manifest["combos"]
        }
        for program in REQUESTED_PROGRAMS:
            for semester in ("fall", "winter"):
                with self.subTest(program=program, semester=semester):
                    self.assertIn((program, "1", semester), combos)

    def test_manifest_has_both_second_year_semesters_for_each_supported_program(self):
        combos = {
            (item["program"], item["year"], item["session"])
            for item in self.manifest["combos"]
        }
        for program in SECOND_YEAR_PROGRAMS:
            for semester in ("fall", "winter"):
                with self.subTest(program=program, semester=semester):
                    key = (program, "2", semester)
                    self.assertIn(key, combos)
                    self.assertTrue(
                        (DATA_DIR / f"{program}-2-{semester}.json").exists(),
                        f"manifest entry must have a cache file: {key}",
                    )

        for semester in ("fall", "winter"):
            self.assertNotIn(("trackone", "2", semester), combos)

    def test_loader_uses_program_year_semester_cache_key(self):
        self.assertIn('return `data/${t}-${y}-${s}.json`;', self.html)
        self.assertIn('fetch("data/manifest.json"', self.html)
        self.assertIn("Manifest-backed availability", self.html)
        self.assertIn("Expected <code>${key}</code>", self.html)
        self.assertNotIn('fetch("courses.json")', self.html)

    def test_legacy_electrical_option_remains_available(self):
        self.assertIn('<option value="electrical">Electrical</option>', self.html)

    def test_shared_optimizer_loads_before_inline_ui_and_replaces_legacy_sampler(self):
        shared_tag = '<script src="optimizer.js"></script>'
        inline_tag = '<script>'
        self.assertIn(shared_tag, self.html)
        self.assertLess(self.html.index(shared_tag), self.html.index(inline_tag))
        self.assertIn('const OPTIMIZER = window.TimetableOptimizer;', self.html)
        self.assertIn('OPTIMIZER.groupCourses(data, { includeCombos: false });', self.html)
        self.assertIn('OPTIMIZER.buildCoursePlans(COURSES', self.html)
        self.assertRegex(
            self.html,
            r"OPTIMIZER\.findBestPlan\(request\.plans, request\.opts,",
        )
        self.assertNotIn('solveBest' + '(', self.html)
        self.assertNotIn('Math.random' + '()', self.html)
        self.assertNotIn('Date.now' + '()', self.html)
    def test_best_so_far_uses_canonical_complete_result_guards(self):
        self.assertIn("function bestSoFarInputKey(plans, opts)", self.html)
        self.assertIn("function canonicalLoadedCourses()", self.html)
        self.assertIn("function canonicalTutorialAttendance()", self.html)
        self.assertIn("function isCompleteOptimalPlanResult(result, opts, expectedPlans)", self.html)
        self.assertIn('result.complete !== true || result.optimal !== true ||', self.html)
        self.assertIn("OPTIMIZER.comparePlans(result.plan, bestSoFarResult.plan, opts) <= 0", self.html)
        self.assertRegex(
            self.html,
            r"renderPlan\(\s*plans,\s*bestSoFarResult\.plan",
        )
        self.assertNotIn("bestSoFarOpts", self.html)
        self.assertNotIn("bestSoFarPlans", self.html)


if __name__ == "__main__":
    unittest.main()
