"""Evidence boundaries and safe carry-over of unfinished digest work."""
import json
from pathlib import Path

from checkpoint import atomic_write, checkpoint_key


def grounded_digest(response, abstract, language="Chinese"):
    """Retain result excerpts only when they occur verbatim in the source.

    This is a text-location check, not verification of the scientific claim or
    of semantic entailment. The UI must call these excerpts abstract evidence.
    """
    digest = dict(response)
    verified = []
    removed = 0
    for result in digest.get("key_results", [])[:3]:
        quote = result.get("evidence_quote", "").strip()
        if len(quote) >= 12 and quote in abstract:
            verified.append({**result, "evidence_quote": quote})
        else:
            removed += 1
    digest["key_results"] = verified
    if removed:
        note = ("部分结果未附可定位的摘要原句，未作为关键结果展示。"
                if language.lower() in ("chinese", "zh", "zh-cn", "中文")
                else "Some results lacked a verbatim abstract excerpt and were omitted from key results.")
        digest["limitations"] = [*digest.get("limitations", [])[:2], note]
    digest["source"] = "abstract"
    digest["digest_version"] = 2
    return digest


def _read_state(path):
    if not path.exists():
        return {"success": {}, "pending": {}}
    state = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(state.get("success"), dict) or not isinstance(state.get("pending"), dict):
        raise ValueError(f"Invalid checkpoint state: {path.name}")
    return state


def migrate_pending(directory, signature):
    """Move unfinished work to a new prompt signature without recalculating successes.

    Save the destination before clearing sources, so interruption never loses
    work. Merging by ID makes a rerun after interruption idempotent.
    """
    directory = Path(directory)
    destination = directory / f"{signature}.json"
    state = _read_state(destination)
    sources = []
    inherited = {}
    for path in sorted(directory.glob("*.json"), key=lambda p: (p.stat().st_mtime_ns, p.name)):
        if path == destination:
            continue
        source = _read_state(path)
        if source["pending"]:
            inherited.update(source["pending"])
            sources.append((path, source))
    if not sources:
        return
    inherited.update(state["pending"])
    # Destination wins and completed destination work is never requeued.
    for paper_id, item in list(inherited.items()):
        key = checkpoint_key(item)
        if key in state["success"]:
            inherited.pop(paper_id)
    state["pending"] = inherited
    atomic_write(destination, state)
    for path, source in sources:
        source["pending"] = {}
        atomic_write(path, source)


def defer_items(items, directory, signature, exclude_ids=(), defer_ids=()):
    """Record today's selected work when the publication budget is already full."""
    from paper_history import canonical_id
    path = Path(directory) / f"{signature}.json"
    state = _read_state(path)
    state["pending"].update({item["id"]: item for item in items})
    state["pending"] = {key: item for key, item in state["pending"].items()
                        if canonical_id(item) not in exclude_ids or canonical_id(item) in defer_ids}
    atomic_write(path, state)
