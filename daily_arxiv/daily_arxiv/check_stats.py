#!/usr/bin/env python3
"""Remove already-published successful digests without suppressing unfinished papers."""
import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ai"))
from paper_history import canonical_id, fingerprint, read_records, successful_fingerprints, write_records


def perform_deduplication(data_path=None, history_dir=None, today=None):
    today = today or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    data_path = Path(data_path or f"../data/{today}.jsonl")
    history_dir = Path(history_dir or os.environ.get("PAPER_HISTORY_DIR", "../data"))
    if not data_path.exists():
        return "no_data"
    try:
        papers = read_records(data_path)
        history, file_count = successful_fingerprints(history_dir, today)
        seen_ids = set()
        kept = []
        for paper in papers:
            paper_id = canonical_id(paper)
            if paper_id in seen_ids:
                continue
            seen_ids.add(paper_id)
            if fingerprint(paper) not in history:
                kept.append(paper)
        # Keep a valid empty input for the independent pending-retry queue.
        write_records(data_path, kept)
        print(f"历史成功解读去重库: {len(history)} 条，来自 {file_count} 个增强文件；"
              f"候选 {len(papers)} 篇，待筛选 {len(kept)} 篇", file=sys.stderr)
        return "has_new_content" if kept else "no_new_content"
    except (OSError, ValueError) as error:
        # Corrupt history must not silently turn every old paper into a new paper.
        print(f"去重失败，保留输入且停止本次发布: {error}", file=sys.stderr)
        return "error"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data")
    parser.add_argument("--history-dir")
    parser.add_argument("--date")
    args = parser.parse_args()
    status = perform_deduplication(args.data, args.history_dir, args.date)
    return {"has_new_content": 0, "no_new_content": 1, "no_data": 1, "error": 2}[status]


if __name__ == "__main__":
    raise SystemExit(main())
