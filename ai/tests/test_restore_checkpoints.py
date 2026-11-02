import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from restore_checkpoints import merge_states, restore


def paper(number):
    return {"id": f"2610.{number:05d}", "title": "title", "summary": "abstract",
            "AI_status": "success", "AI": {key: "valid" for key in ("tldr", "motivation", "method", "result", "conclusion")}}


class RestoreTests(unittest.TestCase):
    def test_stale_cache_cannot_erase_success_and_failed_run_progress_survives(self):
        a, b, c = (paper(i) for i in range(3))
        merged = merge_states({"success": {"a": a}, "pending": {b["id"]: b}},
                              {"success": {"b": b}, "pending": {a["id"]: a, c["id"]: c}})
        self.assertEqual(set(merged["success"]), {"a", "b"})
        self.assertEqual(list(merged["pending"]), [c["id"]])

    def test_changed_content_remains_pending(self):
        a = paper(1)
        changed = {**a, "summary": "new results"}
        merged = merge_states({"success": {"a": a}, "pending": {}},
                              {"success": {}, "pending": {a["id"]: changed}})
        self.assertEqual(merged["pending"][a["id"]], changed)

    def test_corrupt_cache_recovers_from_durable_and_invalid_both_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            durable, cache = Path(directory) / "durable", Path(directory) / "cache"
            durable.mkdir()
            cache.mkdir()
            state = {"success": {"a": paper(1)}, "pending": {}}
            (durable / "sig.json").write_text(json.dumps(state), encoding="utf-8")
            (cache / "sig.json").write_text("broken", encoding="utf-8")
            restore(durable, cache)
            self.assertEqual(json.loads((cache / "sig.json").read_text()), state)
            (cache / "bad.json").write_text("broken", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "No valid checkpoint"):
                restore(durable, cache)


if __name__ == "__main__":
    unittest.main()
