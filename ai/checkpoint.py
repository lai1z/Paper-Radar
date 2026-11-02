"""Durable per-paper results and bounded retries; no third-party dependencies."""
import hashlib
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock

FIELDS = ("tldr", "motivation", "method", "result", "conclusion")


def checkpoint_key(item):
    return hashlib.sha256(json.dumps(
        [item["id"], item.get("title", ""), item.get("summary", "")], ensure_ascii=False
    ).encode("utf-8")).hexdigest()


def atomic_write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def process_with_checkpoint(items, processor, directory, signature, attempts=3, sleep=time.sleep, workers=1, max_items=0,
                            exclude_ids=(), priority_ids=(), defer_ids=()):
    if max_items < 0:
        raise ValueError("max_items must be nonnegative")
    path = Path(directory) / (signature + ".json")
    state = {"success": {}, "pending": {}}
    if path.exists():
        state = json.loads(path.read_text(encoding="utf-8"))
    # Retry unfinished papers even when they have left the daily arXiv list.
    work = dict(state["pending"])
    work.update({item["id"]: item for item in items})
    if exclude_ids or priority_ids:
        from paper_history import canonical_id
        # Same-day updated versions cannot consume another publication slot, but
        # must survive after leaving today's source list.
        state["pending"].update({key: item for key, item in work.items() if canonical_id(item) in defer_ids})
        state["pending"] = {key: item for key, item in state["pending"].items()
                            if canonical_id(item) not in exclude_ids or canonical_id(item) in defer_ids}
        work = {key: item for key, item in work.items() if canonical_id(item) not in exclude_ids}
        work = dict(sorted(work.items(), key=lambda pair: canonical_id(pair[1]) not in priority_ids))
    # Pending retries share the publication/processing budget with new papers.
    # Persist overflow so it can resume even after leaving the daily feed.
    if max_items and len(work) > max_items:
        state["pending"].update(work)
        print(f"AI budget: {len(work) - max_items} papers deferred", flush=True)
        work = dict(list(work.items())[:max_items])

    output = []
    reused = failed = 0
    jobs = []
    for paper_id, original in work.items():
        item = dict(original)
        item.pop("AI", None)
        item.pop("AI_status", None)
        key = checkpoint_key(item)
        cached = state["success"].get(key)
        if cached is not None:
            output.append(cached)
            state["pending"].pop(paper_id, None)
            reused += 1
            continue
        state["pending"][paper_id] = item
        jobs.append((paper_id, item, key))

    # Persist pending input before spending any API request.
    atomic_write(path, state)

    lock = Lock()
    total = len(work)
    done = reused

    def run_job(job):
        paper_id, item, key = job
        for attempt in range(attempts):
            try:
                result = processor(dict(item))
                if result is not None:
                    ai = result.get("AI", {})
                    if not all(isinstance(ai.get(k), str) and ai[k].strip() for k in FIELDS):
                        raise ValueError("Missing or empty AI fields")
                break
            except Exception as error:
                print(f"Paper {paper_id}: attempt {attempt + 1}/{attempts} failed ({type(error).__name__})",
                      flush=True)
                if attempt + 1 == attempts:
                    result = dict(item)
                    result["AI"] = {field: "AI summary unavailable; retry pending." for field in FIELDS}
                    result["AI_status"] = "failed"
                else:
                    sleep(min(2 ** (attempt + 1), 30))
        return paper_id, key, result

    def record(paper_id, key, result):
        nonlocal failed, done
        with lock:
            if result is None:
                # Positively filtered content is not published.
                state["pending"].pop(paper_id, None)
            else:
                output.append(result)
                if result.get("AI_status") != "failed":
                    result["AI_status"] = "success"
                    state["success"][key] = result
                    state["pending"].pop(paper_id, None)
                else:
                    failed += 1
            atomic_write(path, state)
            done += 1
            print(f"Processed {done}/{total}; reused={reused}, failed={failed}", flush=True)

    if workers > 1 and len(jobs) > 1:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(run_job, job) for job in jobs]
            for future in as_completed(futures):
                record(*future.result())
    else:
        for job in jobs:
            record(*run_job(job))

    atomic_write(path, state)
    print(f"AI batch: {len(work)} papers, {reused} reused, {failed} pending retry", flush=True)
    return output
