"""Run a complete arXiv crawl; never promote a partial/failed crawl as an empty day."""
import argparse
import json
import os
from pathlib import Path


def validate_crawl(stats, expected_categories, completed_categories, candidate_count, rows):
    if stats.get("finish_reason") != "finished":
        raise ValueError(f"Crawl did not finish: {stats.get('finish_reason', 'unknown')}")
    missing = set(expected_categories) - set(completed_categories)
    if missing:
        raise ValueError("Incomplete category coverage: " + ", ".join(sorted(missing)))
    errors = {key: value for key, value in stats.items() if value and (
        key == "log_count/ERROR" or key.startswith("spider_exceptions/")
        or key.startswith("feedexport/failed_count/") or key in ("item_error_count", "item_dropped_count"))}
    if errors:
        raise ValueError(f"Crawl encountered errors: {errors}")
    if len(rows) != candidate_count or stats.get("item_scraped_count", 0) != candidate_count:
        raise ValueError(f"Incomplete feed export: {len(rows)} rows, {candidate_count} parsed papers")
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not row.get("id") or not row.get("title") or not row.get("summary"):
            raise ValueError("Incomplete paper in crawl output")
        if row["id"] in seen:
            raise ValueError("Duplicate paper in crawl output")
        seen.add(row["id"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    from scrapy.crawler import CrawlerProcess
    from scrapy.utils.project import get_project_settings
    from daily_arxiv.spiders.arxiv import ArxivSpider

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".partial")
    settings = get_project_settings()
    settings.set("FEEDS", {str(temporary): {"format": "jsonlines", "encoding": "utf-8", "overwrite": True}}, priority="cmdline")
    settings.set("DOWNLOAD_TIMEOUT", 60, priority="cmdline")
    settings.set("RETRY_TIMES", 2, priority="cmdline")
    settings.set("LOG_LEVEL", "INFO", priority="cmdline")
    settings.set("TELNETCONSOLE_ENABLED", False, priority="cmdline")
    process = CrawlerProcess(settings)
    crawler = process.create_crawler(ArxivSpider)
    failures = []
    process.crawl(crawler).addErrback(lambda failure: failures.append(str(failure.value)))
    process.start()
    if failures or crawler.spider is None:
        raise ValueError("Crawler failed to start or finish: " + "; ".join(failures))
    if not temporary.exists():
        # Scrapy may omit a feed with no items. Accept it only after complete
        # category validation below; an HTTP failure cannot pass that check.
        rows = []
    else:
        rows = [json.loads(line) for line in temporary.read_text(encoding="utf-8").splitlines() if line.strip()]
    spider = crawler.spider
    validate_crawl(crawler.stats.get_stats(), spider.target_categories,
                   spider.completed_categories, spider.candidate_count, rows)
    if not temporary.exists():
        temporary.write_text("", encoding="utf-8")
    os.replace(temporary, output)
    print(f"Validated all {len(spider.target_categories)} categories; published {len(rows)} crawl candidates")


if __name__ == "__main__":
    main()
