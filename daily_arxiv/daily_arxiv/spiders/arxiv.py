import scrapy
import os
import re
from urllib.parse import urlparse


class ArxivSpider(scrapy.Spider):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        categories = os.environ.get("CATEGORIES", "cs.CV")
        categories = categories.split(",")
        # 保存目标分类列表，用于后续验证
        self.target_categories = {category.strip() for category in categories if category.strip()}
        if not self.target_categories or any(not re.fullmatch(r"[a-z][a-z-]*(?:\.[A-Za-z-]+)?", cat)
                                             for cat in self.target_categories):
            raise ValueError("CATEGORIES must contain valid arXiv categories")
        self.start_urls = [
            f"https://arxiv.org/list/{cat}/new" for cat in sorted(self.target_categories)
        ]  # 起始URL（计算机科学领域的最新论文）
        self.seen_ids = set()
        self.candidate_count = 0
        self.completed_categories = set()

    name = "arxiv"  # 爬虫名称
    allowed_domains = ["arxiv.org"]  # 允许爬取的域名

    def parse(self, response):
        page = response.css("#dlpage")
        category_match = re.fullmatch(r"/list/([^/]+)/new", urlparse(response.url).path)
        if not page or not category_match or category_match[1] not in self.target_categories:
            raise ValueError(f"Unexpected arXiv listing page: {response.url}")
        category = category_match[1]
        replacement_start = None
        for li in page.css("ul li"):
            href = li.css("a::attr(href)").get()
            label = " ".join(li.xpath(".//text()").getall()).lower()
            anchor = re.search(r"#item(\d+)$", href or "")
            if anchor and "replacement" in label:
                replacement_start = int(anchor[1])

        expected = 0
        declared_sections = 0
        for heading in page.css("h3"):
            text = " ".join(heading.xpath(".//text()").getall())
            if not re.match(r"(?:New|Cross) submissions", text, re.I):
                continue
            counts = re.search(r"showing (\d+)(?: of (\d+))? entries", text, re.I)
            if counts:
                shown, total = int(counts[1]), int(counts[2] or counts[1])
                if shown != total:
                    raise ValueError(f"Incomplete arXiv listing for {category}: showing {shown} of {total}")
                expected += total
                declared_sections += 1
        records = page.css("dl dt")
        if records and not declared_sections:
            raise ValueError(f"Missing declared submission counts for {category}")
        if not records and not declared_sections:
            empty_notice = " ".join(page.xpath(".//text()").getall())
            if not re.search(r"no (?:new )?(?:submissions|articles|entries|updates)|total of 0 entries", empty_notice, re.I):
                raise ValueError(f"Unrecognized empty arXiv listing for {category}")
        observed = 0

        # Each arXiv list page already contains all metadata needed for filtering.
        # Parsing it here avoids one API request per paper and the resulting 429s.
        for paper in records:
            paper_anchor = paper.css("a[name^='item']::attr(name)").get()
            if not paper_anchor:
                raise ValueError(f"Missing listing anchor in {category}")
                
            paper_id = int(paper_anchor.split("item")[-1])
            if replacement_start is not None and paper_id >= replacement_start:
                continue
            observed += 1

            # 获取论文ID
            abstract_link = paper.css("a[title='Abstract']::attr(href)").get()
            if not abstract_link:
                raise ValueError(f"Missing abstract link in {category}")
                
            arxiv_id = re.sub(r"^/abs/", "", urlparse(abstract_link).path)
            if arxiv_id in self.seen_ids:
                continue
            
            # 获取对应的论文描述部分 (dd元素)
            paper_dd = paper.xpath("following-sibling::dd[1]")
            if not paper_dd:
                raise ValueError(f"Missing metadata for {arxiv_id}")
            
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
            if not re.fullmatch(r"(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Za-z-]+)?/\d{7})(?:v\d+)?", arxiv_id) \
                    or not item["title"] or not item["summary"] or not item["authors"] or not item["categories"]:
                raise ValueError(f"Incomplete arXiv metadata for {arxiv_id}")
            self.seen_ids.add(arxiv_id)
            self.candidate_count += 1
            # 关键词不再参与筛选：全部论文先落盘，交给 Jev 语义闸门分流
            yield item
        if declared_sections and observed != expected:
            raise ValueError(f"Incomplete parsed listing for {category}: read {observed}, expected {expected}")
        self.completed_categories.add(category)

    def closed(self, reason):
        self.logger.info("Crawled %d unique papers, all handed to the Jev screening stage", self.candidate_count)
