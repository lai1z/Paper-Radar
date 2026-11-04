from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from crawl import validate_crawl
from daily_arxiv.spiders.arxiv import ArxivSpider
from scrapy.http import HtmlResponse


def entry(number, paper_id):
    return f'''<dt><a name="item{number}"></a><a title="Abstract" href="/abs/{paper_id}">arXiv</a></dt>
      <dd><div class="list-title">Title: Original title</div><div class="list-authors"><a>作者</a></div>
      <div class="list-subjects">Robotics (cs.RO)</div><p class="mathjax">Original abstract.</p></dd>'''


def page(body):
    return HtmlResponse(url="https://arxiv.org/list/cs.RO/new", body=f'<div id="dlpage">{body}</div>'.encode(), encoding="utf-8")


class CrawlCompletenessTests(unittest.TestCase):
    def spider(self):
        with patch.dict("os.environ", {"CATEGORIES": "cs.RO"}):
            return ArxivSpider()

    def test_cross_lists_are_kept_when_no_replacement_section_exists(self):
        spider = self.spider()
        response = page('<ul><li><a href="#item1">New submissions</a></li><li><a href="#item2">Cross-lists</a></li></ul>'
            '<h3>New submissions (showing 1 of 1 entries)</h3><h3>Cross submissions (showing 1 of 1 entries)</h3>'
            f'<dl>{entry(1, "2611.00001")}{entry(2, "2611.00002")}</dl>')
        self.assertEqual(len(list(spider.parse(response))), 2)
        self.assertEqual(spider.completed_categories, {"cs.RO"})

    def test_replacements_excluded_but_page_coverage_is_recorded(self):
        spider = self.spider()
        response = page('<ul><li><a href="#item2">Replacements</a></li></ul>'
            '<h3>New submissions (showing 1 of 1 entries)</h3>'
            f'<dl>{entry(1, "2611.00001")}{entry(2, "2611.00002")}</dl>')
        self.assertEqual([row["id"] for row in spider.parse(response)], ["2611.00001"])

    def test_legacy_cross_list_id_preserves_archive_prefix(self):
        response = page('<h3>Cross submissions (showing 1 of 1 entries)</h3><dl>' + entry(1, 'cs/0112017') + '</dl>')
        self.assertEqual([row['id'] for row in self.spider().parse(response)], ['cs/0112017'])

    def test_legitimate_empty_day_is_accepted(self):
        spider = self.spider()
        self.assertEqual(list(spider.parse(page('<h3>New submissions (showing 0 of 0 entries)</h3>'))), [])
        validate_crawl({"finish_reason": "finished"}, {"cs.RO"}, spider.completed_categories, 0, [])

    def test_bad_html_missing_metadata_or_truncated_listing_fails(self):
        cases = [page('<p>Service unavailable</p>'),
                 page('<dl>' + entry(1, '2611.00001') + '</dl>'),
                 page('<h3>New submissions (showing 1 of 2 entries)</h3>'),
                 page('<h3>New submissions (showing 1 of 1 entries)</h3><dl>' + entry(1, '2611.00001').replace('Original abstract.', '') + '</dl>'),
                 page('<h3>New submissions (showing 2 of 2 entries)</h3><dl>' + entry(1, '2611.00001') + '</dl>')]
        for response in cases:
            with self.subTest(body=response.text), self.assertRaises(ValueError):
                list(self.spider().parse(response))

    def test_http_failure_on_one_category_cannot_look_like_success(self):
        with self.assertRaisesRegex(ValueError, "category coverage"):
            validate_crawl({"finish_reason": "finished"}, {"cs.RO", "cs.AI"}, {"cs.RO"}, 0, [])
        with self.assertRaisesRegex(ValueError, "errors"):
            validate_crawl({"finish_reason": "finished", "spider_exceptions/ValueError": 1}, {"cs.RO"}, {"cs.RO"}, 0, [])
        with self.assertRaisesRegex(ValueError, "feed export"):
            validate_crawl({"finish_reason": "finished", "item_scraped_count": 1}, {"cs.RO"}, {"cs.RO"}, 1, [])
        with self.assertRaisesRegex(ValueError, "did not finish"):
            validate_crawl({"finish_reason": "shutdown"}, {"cs.RO"}, {"cs.RO"}, 0, [])


if __name__ == "__main__":
    unittest.main()
