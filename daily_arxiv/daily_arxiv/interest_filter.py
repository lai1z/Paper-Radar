"""High-recall, zero-API-cost filtering before AI enhancement."""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path
from typing import Iterable


TOKEN_RE = re.compile(r"[a-z0-9]+|[\u3400-\u9fff]+")
SENTENCE_RE = re.compile(r"[\n.!?;:]+")


@lru_cache(maxsize=50_000)
def _normalize_text(value: str) -> str:
    text = unicodedata.normalize("NFKC", value).casefold()
    text = re.sub(r"[-_/]+", " ", text)
    return " ".join(TOKEN_RE.findall(text))


def normalize(value: object) -> str:
    return _normalize_text(str(value or ""))


def aliases(value: str) -> list[str]:
    """A setting such as ``world model | generative world`` is one topic."""
    return [part.strip() for part in value.split("|") if part.strip()]


@lru_cache(maxsize=100_000)
def _token_matches(query: str, candidate: str, threshold: float) -> bool:
    if query == candidate:
        return True
    # Short tokens and acronyms are too noisy for typo matching.
    if min(len(query), len(candidate)) < 5:
        return False
    return SequenceMatcher(None, query, candidate).ratio() >= threshold


def term_matches(term: str, values: Iterable[object], threshold: float) -> bool:
    query = normalize(term)
    if not query:
        return False

    for value in values:
        text = normalize(value)
        if not text:
            continue
        query_tokens = TOKEN_RE.findall(query)
        # English/acronym matching is token bounded; CJK terms keep substring
        # matching because they are commonly written without spaces.
        if ((any("\u3400" <= char <= "\u9fff" for char in query) and query in text)
                or f" {query} " in f" {text} "):
            return True

        if len(query_tokens) == 1:
            if any(_token_matches(query_tokens[0], token, threshold) for token in TOKEN_RE.findall(text)):
                return True
            continue

        # Keep related words close to each other. This catches reordered phrases
        # and small spelling variations without matching words scattered across
        # an entire abstract.
        for sentence in SENTENCE_RE.split(str(value or "")):
            sentence_tokens = TOKEN_RE.findall(normalize(sentence))
            if not sentence_tokens:
                continue
            positions = [
                [index for index, token in enumerate(sentence_tokens)
                 if _token_matches(query_token, token, threshold)]
                for query_token in query_tokens
            ]
            if any(not matches for matches in positions):
                continue
            span = len(query_tokens) + 4
            for anchor in positions[0]:
                nearby = [
                    [position for position in matches if abs(position - anchor) < span]
                    for matches in positions
                ]
                if all(nearby) and max(min(matches, key=lambda position: abs(position - anchor))
                                       for matches in nearby) - min(
                                           min(matches, key=lambda position: abs(position - anchor))
                                           for matches in nearby
                                       ) < span:
                    return True
    return False


@dataclass(frozen=True)
class MatchResult:
    matched: bool
    keywords: tuple[str, ...] = ()
    authors: tuple[str, ...] = ()
    reason: str = ""


class InterestFilter:
    def __init__(self, config: dict):
        self.config = config
        self.enabled = bool(config.get("enabled", False))
        self.keywords = tuple(str(item).strip() for item in config.get("keywords", []) if str(item).strip())
        self.authors = tuple(str(item).strip() for item in config.get("authors", []) if str(item).strip())
        matching = config.get("matching", {})
        self.fields = tuple(matching.get("fields", ("title", "summary", "categories", "comment")))
        self.threshold = float(matching.get("fuzzy_threshold", 0.84))
        if not 0.7 <= self.threshold <= 1.0:
            raise ValueError("matching.fuzzy_threshold must be between 0.70 and 1.00")
        if self.enabled and not (self.keywords or self.authors):
            raise ValueError("Interest filter is enabled but has no keywords or authors")

    @classmethod
    def from_file(cls, path: str | Path) -> "InterestFilter":
        with Path(path).open("r", encoding="utf-8") as stream:
            return cls(json.load(stream))

    def match(self, paper: dict) -> MatchResult:
        if not self.enabled:
            return MatchResult(True, reason="filter_disabled")

        keyword_values: list[object] = []
        for field in self.fields:
            value = paper.get(field, "")
            keyword_values.extend(value if isinstance(value, list) else [value])
        author_values = paper.get("authors", [])
        if not isinstance(author_values, list):
            author_values = [author_values]

        matched_keywords = tuple(
            topic for topic in self.keywords
            if any(term_matches(alias, keyword_values, self.threshold) for alias in aliases(topic))
        )
        matched_authors = tuple(
            topic for topic in self.authors
            if any(term_matches(alias, author_values, self.threshold) for alias in aliases(topic))
        )
        return MatchResult(
            bool(matched_keywords or matched_authors),
            keywords=matched_keywords,
            authors=matched_authors,
            reason="interest_match" if matched_keywords or matched_authors else "no_interest_match",
        )
