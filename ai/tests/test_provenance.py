import json
from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from checkpoint import FIELDS, process_with_checkpoint
from provenance import assert_source_preserved, preserve_source, source_metadata


class SourcePreservationTests(unittest.TestCase):
    def paper(self):
        return {
            'id': '2611.12345v2', 'title': '具身世界模型：作者原始标题',
            'summary': 'Original abstract with 38% improvement.',
            'authors': ['张三', 'Jane Doe'], 'published': '2026-11-01',
            'updated': '2026-11-02', 'abs': 'https://arxiv.org/abs/2611.12345v2',
            'categories': ['cs.RO', 'cs.AI'], 'custom_source_field': {'values': [1, 2]},
        }

    def test_generated_output_cannot_change_or_invent_source_metadata(self):
        source = self.paper()
        original = deepcopy(source)
        invented = {'id': 'wrong', 'title': 'invented', 'authors': ['Model'],
                    'published': '2030-01-01', 'doi': 'invented',
                    'AI': {field: 'valid' for field in FIELDS}}
        result = preserve_source(source, invented)
        self.assertEqual(source_metadata(result), source)
        self.assertNotIn('doi', result)
        result['authors'].append('later mutation')
        self.assertEqual(source, original)
        with self.assertRaises(ValueError):
            assert_source_preserved(source, result)

    def test_cache_reuses_digest_but_updates_current_metadata_without_request(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.paper()
            processor = Mock(side_effect=lambda paper: {**paper, 'AI': {field: 'valid' for field in FIELDS}})
            process_with_checkpoint([source], processor, directory, 'sig')
            updated = {**source, 'authors': ['张三', 'Corrected Author'], 'published': '2026-10-31'}
            result = process_with_checkpoint([updated], processor, directory, 'sig')[0]
            self.assertEqual(processor.call_count, 1)
            assert_source_preserved(updated, result)
            saved = json.loads((Path(directory) / 'sig.json').read_text(encoding='utf-8'))
            self.assertEqual(next(iter(saved['success'].values()))['authors'], updated['authors'])

    def test_nested_source_is_immutable_across_retry_and_success(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.paper()
            original = deepcopy(source)
            calls = []
            def processor(paper):
                calls.append(deepcopy(paper['authors']))
                paper['authors'].append('untrusted')
                paper['custom_source_field']['values'].clear()
                if len(calls) == 1:
                    raise ValueError('retry')
                paper['title'] = 'invented'
                paper['doi'] = 'invented'
                paper['AI'] = {field: 'valid' for field in FIELDS}
                return paper
            output = process_with_checkpoint([source], processor, directory, 'sig', sleep=lambda _: None)
            self.assertEqual(calls, [original['authors'], original['authors']])
            self.assertEqual(source, original)
            assert_source_preserved(source, output[0])

    def test_direct_enhancement_preserves_chinese_and_missing_fields(self):
        import enhance
        from structure import Structure
        source = self.paper()
        original = deepcopy(source)
        chain = Mock()
        chain.invoke.return_value = Structure(**{field: '有效摘要' for field in FIELDS})
        with patch.object(enhance, 'is_sensitive', return_value=False):
            output = enhance.process_single_item(chain, source, 'Chinese')
        self.assertEqual(source, original)
        assert_source_preserved(source, output)
        self.assertNotIn('doi', output)

    def test_github_suffix_trimming_preserves_repository_name(self):
        import enhance
        from structure import Structure
        chain = Mock()
        chain.invoke.return_value = Structure(**{field: 'valid' for field in FIELDS})
        source = {**self.paper(), 'summary': 'Code: https://github.com/example/robot-digit.git.'}
        with patch.object(enhance, 'is_sensitive', return_value=False), \
             patch.object(enhance.requests, 'get', return_value=Mock(status_code=404)):
            output = enhance.process_single_item(chain, source, 'Chinese')
        self.assertEqual(output['code_url'], 'https://github.com/example/robot-digit')


if __name__ == '__main__':
    unittest.main()
