"""Reconcile AI progress against actual publication, rather than cache presence."""
from pathlib import Path

from checkpoint import atomic_write
from paper_history import canonical_id, fingerprint, is_successful
from provenance import preserve_source
from restore_checkpoints import read_state, state_recency


def ordinary_states(directory):
    states = [(path, read_state(path)) for path in Path(directory).glob("*.json")
              if not path.name.startswith("refresh-")]
    yield from sorted(states, key=lambda pair: (state_recency(*pair), pair[0].name))


def prune_published_pending(directory, published):
    """A stale cache must never resurrect a paper that is already on the site."""
    removed = 0
    for path, state in ordinary_states(directory):
        pending = {key: row for key, row in state["pending"].items()
                   if fingerprint(row) not in published}
        if pending != state["pending"]:
            removed += len(state["pending"]) - len(pending)
            state["pending"] = pending
            atomic_write(path, state)
    return removed


def unpublished_successes(directory, published, current=()):
    """Find completed analysis that never reached a successful data publication.

    A crash after AI completion removes the item from the retry queue. Looking
    at successful caches as well recovers it even after it leaves the arXiv feed.
    A newer source title/abstract in the current queue/feed takes precedence.
    """
    latest = {canonical_id(row): row for row in current}
    recovered = {}
    for _, state in ordinary_states(directory):
        for row in state["success"].values():
            key = canonical_id(row)
            if not key or not is_successful(row) or fingerprint(row) in published:
                continue
            source = latest.get(key)
            if source is not None and fingerprint(source) != fingerprint(row):
                continue
            recovered[key] = preserve_source(source, row) if source is not None else row
    return list(recovered.values())
