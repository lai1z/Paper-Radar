import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from checkpoint import atomic_write, checkpoint_key, process_with_checkpoint, FIELDS
from digest import grounded_digest, migrate_pending, defer_items, numeric_values, supported_result
from structure import Structure
from paper_history import fingerprint


class DigestTests(unittest.TestCase):
    def test_numeric_claims_must_exist_in_their_evidence(self):
        abstract = 'Our robot is evaluated in 20 tasks. Success improves by 38% over the baseline.'
        quote = 'Success improves by 38% over the baseline.'
        result = {'finding': '成功率提升 38%', 'setting': '20 项任务', 'evidence_quote': quote}
        self.assertTrue(supported_result(result, abstract))
        self.assertFalse(supported_result({**result, 'finding': '成功率提升 83%'}, abstract))
        self.assertFalse(supported_result({**result, 'finding': '成功率变化 −38%'}, abstract))
        self.assertFalse(supported_result({**result, 'setting': '200 项任务'}, abstract))
        # A true number elsewhere in the abstract is insufficient for a result
        # whose selected evidence excerpt does not contain that number.
        self.assertFalse(supported_result({**result, 'finding': '成功率提升 20%'}, abstract))
        self.assertFalse(supported_result({**result, 'finding': ''}, abstract))
        self.assertFalse(supported_result({'finding': 'ok', 'evidence_quote': None}, abstract))
        self.assertFalse(supported_result(None, abstract))

    def test_numbers_do_not_misread_model_names_and_normalize_formatting(self):
        self.assertEqual(numeric_values('GPT-4o / V-JEPA2 / GPT-4 / 3D'), set())
        self.assertEqual(numeric_values('1,000 tasks; 38.0%; 50ms; 2x'), numeric_values('1000任务、38%、50 ms、2 倍'))
        quote = 'Our method evaluates 1,000 tasks with 38.0% success.'
        self.assertTrue(supported_result({'finding': '1000项任务成功率38%', 'setting': '', 'evidence_quote': quote}, quote))

    def test_refresh_pending_never_migrates_into_new_daily_work(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            refresh = {'success': {}, 'pending': {'2611.12345': {'id': '2611.12345'}}}
            atomic_write(directory / 'refresh-2026-11-02-old.json', refresh)
            migrate_pending(directory, 'new-daily-signature')
            self.assertFalse((directory / 'new-daily-signature.json').exists())
            self.assertEqual(json.loads((directory / 'refresh-2026-11-02-old.json').read_text()), refresh)

    def test_legacy_shape_and_bounded_new_fields(self):
        legacy = Structure(**{key: '旧摘要' for key in FIELDS})
        self.assertEqual(legacy.key_results, [])
        self.assertEqual(legacy.research_topics, [])
        with self.assertRaises(ValueError):
            Structure(**legacy.model_dump(exclude={'research_topics'}), research_topics=['unrecognized'])
        with self.assertRaises(ValueError):
            Structure(**legacy.model_dump(exclude={'limitations'}), limitations=['x'] * 4)

    def test_only_verbatim_abstract_excerpts_are_exposed(self):
        abstract = 'On robot manipulation, our method reduces latency by 38% on the stated benchmark.'
        digest = grounded_digest({'key_results': [
            {'finding': '延迟降低 38%', 'setting': 'robot manipulation', 'evidence_quote': 'reduces latency by 38%'},
            {'finding': '快十倍', 'setting': 'unknown', 'evidence_quote': 'ten times faster'},
            {'finding': 'unsupported', 'setting': '', 'evidence_quote': '38%'},
        ], 'limitations': ['摘要未报告硬件']}, abstract)
        self.assertEqual(len(digest['key_results']), 1)
        self.assertEqual(digest['key_results'][0]['finding'], '延迟降低 38%')
        self.assertEqual(digest['source'], 'abstract')
        self.assertEqual(digest['digest_version'], 2)
        self.assertIn('未附可定位', digest['limitations'][-1])

    def test_pending_migration_preserves_success_and_destination_priority(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            old = {'success': {'cached': {'AI': 'preserve exactly'}},
                   'pending': {'2611.12345': {'id': '2611.12345', 'summary': 'older'}}}
            active = {'success': {}, 'pending': {'2611.12345': {'id': '2611.12345', 'summary': 'newer'}}}
            atomic_write(directory / 'old.json', old)
            atomic_write(directory / 'active.json', active)
            migrate_pending(directory, 'active')
            self.assertEqual(json.loads((directory / 'old.json').read_text())['success'], old['success'])
            self.assertEqual(json.loads((directory / 'old.json').read_text())['pending'], {})
            self.assertEqual(json.loads((directory / 'active.json').read_text())['pending'], active['pending'])
            migrate_pending(directory, 'active')
            self.assertEqual(json.loads((directory / 'active.json').read_text())['pending'], active['pending'])

    def test_interrupted_migration_keeps_recoverable_pending(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            state = {'success': {}, 'pending': {'2611.12345': {'id': '2611.12345'}}}
            atomic_write(directory / 'old.json', state)
            def fail_when_clearing(path, value):
                if Path(path).name == 'old.json':
                    raise OSError('simulated interruption')
                atomic_write(path, value)
            with patch('digest.atomic_write', side_effect=fail_when_clearing):
                with self.assertRaises(OSError):
                    migrate_pending(directory, 'new')
            self.assertEqual(json.loads((directory / 'new.json').read_text())['pending'], state['pending'])
            migrate_pending(directory, 'new')
            self.assertEqual(json.loads((directory / 'old.json').read_text())['pending'], {})

    def test_destination_success_is_not_requeued_and_title_changes_invalidate_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            paper = {'id': '2611.12345', 'title': 'old', 'summary': 'same'}
            atomic_write(directory / 'old.json', {'success': {}, 'pending': {paper['id']: paper}})
            atomic_write(directory / 'new.json', {'success': {checkpoint_key(paper): paper}, 'pending': {}})
            migrate_pending(directory, 'new')
            self.assertEqual(json.loads((directory / 'new.json').read_text())['pending'], {})
            self.assertNotEqual(checkpoint_key(paper), checkpoint_key({**paper, 'title': 'updated'}))

    def test_completed_exclusion_and_failed_priority_share_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            atomic_write(Path(directory) / 's.json', {'success': {}, 'pending': {
                '2611.00001': {'id': '2611.00001'},
                '2611.00002': {'id': '2611.00002'},
                '2611.00003': {'id': '2611.00003'},
            }})
            processor = Mock(side_effect=lambda p: {**p, 'AI': {key: 'valid' for key in FIELDS}})
            result = process_with_checkpoint([], processor, directory, 's', max_items=1,
                                             exclude_ids={'2611.00001'}, priority_ids={'2611.00003'})
            self.assertEqual([p['id'] for p in result], ['2611.00003'])
            self.assertEqual(processor.call_count, 1)
            self.assertEqual(set(json.loads((Path(directory) / 's.json').read_text())['pending']), {'2611.00002'})

    def test_title_is_passed_to_model_and_full_budget_does_not_construct_model(self):
        import enhance
        response = Structure(**{key: 'valid' for key in FIELDS})
        chain = Mock()
        chain.invoke.return_value = response
        paper = {'id': '2611.12345', 'title': 'Robot learning', 'summary': 'Abstract without network links.'}
        with patch.object(enhance, 'is_sensitive', return_value=False):
            result = enhance.process_single_item(chain, paper, 'Chinese')
        self.assertEqual(chain.invoke.call_args.args[0]['title'], 'Robot learning')
        self.assertEqual(result['AI']['source'], 'abstract')
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / 'ai'
            script.mkdir()
            (script / 'structure.py').write_text('schema', encoding='utf-8')
            with patch.object(enhance, 'SCRIPT_DIR', script), patch.object(enhance, 'ChatOpenAI') as llm:
                self.assertEqual(enhance.process_all_items([paper], 'test', 'Chinese', 1, max_papers=0), [])
                updated = {**paper, 'title': 'Updated robot learning'}
                self.assertEqual(enhance.process_all_items([updated], 'test', 'Chinese', 1, max_papers=0,
                    exclude_ids={paper['id']}, published_fingerprints={paper['id']: fingerprint(paper)}), [])
                llm.assert_not_called()
            checkpoints = list((Path(directory) / '.ai-checkpoints').glob('*.json'))
            self.assertEqual(len(checkpoints), 1)
            self.assertIn(paper['id'], json.loads(checkpoints[0].read_text())['pending'])
            self.assertEqual(json.loads(checkpoints[0].read_text())['pending'][paper['id']]['title'], updated['title'])

    def test_same_day_update_is_deferred_then_resumes_without_new_feed(self):
        with tempfile.TemporaryDirectory() as directory:
            item = {'id': '2611.12345', 'title': 'New title', 'summary': 'New abstract'}
            processor = Mock(side_effect=lambda p: {**p, 'AI': {key: 'valid' for key in FIELDS}})
            output = process_with_checkpoint([item], processor, directory, 's', max_items=50,
                                             exclude_ids={item['id']}, defer_ids={item['id']})
            self.assertEqual(output, [])
            processor.assert_not_called()
            self.assertEqual(json.loads((Path(directory) / 's.json').read_text())['pending'][item['id']], item)
            output = process_with_checkpoint([], processor, directory, 's', max_items=50)
            self.assertEqual([p['title'] for p in output], ['New title'])
            self.assertEqual(processor.call_count, 1)


if __name__ == '__main__':
    unittest.main()
