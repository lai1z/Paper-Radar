"""Merge successful daily results without replacing existing work with empty/failed output."""
import argparse
import os
from pathlib import Path

from paper_history import canonical_id, is_successful, read_records, write_records


def merge_publication(existing, incoming, limit=50):
    if limit <= 0:
        raise ValueError("Publication limit must be positive")
    merged = {canonical_id(row): row for row in existing if is_successful(row)}
    for row in incoming:
        if not is_successful(row):
            continue
        key = canonical_id(row)
        if key in merged or len(merged) < limit:
            merged[key] = row
    # Preserve any legacy day that already exceeded the new cap; never silently delete it.
    return list(merged.values())


def prepare_publication(data_path, history_dir, limit=50):
    data_path = Path(data_path)
    history_path = Path(history_dir) / data_path.name
    if data_path.resolve() == history_path.resolve():
        raise ValueError("History and output must be separate directories")
    existing = read_records(history_path)
    merged = merge_publication(existing, read_records(data_path), limit)
    changed = bool(merged) and merged != existing
    if changed:
        raw_path = data_path.with_name(data_path.name.split("_AI_enhanced_")[0] + ".jsonl")
        if raw_path == data_path:
            raise ValueError("Expected a dated AI_enhanced publication file")
        write_records(data_path, merged)
        write_records(raw_path, [{key: value for key, value in row.items() if key not in ("AI", "AI_status")}
                                 for row in merged])
    else:
        # This is the new run's temporary output, never the history file.
        data_path.unlink(missing_ok=True)
    return changed, len(merged)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--history-dir", required=True)
    parser.add_argument("--limit", type=int, default=50)
    args = parser.parse_args()
    changed, count = prepare_publication(args.data, args.history_dir, args.limit)
    print(f"今日成功解读共 {count} 篇；{'发布合并结果' if changed else '没有新增发布内容，保留线上数据'}")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
            stream.write(f"has_publication={str(changed).lower()}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
