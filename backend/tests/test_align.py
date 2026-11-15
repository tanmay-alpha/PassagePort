"""Sentence alignment must never label opposite assertions as shared evidence."""

from __future__ import annotations

import pytest

from passageport.compare.align import diff_passages


@pytest.mark.parametrize(
    ("negative", "positive"),
    [
        ("wasn't", "was"),
        ("hasn't", "has"),
        ("isn't", "is"),
        ("doesn't", "does"),
        ("can't", "can"),
        ("won't", "will"),
        ("weren't", "were"),
        ("haven't", "have"),
        ("hadn't", "had"),
        ("didn't", "did"),
        ("ain't", "is"),
        ("oughtn't", "ought"),
        ("daren't", "dare"),
    ],
)
@pytest.mark.parametrize("apostrophe", ["'", "’", ""])
def test_contracted_negation_is_not_shared(negative: str, positive: str, apostrophe: str) -> None:
    prefix = "The background worker in the production collection "
    suffix = " completed the scheduled operation during the maintenance window."
    left = prefix + negative.replace("'", apostrophe) + suffix
    right = prefix + positive + suffix
    result = diff_passages({"left": left, "right": right})
    assert result.shared_sentences == []
    assert result.unique_sentences == {"left": [left], "right": [right]}
    assert result.numeric_differences == []
    assert not result.identical


@pytest.mark.parametrize("negative", ["wasn't", "hasn't", "isn't", "doesn't", "can't", "won't"])
def test_apostrophe_variants_have_the_same_polarity(negative: str) -> None:
    left = f"The production worker {negative} complete the long scheduled maintenance operation."
    right = left.replace("'", "’")
    assert diff_passages({"left": left, "right": right}).shared_sentences == [left]


def test_compare_keeps_soft_wrapped_prose_and_number_units_complete() -> None:
    shared = "All endpoints are served over\nHTTPS and require authentication."
    left = shared + "\nAccess tokens expire after 24\nhours."
    right = shared + "\nAccess tokens expire after 48\nhours."
    result = diff_passages({"left": left, "right": right})
    assert result.shared_sentences == [shared]
    assert result.numeric_differences[0].values == {"left": "24\nhours", "right": "48\nhours"}
    assert result.numeric_differences[0].context == "Access tokens expire after ___."
