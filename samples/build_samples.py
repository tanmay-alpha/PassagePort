"""Generate the sample documents used by the demo, screenshots and end-to-end tests.

Run: ``cd backend && uv run python ../samples/build_samples.py``. Output is committed so tests do not
depend on reportlab at run time. All text is original and written for this project.
"""

from __future__ import annotations

from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer

OUT = Path(__file__).parent

OS_NOTES = [
    (
        "Operating Systems — Lecture 7: Deadlocks",
        [
            "A deadlock is a state in which every process in a set is waiting for a resource held by "
            "another process in the same set. None of them can run, release what it holds, or be woken up.",
            "Four conditions must hold at the same time for a deadlock to occur. They are known as the "
            "Coffman conditions: mutual exclusion, hold and wait, no preemption, and circular wait.",
            "Mutual exclusion means at least one resource is non-shareable. Hold and wait means a process "
            "keeps the resources it already owns while requesting more. No preemption means a resource "
            "cannot be taken away from the process holding it. Circular wait means there is a closed "
            "chain of processes in which each one waits for a resource held by the next.",
        ],
    ),
    (
        "Deadlock prevention",
        [
            "Deadlock prevention works by making sure at least one of the four Coffman conditions can "
            "never hold. It is a design-time guarantee rather than a run-time check.",
            "To break hold and wait, a process must request all of its resources at once before it "
            "starts, or release everything it holds before asking for more. This lowers resource "
            "utilisation and can starve processes that need several popular resources.",
            "To break circular wait, impose a total ordering on resource types and require every "
            "process to acquire resources in increasing order. Lock ordering is the most widely used "
            "prevention technique in practice, for example always locking the account with the smaller "
            "identifier first in a bank transfer.",
            "Breaking no preemption is possible for resources whose state can be saved and restored, "
            "such as CPU registers or memory pages, but not for printers or locks protecting "
            "half-updated data structures.",
        ],
    ),
    (
        "Deadlock avoidance and detection",
        [
            "Deadlock avoidance needs advance knowledge of the maximum resources each process may "
            "request. The Banker's algorithm grants a request only if the system stays in a safe state, "
            "meaning there is some order in which every process can still finish.",
            "Detection takes the opposite approach: allow deadlocks to happen, periodically search the "
            "wait-for graph for cycles, and recover by aborting a victim process or rolling it back to "
            "a checkpoint. Most general-purpose operating systems use the ostrich algorithm and simply "
            "ignore the problem, because prevention and avoidance cost more than the rare deadlock.",
            "Exam tip: prevention removes a necessary condition, avoidance refuses unsafe allocations, "
            "detection finds cycles after the fact.",
        ],
    ),
]


def api_spec(version: str, rate: int, burst: int, page_size: int, token_hours: int, extra: list[str]) -> list:
    return [
        (
            f"Harbor Notes API — Specification {version}",
            [
                f"This document describes version {version} of the Harbor Notes REST API. All endpoints are "
                "served over HTTPS under the base path /api and return JSON.",
                "Authentication uses bearer tokens sent in the Authorization header. Access tokens expire "
                f"after {token_hours} hours and can be renewed with a refresh token.",
                f"Rate limiting: each API key may send up to {rate} requests per minute, with a burst "
                f"allowance of {burst} requests. Requests over the limit receive HTTP 429 with a "
                "Retry-After header.",
            ],
        ),
        (
            "Listing and pagination",
            [
                "GET /api/notes returns the notes visible to the caller, newest first. "
                f"Results are paginated; the default page size is {page_size} items and the maximum is 200.",
                *extra,
                "Errors use a single envelope with a machine-readable code and a human-readable message. "
                "The code NOTE_LOCKED is returned when another client is editing the note.",
            ],
        ),
    ]


API_V1 = api_spec(
    "1.0",
    rate=100,
    burst=20,
    page_size=25,
    token_hours=24,
    extra=["Pagination is offset based: clients pass page and per_page query parameters."],
)
API_V2 = api_spec(
    "2.0",
    rate=250,
    burst=20,
    page_size=50,
    token_hours=1,
    extra=[
        "Pagination is cursor based: clients pass the next_cursor value from the previous response. "
        "Offset pagination with page and per_page was removed in this version.",
        "Webhooks are new in this version: register a callback URL to be notified when a note changes.",
    ],
)

NETWORKING_MD = """# Networking notes: TCP connection handling

## Three-way handshake

A TCP connection starts with a three-way handshake. The client sends SYN, the server answers
SYN-ACK, and the client completes the exchange with ACK. Only then can either side send data.

## Connection resets

`ECONNRESET` means the peer closed the connection abruptly by sending a RST segment. Common causes
are a crashed server process, an idle timeout on a load balancer, or writing to a socket the other
side has already closed. Retrying is safe only for idempotent requests.

## Congestion control

TCP slows down when it detects packet loss. Slow start doubles the congestion window every round
trip until the threshold `ssthresh` is reached, after which congestion avoidance grows the window
by one segment per round trip. A loss detected by three duplicate ACKs halves the window.

## Keep-alive

HTTP keep-alive reuses one TCP connection for several requests, which avoids repeating the
handshake. Servers usually close idle connections after 60 seconds.
"""


def build_pdf(path: Path, sections: list) -> None:
    styles = getSampleStyleSheet()
    story = []
    for i, (heading, paragraphs) in enumerate(sections):
        if i:
            story.append(PageBreak())
        story.append(Paragraph(heading, styles["Heading1"]))
        story.append(Spacer(1, 12))
        for text in paragraphs:
            story.append(Paragraph(text, styles["BodyText"]))
            story.append(Spacer(1, 8))
    # invariant=1 keeps the bytes reproducible (no timestamps), so sha256-based tests are stable.
    SimpleDocTemplate(str(path), pagesize=A4, title=sections[0][0], invariant=1).build(story)


if __name__ == "__main__":
    build_pdf(OUT / "os-notes-deadlocks.pdf", OS_NOTES)
    build_pdf(OUT / "harbor-api-spec-v1.pdf", API_V1)
    build_pdf(OUT / "harbor-api-spec-v2.pdf", API_V2)
    (OUT / "networking-notes.md").write_text(NETWORKING_MD, encoding="utf-8", newline="\n")
    for p in sorted(OUT.glob("*.*")):
        if p.suffix in {".pdf", ".md"}:
            print(p.name, p.stat().st_size)
