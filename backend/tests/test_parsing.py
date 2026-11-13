"""Parsers, text normalisation and the child-process sandbox."""

from __future__ import annotations

import os
import time

import pytest
from conftest import build_docx, build_pdf

from passageport.parsing import ParseError, ParseLimits, parse_document, parse_in_process
from passageport.parsing.isolated import CRASH_MESSAGE, TIMEOUT_MESSAGE, run_isolated
from passageport.parsing.text import (
    MAX_LABEL_CHARS,
    SECTION_TARGET_CHARS,
    normalize_text,
    split_by_size,
    split_markdown,
)

LIMITS = ParseLimits(max_pages=1500, max_document_chars=4_000_000)


def parse(kind: str, data: bytes, limits: ParseLimits = LIMITS, title: str | None = None):
    return parse_in_process(kind, data, limits, title)


# --------------------------------------------------------------------------- normalisation


def test_reflow_collapses_spaces_and_keeps_paragraph_breaks():
    raw = "First   line\twith \u00a0 gaps  \r\nsecond line\r\n\r\n\r\n\r\nNew   paragraph\x0c"
    assert normalize_text(raw, reflow=True) == "First line with gaps\nsecond line\n\nNew paragraph"


def test_reflow_repairs_hyphenated_line_breaks_conservatively():
    assert normalize_text("infor-\nmation retrieval", reflow=True) == "information retrieval"
    # Not between lowercase words: ranges, list markers and capitalised compounds stay as written.
    assert normalize_text("pages 10-\n20", reflow=True) == "pages 10-\n20"
    assert normalize_text("Anglo-\nSaxon", reflow=True) == "Anglo-\nSaxon"
    assert normalize_text("- item one\n- item two", reflow=True) == "- item one\n- item two"


def test_plain_text_keeps_indentation_and_inner_spacing():
    raw = "def f():\n    return  1   \n\n\n\n| a   | b |\n"
    assert normalize_text(raw, reflow=False) == "def f():\n    return  1\n\n| a   | b |"


def test_normalisation_removes_control_characters_and_expands_ligatures():
    raw = "o\ufb03ce \x00\x07fi\u00adnal\ufeff \ud83d text\u200b"
    assert normalize_text(raw, reflow=True) == "office final text"


def test_normalisation_is_deterministic_and_idempotent():
    raw = "A  b\r\n\r\n\r\nc-\nd  e\u00a0f\tg  "
    once = normalize_text(raw, reflow=True)
    assert normalize_text(raw, reflow=True) == once
    assert normalize_text(once, reflow=True) == once


def test_normalisation_is_linear_on_pathological_whitespace():
    raw = "x" + " " * 400_000 + "y\n" + "# " + "\t" * 400_000 + "z"
    started = time.perf_counter()
    normalize_text(raw, reflow=False)
    normalize_text(raw, reflow=True)
    split_markdown(raw, "doc")
    assert time.perf_counter() - started < 5


# --------------------------------------------------------------------------- TXT


def test_txt_splits_at_paragraph_boundaries_near_the_target_size():
    paragraphs = [f"Paragraph {i} " + "word " * 120 for i in range(30)]
    pages = parse("txt", "\n\n".join(paragraphs).encode())

    assert len(pages) > 3
    assert [p.number for p in pages] == list(range(1, len(pages) + 1))
    assert [p.label for p in pages] == [f"Part {n}" for n in range(1, len(pages) + 1)]
    assert all(len(p.text) <= SECTION_TARGET_CHARS for p in pages)
    assert all(p.text.startswith("Paragraph ") for p in pages)  # never cut mid-paragraph
    assert "\n\n".join(p.text for p in pages) == "\n\n".join(s.strip() for s in paragraphs)


def test_txt_without_paragraphs_is_still_split():
    one_line = ("word " * 5000).strip()
    pages = parse("txt", one_line.encode())
    assert len(pages) > 5
    assert all(len(p.text) <= 2 * SECTION_TARGET_CHARS for p in pages)
    assert " ".join(p.text for p in pages) == one_line

    unbroken = "x" * 20_000
    assert "".join(split_by_size(unbroken)) == unbroken


def test_txt_accepts_bom_and_rejects_non_utf8():
    pages = parse("txt", b"\xef\xbb\xbfhello world")
    assert pages[0].text == "hello world"
    with pytest.raises(ParseError, match="UTF-8"):
        parse("txt", "héllo".encode("latin-1"))


def test_whitespace_only_text_is_an_error():
    with pytest.raises(ParseError, match="no text"):
        parse("txt", b" \n\n \t\n")


# --------------------------------------------------------------------------- Markdown


def test_markdown_sections_split_at_h1_and_h2_only():
    source = (
        "Preamble line.\n\n# Install ##\n\nStep one.\n\n### Detail\n\nMore.\n\n"
        "## Usage with C#\n\nRun it.\n\n#NotAHeading\n"
    )
    pages = parse("md", source.encode(), title="Handbook")

    assert [(p.number, p.label) for p in pages] == [(1, "Handbook"), (2, "Install"), (3, "Usage with C#")]
    assert pages[0].text == "Preamble line."
    assert pages[1].text == "# Install ##\n\nStep one.\n\n### Detail\n\nMore."
    assert pages[2].text.endswith("#NotAHeading")


def test_markdown_ignores_headings_inside_fenced_code():
    source = (
        "# Real\n\n```bash\n# comment, not a heading\n## also not\n```\n\n"
        "~~~~\n# still code\n```\n# and still code\n~~~~\n\n## After\n\ntext\n"
    )
    pages = parse("md", source.encode())
    assert [p.label for p in pages] == ["Real", "After"]
    assert "# comment, not a heading" in pages[0].text
    assert "# and still code" in pages[0].text


def test_markdown_without_headings_and_preamble_label_fallback():
    pages = parse("md", b"just a note")
    assert [(p.label, p.text) for p in pages] == [("Introduction", "just a note")]


def test_markdown_long_sections_are_divided_and_labels_bounded():
    heading = "H" * 400
    body = "\n\n".join("sentence " * 100 for _ in range(12))
    pages = parse("md", f"# {heading}\n\n{body}".encode())
    assert len(pages) > 1
    assert all(len(p.label) <= MAX_LABEL_CHARS for p in pages)
    assert all(len(p.text) <= 2 * SECTION_TARGET_CHARS for p in pages)

    short = parse("md", b"# Topic\n\n" + b"\n\n".join(b"alpha " * 150 for _ in range(10)))
    assert [p.label for p in short][:2] == ["Topic (part 1)", "Topic (part 2)"]


# --------------------------------------------------------------------------- DOCX


def test_docx_sections_follow_heading_styles_and_include_tables():
    data = build_docx(
        [
            ("p", "Opening remarks."),
            ("h1", "Results"),
            ("p", "Accuracy   improved."),
            ("h2", "Limitations"),
            ("p", "Small sample."),
        ],
        table=[["Metric", "Value"], ["Recall", "0.91"]],
    )
    pages = parse("docx", data, title="Study")

    assert [p.label for p in pages] == ["Study", "Results", "Limitations"]
    assert pages[0].text == "Opening remarks."
    assert pages[1].text == "Results\n\nAccuracy improved."
    assert pages[2].text == "Limitations\n\nSmall sample.\n\nMetric | Value\nRecall | 0.91"


def test_docx_without_headings_falls_back_to_sized_parts():
    data = build_docx([("p", "word " * 150) for _ in range(12)])
    pages = parse("docx", data)
    assert len(pages) > 1
    assert [p.label for p in pages] == [f"Part {n}" for n in range(1, len(pages) + 1)]


def test_docx_malformed_archive_is_a_parse_error():
    with pytest.raises(ParseError, match="Word document"):
        parse("docx", b"PK\x03\x04 this is not a real archive")


# --------------------------------------------------------------------------- PDF


def test_pdf_yields_one_page_per_pdf_page():
    pages = parse("pdf", build_pdf(["Alpha page text.", "", "Gamma page text."]))
    assert [(p.number, p.label) for p in pages] == [(1, "Page 1"), (2, "Page 2"), (3, "Page 3")]
    assert pages[0].text == "Alpha page text."
    assert pages[1].text == ""
    assert pages[2].text == "Gamma page text."


def test_pdf_encrypted_is_rejected_with_a_clear_message():
    with pytest.raises(ParseError, match="password-protected"):
        parse("pdf", build_pdf(["secret text"], encrypt="hunter2"))


def test_pdf_without_text_is_reported_as_probably_scanned():
    with pytest.raises(ParseError, match=r"scanned.*OCR is not supported"):
        parse("pdf", build_pdf(["", ""]))


@pytest.mark.parametrize(
    "data",
    [b"%PDF-1.7\nthis is not really a pdf", b"%PDF-1.4\n%%EOF", build_pdf(["cut off"])[:300]],
    ids=["garbage", "empty-body", "truncated"],
)
def test_pdf_malformed_is_a_parse_error(data):
    with pytest.raises(ParseError) as caught:
        parse("pdf", data)
    assert "PDF" in caught.value.user_message


def test_page_and_character_limits():
    with pytest.raises(ParseError, match="3 pages; the limit is 2"):
        parse("pdf", build_pdf(["a", "b", "c"]), ParseLimits(max_pages=2, max_document_chars=1000))
    with pytest.raises(ParseError, match="more than 20 characters"):
        parse("pdf", build_pdf(["a fairly long page of text here"]), ParseLimits(10, 20))
    with pytest.raises(ParseError, match="more than 20 characters"):
        parse("txt", b"x" * 21, ParseLimits(10, 20))
    with pytest.raises(ParseError, match="sections; the limit is 2"):
        parse("md", b"# a\n\n1\n\n# b\n\n2\n\n# c\n\n3", ParseLimits(2, 1000))
    with pytest.raises(ParseError, match="more than 20 characters"):
        parse("docx", build_docx([("p", "y" * 30)]), ParseLimits(10, 20))


def test_unknown_kind_is_rejected():
    with pytest.raises(ParseError):
        parse("exe", b"MZ")


# --------------------------------------------------------------------------- sandbox


def test_parse_document_runs_in_a_child_process(settings):
    pages = parse_document("md", b"# Title\n\nBody text.", settings, title="doc")
    assert [(p.number, p.label, p.text) for p in pages] == [(1, "Title", "# Title\n\nBody text.")]

    pdf_pages = parse_document("pdf", build_pdf(["One.", "Two."]), settings)
    assert [p.text for p in pdf_pages] == ["One.", "Two."]


def test_parse_errors_cross_the_process_boundary(settings):
    with pytest.raises(ParseError, match="password-protected"):
        parse_document("pdf", build_pdf(["x"], encrypt="pw"), settings)


def test_child_runs_in_another_process():
    assert run_isolated(os.getpid, (), 30) != os.getpid()


def test_hung_parser_is_killed_at_the_deadline():
    started = time.monotonic()
    with pytest.raises(ParseError) as caught:
        run_isolated(time.sleep, (120,), 1.5)
    assert caught.value.user_message == TIMEOUT_MESSAGE
    assert time.monotonic() - started < 30


def test_crashed_parser_is_reported_without_details():
    with pytest.raises(ParseError) as caught:
        run_isolated(os._exit, (3,), 30)
    assert caught.value.user_message == CRASH_MESSAGE


def test_unexpected_parser_exception_does_not_leak_its_message():
    with pytest.raises(ParseError) as caught:
        run_isolated(int, ("secret document text",), 30)
    assert caught.value.user_message == CRASH_MESSAGE
    assert "secret" not in str(caught.value)
