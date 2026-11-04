"""Merge data-branch checkpoints with newer caches from interrupted runs."""
import argparse
import json
from pathlib import Path

from paper_history import is_successful


def identity(row):
    return tuple(str(row.get(key) or "") for key in ("id", "title", "summary"))


def read_state(path):
    state = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(state, dict) or any(not isinstance(state.get(key), dict) for key in ("success", "pending")):
        raise ValueError(f"Invalid checkpoint state: {path.name}")
    if any(not isinstance(row, dict) for records in state.values() if isinstance(records, dict) for row in records.values()):
        raise ValueError(f"Invalid checkpoint record: {path.name}")
    if "updated_at_ns" in state and (type(state["updated_at_ns"]) is not int or state["updated_at_ns"] < 0):
        raise ValueError(f"Invalid checkpoint recency: {path.name}")
    return state


def state_recency(path, state):
    # An archive extraction time cannot outrank recorded processing recency.
    # Legacy/legacy conflicts still fall back to file time until rewritten.
    return ("updated_at_ns" in state, state.get("updated_at_ns", path.stat().st_mtime_ns))


def merge_states(older, newer):
    merged = {key: {**older.get(key, {}), **newer.get(key, {})} for key in ("success", "pending")}
    successful = {identity(row) for row in merged["success"].values() if is_successful(row)}
    merged["pending"] = {key: row for key, row in merged["pending"].items() if identity(row) not in successful}
    if "updated_at_ns" in older or "updated_at_ns" in newer:
        merged["updated_at_ns"] = max(older.get("updated_at_ns", 0), newer.get("updated_at_ns", 0))
    return merged


def restore(durable_dir, cache_dir):
    durable_dir, cache_dir = Path(durable_dir), Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    names = {path.name for directory in (durable_dir, cache_dir) for path in directory.glob("*.json")}
    for name in sorted(names):
        sources = []
        errors = []
        for directory in (cache_dir, durable_dir):
            path = directory / name
            if not path.exists():
                continue
            try:
                state = read_state(path)
                sources.append((state_recency(path, state), state))
            except (OSError, ValueError) as error:
                errors.append(error)
        if not sources:
            raise ValueError(f"No valid checkpoint copy for {name}") from errors[0]
        if errors:
            print(f"Recovered {name} from a valid copy; ignored {len(errors)} corrupt copy/copies")
        sources.sort(key=lambda pair: pair[0])
        merged = {"success": {}, "pending": {}}
        for _, state in sources:
            merged = merge_states(merged, state)
        target = cache_dir / name
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(merged, ensure_ascii=False), encoding="utf-8")
        temporary.replace(target)
        print(f"Restored {name}: {len(merged['success'])} successes, {len(merged['pending'])} pending")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--durable-dir", required=True)
    parser.add_argument("--cache-dir", required=True)
    args = parser.parse_args()
    restore(args.durable_dir, args.cache_dir)
