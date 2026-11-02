import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import screen


class DailyBudgetTests(unittest.TestCase):
    def run_gate(self, values):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / 'papers.jsonl'
            audit = Path(directory) / 'scores.jsonl'
            data.write_text(''.join(json.dumps({'id': str(i), 'title': 'paper', 'summary': 'abstract', 'skip_ai': True}) + '\n'
                                    for i in range(len(values))), encoding='utf-8')
            def score(item, *args):
                value = values[int(item['id'])]
                return value, 'error:unavailable' if value is None else 'ok:1:0'
            args = ['screen.py', '--data', str(data), '--scores-out', str(audit), '--max-papers', '50', '--workers', '1']
            with patch.dict(os.environ, {'JEV_API_KEY': 'test-only'}), patch.object(sys, 'argv', args), patch.object(screen, 'ask_jev', side_effect=score):
                self.assertEqual(screen.main(), 0)
            return ([json.loads(line) for line in data.read_text(encoding='utf-8').splitlines()],
                    [json.loads(line) for line in audit.read_text(encoding='utf-8').splitlines()])

    def test_top_50_without_raw_tail(self):
        kept, audit = self.run_gate([0.4] * 30 + [0.8] * 60 + [0.99])
        self.assertEqual(len(kept), 50)
        self.assertEqual(kept[0]['id'], '90')
        self.assertFalse(any(row.get('skip_ai') for row in kept))
        self.assertFalse(any(row['screen'] == 'tail' for row in audit))

    def test_screen_failures_share_the_cap_and_are_audited(self):
        kept, audit = self.run_gate([0.9] * 45 + [None] * 20)
        self.assertEqual(len(kept), 50)
        self.assertEqual(sum(row['screen'] == 'fail_open' for row in audit), 5)
        self.assertEqual(sum(row['screen'] == 'over_daily_limit' for row in audit), 15)

    def test_complete_outage_stays_within_budget(self):
        kept, _ = self.run_gate([None] * 80)
        self.assertEqual(len(kept), 50)

    def test_no_relevant_papers_does_not_restore_all_candidates(self):
        kept, _ = self.run_gate([0.1] * 100)
        self.assertEqual(kept, [])

    def test_missing_key_stops_before_summarization(self):
        with patch.dict(os.environ, {'JEV_API_KEY': '', 'OPENAI_API_KEY': ''}), patch.object(sys, 'argv', ['screen.py', '--data', 'unused.jsonl']):
            with self.assertRaisesRegex(RuntimeError, 'JEV_API_KEY'):
                screen.main()


if __name__ == '__main__':
    unittest.main()
