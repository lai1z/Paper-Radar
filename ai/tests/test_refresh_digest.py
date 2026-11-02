import json
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from refresh_digest import select_existing, merge_refreshed, refresh
from run_report import build_report
from paper_history import write_records
from checkpoint import atomic_write


def paper(index=1):
    return {"id": f"2611.{index:05d}", "title": "Original 中文 title", "authors": ["王某", "A. B."],
            "summary": "Original abstract with 80% accuracy.", "published": "2026-10-30",
            "categories": ["cs.RO"], "AI_status": "success",
            "AI": {field: "Old digest" for field in ("tldr", "motivation", "method", "result", "conclusion")}}


class RefreshTests(unittest.TestCase):
    def test_only_existing_successes_at_most_fifty_unique_ids(self):
        rows = [paper(i) for i in range(1, 61)]
        rows.insert(1, {**paper(), "id": "2611.00001v2"})
        rows.insert(0, {**paper(70), "AI_status": "raw"})
        self.assertEqual(len(select_existing(rows)), 50)
        self.assertEqual(select_existing(rows)[-1]["id"], "2611.00050")

    def test_only_analysis_changes_and_failure_keeps_original(self):
        original = [paper(1), paper(2)]
        before = deepcopy(original)
        updated = {**paper(1), "authors": [],
                   "published": "2099-01-01", "AI": {key: "New analysis" for key in paper()["AI"]}}
        result = merge_refreshed(original, [updated, {**paper(2), "AI_status": "failed"}, paper(3)])
        self.assertEqual(original, before)
        self.assertEqual(result[1], original[1])
        self.assertEqual(len(result), 2)
        for key in original[0]:
            if key not in ("AI", "AI_status"):
                self.assertEqual(result[0][key], original[0][key])
        self.assertEqual(result[0]["AI"]["tldr"], "New analysis")
        self.assertEqual(merge_refreshed(original, [{**updated, "summary": "Different source"}]), original)

    def test_retry_reuses_completed_refresh_and_retains_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            processor = Mock(side_effect=lambda p: {**p, "AI": {key: "New analysis" for key in paper()["AI"]}})
            result, count = refresh([paper()], processor, directory, "refresh-date-version", workers=1)
            self.assertEqual(count, 1)
            result2, count2 = refresh([paper()], processor, directory, "refresh-date-version", workers=1)
            self.assertEqual(result, result2)
            self.assertEqual(count2, 1)
            self.assertEqual(processor.call_count, 1)

    def test_status_does_not_advertise_unpublished_temp_file(self):
        with tempfile.TemporaryDirectory() as directory:
            history, current = Path(directory) / "history", Path(directory) / "current"
            write_records(history / "2026-11-01_AI_enhanced_Chinese.jsonl", [paper()])
            write_records(current / "2026-11-02_AI_enhanced_Chinese.jsonl", [paper(), paper(2)])
            status = build_report(history, current, "Chinese", False, 400, "daily", "https://example.com/run")
            self.assertEqual(status["latest_publication_date"], "2026-11-01")
            self.assertEqual(status["latest_paper_count"], 1)
            status = build_report(history, current, "Chinese", True, 400, "refresh", "https://example.com/run")
            self.assertEqual(status["latest_publication_date"], "2026-11-02")
            self.assertEqual(status["latest_paper_count"], 2)

    def test_stale_pending_never_uses_refresh_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            stale = [paper(i) for i in range(51, 102)]
            atomic_write(Path(directory) / 'refresh-sig.json', {
                'success': {}, 'pending': {row['id']: row for row in stale}})
            processor = Mock(side_effect=lambda p: {**p, 'AI': paper()['AI']})
            results, count = refresh([paper(1)], processor, directory, 'refresh-sig', workers=1)
            self.assertEqual(count, 1)
            self.assertEqual(processor.call_args.args[0]['id'], paper(1)['id'])
            self.assertEqual(len(results), 1)


if __name__ == "__main__":
    unittest.main()
