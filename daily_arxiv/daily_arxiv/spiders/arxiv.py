import scrapy
import os
import re

from daily_arxiv.interest_filter import InterestFilter


class ArxivSpider(scrapy.Spider):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        categories = os.environ.get("CATEGORIES", "cs.CV")
        categories = categories.split(",")
        # 保存目标分类列表，用于后续验证
        self.target_categories = set(map(str.strip, categories))
        self.start_urls = [
            f"https://arxiv.org/list/{cat}/new" for cat in self.target_categories
        ]  # 起始URL（计算机科学领域的最新论文）
        config_path = os.environ.get("INTEREST_FILTER_CONFIG", "../config/interest-filter.json")
        self.interest_filter = InterestFilter.from_file(config_path)
        self.seen_ids = set()
        self.candidate_count = 0
        self.matched_count = 0

    name = "arxiv"  # 爬虫名称
    allowed_domains = ["arxiv.org"]  # 允许爬取的域名

    def parse(self, response):
        # 提取每篇论文的信息
        anchors = []
        for li in response.css("div[id=dlpage] ul li"):
            href = li.css("a::attr(href)").get()
            if href and "item" in href:
                anchors.append(int(href.split("item")[-1]))

        replacement_start = anchors[-1] if anchors else None

        # Each arXiv list page already contains all metadata needed for filtering.
        # Parsing it here avoids one API request per paper and the resulting 429s.
        for paper in response.css("dl dt"):
            paper_anchor = paper.css("a[name^='item']::attr(name)").get()
            if not paper_anchor:
                continue
                
            paper_id = int(paper_anchor.split("item")[-1])
            if replacement_start is not None and paper_id >= replacement_start:
                continue

            # 获取论文ID
            abstract_link = paper.css("a[title='Abstract']::attr(href)").get()
            if not abstract_link:
                continue
                
            arxiv_id = abstract_link.split("/")[-1]
            if arxiv_id in self.seen_ids:
                continue
            self.seen_ids.add(arxiv_id)
            
            # 获取对应的论文描述部分 (dd元素)
            paper_dd = paper.xpath("following-sibling::dd[1]")
            if not paper_dd:
                continue
            
            def clean(selector):
                return " ".join(part.strip() for part in selector.xpath(".//text()").getall() if part.strip())

            subjects_text = clean(paper_dd.css(".list-subjects"))
            categories = re.findall(r"\(([a-z-]+\.[A-Za-z-]+)\)", subjects_text)
            item = {
                "id": arxiv_id,
                "authors": [clean(author) for author in paper_dd.css(".list-authors a")],
                "title": re.sub(r"^Title:\s*", "", clean(paper_dd.css(".list-title"))),
                "categories": list(dict.fromkeys(categories)),
                "comment": re.sub(r"^Comments:\s*", "", clean(paper_dd.css(".list-comments"))) or None,
                "summary": clean(paper_dd.css("p.mathjax")),
            }
            self.candidate_count += 1
            result = self.interest_filter.match(item)
            if not result.matched:
                continue
            item["filter_match"] = {
                "keywords": list(result.keywords),
                "authors": list(result.authors),
            }
            self.matched_count += 1
            yield item

    def closed(self, reason):
        self.logger.info(
            "Interest filter: %d/%d unique papers matched (enabled=%s)",
            self.matched_count,
            self.candidate_count,
            self.interest_filter.enabled,
        )
