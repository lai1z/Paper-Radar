"""Keep scraped bibliographic records separate from generated enrichment."""
from copy import deepcopy


# These are generated annotations. Everything else remains authoritative input,
# including unknown/new arXiv metadata fields and the absence of optional fields.
ENRICHMENT_FIELDS = frozenset(("AI", "AI_status", "code_url", "code_stars", "code_last_update"))


def source_metadata(record):
    return {key: deepcopy(value) for key, value in record.items() if key not in ENRICHMENT_FIELDS}


def preserve_source(source, enriched):
    """Attach only approved annotations; never accept metadata from a model/cache.

    A cache key covers title and abstract, so authors and publication metadata
    can legitimately change without spending another summarization request.
    """
    result = deepcopy(source)
    for key in ENRICHMENT_FIELDS:
        if key in enriched:
            result[key] = deepcopy(enriched[key])
    return result


def assert_source_preserved(source, enriched):
    if source_metadata(source) != source_metadata(enriched):
        raise ValueError(f"Source metadata changed for {source.get('id', 'unknown')}")
