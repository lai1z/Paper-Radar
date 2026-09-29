import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daily_arxiv.interest_filter import InterestFilter, term_matches


PAPER = {
    "title": "HappyWorld: Evaluating Interactive World Models",
    "summary": "We study embodied agents and spatial scene generation.",
    "authors": ["Ada Lovelace"],
    "categories": ["cs.CV"],
    "comment": "Project page available",
}


class InterestFilterTests(unittest.TestCase):
    def test_matches_abstract_not_only_title(self):
        matcher = InterestFilter({"enabled": True, "keywords": ["embodied agent"]})
        self.assertTrue(matcher.match(PAPER).matched)

    def test_alias_group_matches(self):
        matcher = InterestFilter({"enabled": True, "keywords": ["vision language action | VLA"]})
        paper = {**PAPER, "summary": "A VLA policy controls a robot."}
        self.assertTrue(matcher.match(paper).matched)

    def test_fuzzy_typo_matches_long_word(self):
        self.assertTrue(term_matches("transformer", ["transfomer architecture"], 0.84))

    def test_unrelated_paper_is_rejected(self):
        matcher = InterestFilter({"enabled": True, "keywords": ["protein folding"]})
        self.assertFalse(matcher.match(PAPER).matched)

    def test_enabled_empty_filter_is_an_error(self):
        with self.assertRaises(ValueError):
            InterestFilter({"enabled": True, "keywords": [], "authors": []})

    def test_loads_json_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "filter.json"
            path.write_text(json.dumps({"enabled": True, "authors": ["Ada Lovelace"]}), encoding="utf-8")
            self.assertTrue(InterestFilter.from_file(path).match(PAPER).matched)


if __name__ == "__main__":
    unittest.main()
