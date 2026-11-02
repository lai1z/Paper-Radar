"""Evidence boundaries and safe carry-over of unfinished digest work."""
import json
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path

from checkpoint import atomic_write, checkpoint_key


_NUMBER = re.compile(r"(?<![A-Za-z0-9_.])[+\-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?")
_ATTACHED_UNITS = re.compile(r"^(?:ms|s|fps|hz|khz|mhz|ghz|kb|mb|gb|tb|mm|cm|m|km|w|kw|x)(?![A-Za-z])", re.I)


def numeric_values(text):
    """Arabic numeric values for a conservative availability check.

    Ignore embedded model/dataset identifiers (GPT-4o, V-JEPA2, 3D), normalize
    thousands separators/decimal zeroes, and retain numbers with common units.
    This does NOT verify units, direction, baselines or semantic entailment.
    """
    values = set()
    for match in _NUMBER.finditer(text or ""):
        prefix, suffix = text[:match.start()], text[match.end():]
        if re.search(r"[A-Za-z][A-Za-z0-9_]*[-.]$", prefix):
            continue
        if re.match(r"[A-Za-z]", suffix) and not _ATTACHED_UNITS.match(suffix):
            continue
        try:
            values.add(Decimal(match.group().replace(",", "").replace("−", "-")))
        except InvalidOperation:
            continue
    return values


def supported_result(result, abstract):
    if not isinstance(result, dict):
        return False
    quote = result.get("evidence_quote", "")
    finding = result.get("finding", "")
    setting = result.get("setting", "")
    if not all(isinstance(value, str) for value in (quote, finding, setting)):
        return False
    quote = quote.strip()
    return bool(finding.strip()) and len(quote) >= 12 and quote in abstract \
        and numeric_values(finding) <= numeric_values(quote) \
        and numeric_values(setting) <= numeric_values(abstract)


def grounded_digest(response, abstract, language="Chinese"):
    """Retain result excerpts and numeric values found in the supplied source.

    This is a text-location check, not verification of the scientific claim or
    of semantic entailment. The UI must call these excerpts abstract evidence.
    """
    digest = dict(response)
    verified = []
    removed = 0
    for result in digest.get("key_results", [])[:3]:
        if supported_result(result, abstract):
            verified.append({**result, "evidence_quote": result["evidence_quote"].strip()})
        else:
            removed += 1
    digest["key_results"] = verified
    if removed:
        note = ("部分结果未附可定位的摘要原句，或数字未出现在所附依据中，未作为关键结果展示。"
                if language.lower() in ("chinese", "zh", "zh-cn", "中文")
                else "Some results lacked a verbatim abstract excerpt or contained numbers absent from their source and were omitted from key results.")
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
        # A requested refresh is restricted to its original published day; its
        # failures must not re-enter the next day's new-paper queue.
        if path == destination or path.name.startswith("refresh-"):
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
