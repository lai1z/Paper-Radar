"""Publish a small record of the most recent successful data check."""
import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from paper_history import is_successful, read_records


def build_report(history, current, language, published, source_count, mode, run_url):
    files = {path.name: path for path in Path(history).glob(f"????-??-??_AI_enhanced_{language}.jsonl")}
    if published:
        files.update({path.name: path for path in Path(current).glob(f"????-??-??_AI_enhanced_{language}.jsonl")})
    latest = sorted(files)[-1] if files else None
    count = sum(is_successful(row) for row in read_records(files[latest])) if latest else 0
    return {
        "schema_version": 1, "checked_at": datetime.now(timezone.utc).isoformat(),
        "run_url": run_url, "mode": mode, "latest_publication_date": latest[:10] if latest else None,
        "latest_paper_count": count, "published_this_run": bool(published),
        "source_count": int(source_count), "digest_source": "abstract",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--history-dir", required=True)
    parser.add_argument("--current-dir", default="data")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--published", choices=("true", "false"), default="false")
    parser.add_argument("--source-count", type=int, default=0)
    parser.add_argument("--mode", choices=("daily", "refresh"), default="daily")
    args = parser.parse_args()
    report = build_report(args.history_dir, args.current_dir, os.environ.get("LANGUAGE") or "Chinese",
                          args.published == "true", args.source_count, args.mode,
                          f"https://github.com/{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
