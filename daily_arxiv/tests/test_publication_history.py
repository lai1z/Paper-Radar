import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ai"))
sys.path.insert(0, str(ROOT / "daily_arxiv" / "daily_arxiv"))
from check_stats import perform_deduplication
from checkpoint import process_with_checkpoint
from paper_history import canonical_id, is_successful, read_records, write_records
from publish_daily import merge_publication, prepare_publication


def paper(number=1, status="success", title="研究标题", summary="original abstract"):
    row = {"id": f"2610.{number:05d}", "title": title, "summary": summary, "categories": ["cs.RO"]}
    if status is not None:
        row["AI_status"] = status
    if status != "raw":
        row["AI"] = {key: "有依据的总结" for key in ("tldr", "motivation", "method", "result", "conclusion")}
    return row


class PublicationHistoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.history = self.root / "history"
        self.history.mkdir()
        self.current = self.root / "run" / "2026-11-02.jsonl"
        self.output = self.current.with_name("2026-11-02_AI_enhanced_Chinese.jsonl")

    def tearDown(self):
        self.directory.cleanup()

    def dedup(self, rows):
        write_records(self.current, rows)
        status = perform_deduplication(self.current, self.history, "2026-11-02")
        return status, read_records(self.current)

    def test_only_successful_enhanced_history_deduplicates(self):
        write_records(self.history / "2026-11-01_AI_enhanced_Chinese.jsonl", [paper(1), paper(2, "raw"), paper(3, "failed")])
        write_records(self.history / "2026-11-01.jsonl", [paper(4)])
        status, kept = self.dedup([paper(i) for i in range(1, 5)])
        self.assertEqual(status, "has_new_content")
        self.assertEqual([row["id"] for row in kept], [paper(i)["id"] for i in (2, 3, 4)])

    def test_repeated_day_is_empty_and_does_not_delete_history(self):
        old = self.history / "2026-10-01_AI_enhanced_Chinese.jsonl"
        write_records(old, [paper()])
        status, kept = self.dedup([paper()])
        self.assertEqual((status, kept), ("no_new_content", []))
        self.assertEqual(self.current.read_bytes(), b"")
        self.assertEqual(read_records(old), [paper()])

    def test_changed_title_or_abstract_is_not_suppressed(self):
        write_records(self.history / "2026-11-01_AI_enhanced_Chinese.jsonl", [paper(1), paper(2)])
        _, kept = self.dedup([paper(1, title="Updated method"), paper(2, summary="new experiment")])
        self.assertEqual(len(kept), 2)

    def test_first_run_and_future_history(self):
        self.assertEqual(self.dedup([paper()])[1], [paper()])
        write_records(self.history / "2026-11-03_AI_enhanced_Chinese.jsonl", [paper()])
        self.assertEqual(self.dedup([paper()])[1], [paper()])

    def test_corrupt_history_stops_without_modifying_input(self):
        (self.history / "2026-11-01_AI_enhanced_Chinese.jsonl").write_text("{broken", encoding="utf-8")
        status, kept = self.dedup([paper()])
        self.assertEqual(status, "error")
        self.assertEqual(kept, [paper()])

    def test_legacy_status_and_id_normalization(self):
        self.assertTrue(is_successful(paper(status=None)))
        self.assertFalse(is_successful(paper(status="failed")))
        placeholder = paper()
        placeholder["AI"]["tldr"] = "AI summary unavailable; retry pending."
        self.assertFalse(is_successful(placeholder))
        self.assertEqual(canonical_id({"id": "https://arxiv.org/pdf/2610.00001v2.pdf"}), "2610.00001")
        write_records(self.history / "2026-11-01_AI_enhanced_Chinese.jsonl", [paper(status=None)])
        same = paper()
        same["id"] += "v2"
        same["summary"] = " original   abstract\n"
        self.assertEqual(self.dedup([same])[1], [])

    def test_same_day_rerun_preserves_existing_successes(self):
        old_path = self.history / self.output.name
        write_records(old_path, [paper(1)])
        write_records(self.output, [])
        self.assertEqual(prepare_publication(self.output, self.history), (False, 1))
        self.assertFalse(self.output.exists())
        self.assertEqual(read_records(old_path), [paper(1)])
        write_records(self.output, [paper(1, "failed"), paper(2)])
        self.assertEqual(prepare_publication(self.output, self.history), (True, 2))
        self.assertEqual(read_records(self.output), [paper(1), paper(2)])
        self.assertEqual(len(read_records(self.current)), 2)
        self.assertTrue(all("AI" not in row for row in read_records(self.current)))

    def test_no_empty_publication_or_raw_failed_entries(self):
        write_records(self.output, [paper(1, "raw"), paper(2, "failed")])
        self.assertEqual(prepare_publication(self.output, self.history), (False, 0))
        self.assertFalse(self.output.exists())

    def test_daily_cap_and_non_destructive_legacy_days(self):
        original = [paper(i) for i in range(49)]
        snapshot = copy.deepcopy(original)
        merged = merge_publication(original, [paper(i) for i in range(48, 55)])
        self.assertEqual(len(merged), 50)
        self.assertEqual(original, snapshot)
        self.assertEqual(len(merge_publication([paper(i) for i in range(60)], [paper(70)])), 60)

    def test_no_new_candidates_does_not_prevent_pending_retry(self):
        write_records(self.history / "2026-11-01_AI_enhanced_Chinese.jsonl", [paper(1)])
        self.assertEqual(self.dedup([paper(1)])[0], "no_new_content")
        checkpoint = self.root / "checkpoints"
        def fail(row):
            raise ValueError("temporarily unavailable")
        process_with_checkpoint([paper(2)], fail, checkpoint, "sig", attempts=1)
        result = process_with_checkpoint(read_records(self.current), lambda row: paper(2), checkpoint, "sig", max_items=50)
        write_records(self.output, result)
        self.assertEqual(prepare_publication(self.output, self.history), (True, 1))
        self.assertEqual(read_records(self.output)[0]["id"], paper(2)["id"])


if __name__ == "__main__":
    unittest.main()
