"""Explicit manual refresh of an existing daily selection, without adding papers.

Use a separate, dated checkpoint signature so a retry reuses completed refreshes
and unfinished refreshes never enter the normal daily publication queue.
"""
import argparse
import hashlib
import json
import os
import re
from copy import deepcopy
from pathlib import Path

from checkpoint import atomic_write, checkpoint_key, process_with_checkpoint
from paper_history import canonical_id, is_successful, read_records, write_records


def select_existing(rows, limit=50):
    if limit < 1:
        raise ValueError("Refresh limit must be positive")
    selected = {}
    for row in rows:
        if is_successful(row) and canonical_id(row) not in selected:
            selected[canonical_id(row)] = deepcopy(row)
        if len(selected) >= limit:
            break
    return list(selected.values())


def merge_refreshed(originals, results):
    """Only replace analysis; source metadata and failed papers remain intact."""
    incoming = {canonical_id(row): row for row in results if is_successful(row)}
    merged = []
    for source in originals:
        row = deepcopy(source)
        result = incoming.get(canonical_id(source))
        if result and checkpoint_key(result) == checkpoint_key(source):
            row["AI"] = deepcopy(result["AI"])
            row["AI_status"] = "success"
        merged.append(row)
    return merged


def refresh(rows, processor, directory, signature, workers=8):
    selected = select_existing(rows)
    selected_keys = {checkpoint_key(row) for row in selected}
    state_path = Path(directory) / f"{signature}.json"
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))
        # A manual selection can change between attempts. Stale refresh work
        # must not consume today's budget or mix another abstract version in.
        state["pending"] = {key: row for key, row in state["pending"].items()
                            if checkpoint_key(row) in selected_keys}
        atomic_write(state_path, state)
    results = process_with_checkpoint(
        selected, processor, directory, signature, workers=workers, max_items=50
    )
    refreshed = merge_refreshed(selected, results)
    count = sum(is_successful(row) and checkpoint_key(row) in selected_keys for row in results)
    return refreshed, count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--published-data", required=True, type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--max-workers", type=int, default=8)
    args = parser.parse_args()
    rows = select_existing(read_records(args.published_data))
    if args.inspect:
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
                stream.write(f"ready={str(bool(rows)).lower()}\ncount={len(rows)}\n")
        print(f"Manual refresh: {len(rows)} existing papers available")
        return
    if not rows or not args.out:
        raise ValueError("Refresh requires an existing successful selection and --out")
    date = args.published_data.name[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ValueError("Expected a dated publication file")
    import enhance
    language = os.environ.get("LANGUAGE") or "Chinese"
    model = os.environ.get("MODEL_NAME") or "gpt-4o-mini"
    digest_signature = hashlib.sha256(json.dumps([
        model, language, os.environ.get("OPENAI_BASE_URL", ""), enhance.system,
        enhance.template, (enhance.SCRIPT_DIR / "structure.py").read_text(encoding="utf-8"),
    ], ensure_ascii=False).encode("utf-8")).hexdigest()
    signature = f"refresh-{date}-{digest_signature}"
    model_client = enhance.ChatOpenAI(**enhance.build_chat_openai_kwargs(
        model_name=model, base_url=os.environ.get("OPENAI_BASE_URL", ""),
        api_key=os.environ.get("OPENAI_API_KEY", ""),
    )).with_structured_output(enhance.Structure, method="function_calling")
    prompt = enhance.ChatPromptTemplate.from_messages([
        enhance.SystemMessagePromptTemplate.from_template(enhance.system),
        enhance.HumanMessagePromptTemplate.from_template(enhance.template),
    ])
    chain = prompt | model_client
    refreshed, count = refresh(rows, lambda item: enhance.process_single_item(chain, item, language),
                               enhance.SCRIPT_DIR.parent / ".ai-checkpoints", signature, args.max_workers)
    write_records(args.out, refreshed)
    print(f"Refreshed {count}/{len(rows)} digests; retained existing source metadata and unsuccessful updates")


if __name__ == "__main__":
    main()
