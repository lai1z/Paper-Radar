import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from checkpoint import atomic_write, checkpoint_key, process_with_checkpoint
from paper_history import fingerprint
from recovery import prune_published_pending, unpublished_successes


def paper(number=1, summary="Original source abstract."):
    return {"id": f"2611.{number:05d}", "title": "Robot learning", "authors": ["原作者"], "summary": summary}


def success(row):
    return {**row, "AI_status": "success", "AI": {key: "valid" for key in
            ("tldr", "motivation", "method", "result", "conclusion")}}


class PublicationRecoveryTests(unittest.TestCase):
    def test_completed_but_unpublished_success_survives_next_feed_and_prompt(self):
        with tempfile.TemporaryDirectory() as directory:
            completed = success(paper())
            atomic_write(Path(directory) / "old-prompt.json", {
                "success": {checkpoint_key(completed): completed}, "pending": {}})
            self.assertEqual(unpublished_successes(directory, set()), [completed])
            self.assertEqual(unpublished_successes(directory, {fingerprint(completed)}), [])

    def test_stale_pending_is_pruned_by_all_day_history_but_new_source_survives(self):
        with tempfile.TemporaryDirectory() as directory:
            already_published, changed = paper(1), paper(2, "new abstract")
            atomic_write(Path(directory) / "old.json", {"success": {}, "pending": {
                already_published["id"]: already_published, changed["id"]: changed}})
            self.assertEqual(prune_published_pending(directory,
                {fingerprint(already_published), fingerprint(paper(2))}), 1)
            state = json.loads((Path(directory) / "old.json").read_text(encoding="utf-8"))
            self.assertEqual(state["pending"], {changed["id"]: changed})

    def test_refresh_state_never_becomes_a_new_daily_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            completed = success(paper())
            state = {"success": {checkpoint_key(completed): completed}, "pending": {completed["id"]: completed}}
            path = Path(directory) / "refresh-2026-11-01-sig.json"
            atomic_write(path, state)
            self.assertEqual(unpublished_successes(directory, set()), [])
            self.assertEqual(prune_published_pending(directory, {fingerprint(completed)}), 0)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), state)

    def test_current_source_overrides_stale_cache_and_missing_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            cached = success(paper())
            atomic_write(Path(directory) / "s.json", {"success": {checkpoint_key(cached): cached}, "pending": {}})
            self.assertEqual(unpublished_successes(directory, set(), [paper(summary="Changed source")]), [])
            current = {**paper(), "authors": ["Corrected Author"], "published": "2026-11-01"}
            recovered = unpublished_successes(directory, set(), [current])[0]
            self.assertEqual(recovered["authors"], current["authors"])
            self.assertEqual(recovered["published"], current["published"])

    def test_recovery_shares_daily_cap_and_does_not_construct_model_when_full(self):
        import enhance
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "ai"
            script.mkdir()
            (script / "structure.py").write_text("schema", encoding="utf-8")
            completed = [success(paper(i)) for i in range(1, 52)]
            checkpoint_dir = Path(directory) / ".ai-checkpoints"
            atomic_write(checkpoint_dir / "old.json", {"success": {
                checkpoint_key(row): row for row in completed}, "pending": {}})
            with patch.object(enhance, "SCRIPT_DIR", script), patch.object(enhance, "ChatOpenAI") as llm:
                recovered = enhance.process_all_items([paper(100)], "test", "Chinese", 1,
                    max_papers=50, history_fingerprints=set())
                self.assertEqual(len(recovered), 50)
                llm.assert_not_called()
                next_day = enhance.process_all_items([], "test", "Chinese", 1,
                    max_papers=1, history_fingerprints={fingerprint(row) for row in recovered})
                self.assertEqual([row["id"] for row in next_day], [paper(51)["id"]])
                llm.assert_not_called()
            pending = [row for path in checkpoint_dir.glob("*.json") for row in
                       json.loads(path.read_text(encoding="utf-8"))["pending"].values()]
            self.assertEqual([row["id"] for row in pending], [paper(100)["id"]])

    def test_malformed_success_cache_is_reprocessed(self):
        with tempfile.TemporaryDirectory() as directory:
            source = paper()
            invalid = {**source, "AI_status": "success", "AI": {"tldr": "partial"}}
            atomic_write(Path(directory) / "sig.json", {"success": {checkpoint_key(source): invalid}, "pending": {}})
            processor = Mock(side_effect=success)
            result = process_with_checkpoint([source], processor, directory, "sig")
            self.assertEqual(processor.call_count, 1)
            self.assertEqual(result[0], success(source))


if __name__ == "__main__":
    unittest.main()
