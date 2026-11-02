"""Validated publication history shared by deduplication and daily publishing."""
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlparse

FIELDS = ("tldr", "motivation", "method", "result", "conclusion")


def read_records(path):
    path = Path(path)
    if not path.exists():
        return []
    rows = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            if not isinstance(row, dict) or not canonical_id(row):
                raise ValueError("missing or invalid paper ID")
        except (ValueError, TypeError) as error:
            raise ValueError(f"Invalid paper history {path.name}:{number}: {error}") from error
        rows.append(row)
    return rows


def canonical_id(row):
    value = str(row.get("id") or row.get("abs") or row.get("url") or "").strip()
    value = re.sub(r"^arxiv:\s*", "", value, flags=re.I)
    if value.startswith(("http://", "https://")):
        url = urlparse(value)
        if url.hostname not in ("arxiv.org", "www.arxiv.org", "export.arxiv.org"):
            return ""
        value = re.sub(r"^/(abs|pdf|html)/", "", url.path)
    value = re.sub(r"\.pdf$", "", value, flags=re.I)
    value = re.sub(r"v\d+$", "", value, flags=re.I)
    return value.lower() if re.fullmatch(r"(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?/\d{7})", value, re.I) else ""


def is_successful(row):
    if row.get("AI_status") not in (None, "success"):
        return False
    ai = row.get("AI")
    if not isinstance(ai, dict):
        return False
    placeholders = ("summary generation failed", "ai summary unavailable", "retry pending",
                    "motivation analysis unavailable", "method extraction failed",
                    "result analysis unavailable", "conclusion extraction failed")
    return all(isinstance(ai.get(field), str) and ai[field].strip()
               and not any(message in ai[field].lower() for message in placeholders)
               for field in FIELDS)


def fingerprint(row):
    """A changed title/abstract is new information, even for an existing arXiv ID."""
    content = [canonical_id(row)] + [" ".join(str(row.get(key) or "").split()) for key in ("title", "summary")]
    return hashlib.sha256(json.dumps(content, ensure_ascii=False).encode("utf-8")).hexdigest()


def successful_fingerprints(history_dir, through_date):
    result = set()
    files = 0
    for path in sorted(Path(history_dir).glob("????-??-??_AI_enhanced_*.jsonl")):
        if path.name[:10] > through_date:
            continue
        files += 1
        result.update(fingerprint(row) for row in read_records(path) if is_successful(row))
    return result, files


def write_records(path, rows):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    temporary.replace(path)
