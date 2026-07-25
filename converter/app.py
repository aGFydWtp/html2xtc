# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 aGFydWtp

"""HTTP wrapper around the xtctool CLI. Standard library only, except for an
optional pymupdf import (shipped with xtctool) used to read PDF metadata.

POST /convert            trusted PDF (produced by our own Browser Run step)
                         request body = PDF bytes -> response body = XTC bytes
                         (X-Xtc-Title response header carries the PDF title,
                          UTF-8 percent-encoded, when one could be extracted;
                          X-Xtc-Chapters request header, optional, carries a
                          base64url JSON chapter list -- see
                          decode_chapters_header/resolve_chapters below for
                          the detection and XTC-embedding contract)
POST /convert/uploaded-pdf  untrusted, user-uploaded PDF; see pdf_upload.py
                         for request/response contract and validation.
GET  /healthz            liveness probe

Error responses carry generic JSON messages; xtctool stderr and tracebacks go
to the process log only.
"""

import base64
import json
import logging
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import pymupdf
except ImportError:  # pragma: no cover - always present in the container image
    pymupdf = None

CONFIG_PATH = os.environ.get("XTC_CONFIG_PATH", "/app/config-x3.toml")
CONVERT_TIMEOUT_SECONDS = int(os.environ.get("XTC_TIMEOUT_SECONDS", "120"))
PORT = int(os.environ.get("PORT", "8080"))
MAX_PDF_BYTES = int(os.environ.get("MAX_PDF_BYTES", str(50 * 1024 * 1024)))
# Absolute ceiling for the header-supplied limit (defense-in-depth against a
# compromised or misconfigured Worker); far above any normal operating limit.
HARD_MAX_PDF_BYTES = 512 * 1024 * 1024
MAX_CONCURRENT_CONVERSIONS = int(os.environ.get("MAX_CONCURRENT_CONVERSIONS", "2"))

logger = logging.getLogger("converter")


def _positive_env_int(name: str, default: int) -> int:
    """Environment override that must be a positive integer; anything else
    falls back to the default with a warning (a zero/negative chunk size or
    threshold would break the chunking arithmetic, and container startup must
    never be blocked by a bad env var)."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value <= 0:
        logger.warning(
            "%s=%r is not a positive integer; using default %d", name, raw, default
        )
        return default
    return value


def _clamp_chunk_size_to_threshold(chunk_size: int, threshold: int) -> int:
    """Clamp chunk_size to threshold, warning when it fires.

    A single xtctool invocation rasterizes at most chunk_size pages at once,
    so that value -- not the threshold -- actually bounds peak memory. If
    XTC_CHUNK_SIZE_PAGES and XTC_CHUNK_THRESHOLD_PAGES are overridden
    independently and the former ends up above the latter, a PDF between the
    two values does take the chunked path, but convert_pdf's page ranges then
    span the whole document in a single chunk -- so xtctool still rasterizes
    every page in one call, and chunking bounds nothing. This clamp is what
    actually keeps "a single xtctool call never rasterizes more than
    CHUNK_THRESHOLD_PAGES pages" true regardless of which of the two env vars
    is overridden."""
    if chunk_size > threshold:
        logger.warning(
            "XTC_CHUNK_SIZE_PAGES (%d) exceeds XTC_CHUNK_THRESHOLD_PAGES (%d); "
            "clamping the chunk size to the threshold",
            chunk_size,
            threshold,
        )
        return threshold
    return chunk_size


# xtctool rasterizes every selected page into memory before packing (~7.0MiB
# per page + ~134MiB base, measured 2026-07 via `docker --memory=1g` binary
# search: 128 pages succeeded, 130 pages OOM-killed), so long PDFs are
# converted in page-range chunks and the chunk XTCs are repacked into the
# final container. PDFs at or below the threshold use the original
# single-pass conversion.
#
# Invariant: CHUNK_SIZE_PAGES never exceeds CHUNK_THRESHOLD_PAGES --
# _clamp_chunk_size_to_threshold enforces it below, independently of env
# overrides applied to only one of the two.
CHUNK_THRESHOLD_PAGES = _positive_env_int("XTC_CHUNK_THRESHOLD_PAGES", 80)
CHUNK_SIZE_PAGES = _clamp_chunk_size_to_threshold(
    _positive_env_int("XTC_CHUNK_SIZE_PAGES", 80), CHUNK_THRESHOLD_PAGES
)

if pymupdf is None:  # pragma: no cover - always present in the container image
    logger.warning("pymupdf is unavailable; PDF title extraction is disabled")

# Bounds concurrent xtctool subprocesses (each rasterizes up to
# CHUNK_SIZE_PAGES, or a whole short PDF up to CHUNK_THRESHOLD_PAGES, into
# memory); excess requests queue on their handler threads.
#
# Current deployment target (wrangler.jsonc: standard-1, 4GiB), measured
# 2026-07 via `docker --cpus=0.5 --memory=4g`: two concurrent chunked
# conversions of a 135-page PDF (two chunks of 80+55 pages each, today's
# CHUNK_THRESHOLD_PAGES/CHUNK_SIZE_PAGES defaults) both succeeded -- peak
# container RSS 1345MiB of 4096MiB, 25.8s wall time. Separately, a single
# (non-concurrent) 135-page conversion at the same chunk settings succeeded
# even under `docker --memory=1g` (28.7s wall time), confirming the chunked
# path, not just the larger instance, is what keeps this size safe.
#
# Older 1GiB-instance measurements, kept for context on why chunking exists
# and no longer descriptive of what this semaphore runs on:
#
# - Two concurrent chunked conversions of the 665-page reference PDF were
#   previously measured to peak at ~750MiB total (docker --memory=1g); the
#   per-chunk size at that time is not recorded, so this figure cannot be
#   directly compared to the measurements above.
#
# - Separately (2026-07, docker --memory=1g, ~7.0MiB/page + ~134MiB base):
#   two concurrent single-pass conversions of a 100-page PDF (i.e. two
#   subprocesses each rasterizing 100 pages at once, above the
#   CHUNK_SIZE_PAGES default of 80) OOM-killed one of the two -- i.e.
#   100-page chunks are unsafe two-at-a-time on a 1GiB instance.
CONVERSION_SLOTS = threading.Semaphore(MAX_CONCURRENT_CONVERSIONS)


class ActiveRequestTracker:
    """Counts in-flight requests so shutdown can drain them."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active = 0
        self._idle = threading.Event()
        self._idle.set()

    def __enter__(self) -> "ActiveRequestTracker":
        with self._lock:
            self._active += 1
            self._idle.clear()
        return self

    def __exit__(self, *exc_info) -> None:
        with self._lock:
            self._active -= 1
            if self._active == 0:
                self._idle.set()

    def wait_idle(self, timeout: float | None = None) -> bool:
        return self._idle.wait(timeout)


ACTIVE_REQUESTS = ActiveRequestTracker()


def effective_max_pdf_bytes(headers) -> int:
    """Size limit for the incoming PDF. The Worker owns the authoritative
    limit and passes it via X-Max-Pdf-Bytes; fall back to the module default
    (env MAX_PDF_BYTES) when the header is absent or not a positive integer.
    Header values are clamped to HARD_MAX_PDF_BYTES so a compromised or
    misconfigured Worker cannot disable the size floor entirely."""
    raw = headers.get("X-Max-Pdf-Bytes")
    if raw is not None:
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if value > 0:
            return min(value, HARD_MAX_PDF_BYTES)
    return MAX_PDF_BYTES


class ConversionError(Exception):
    def __init__(self, message: str, stderr: str = "") -> None:
        super().__init__(message)
        self.stderr = stderr


# Matches MAX_TITLE_CHARS in src/jobs.ts; xtctool itself truncates the XTC
# metadata title to 127 UTF-8 bytes on write.
MAX_TITLE_CHARS = 100

# xtctool's XTCWriter._write_chapters (see xtctool-chapters.patch) reserves
# an 80-byte fixed field per chapter name: up to 79 content bytes plus at
# least one trailing null byte (it zero-pads whatever is left after a plain
# byte-level slice to 79 bytes). Truncating to 79 bytes ourselves, safely
# (see truncate_utf8_bytes), means that byte-level slice inside xtctool is
# always a no-op for the names we send it -- it never gets a chance to split
# a multi-byte UTF-8 character in half.
MAX_CHAPTER_NAME_BYTES = 79


def decode_base64url_utf8(value: str) -> str:
    """Decodes a base64url (no padding) UTF-8 header value, matching
    src/base64url.ts#encodeBase64Url's encoding on the Worker side. Fail-soft
    to "" on any malformed input (bad alphabet, wrong padding, invalid UTF-8)
    -- metadata like the author name must never block a conversion the same
    way a missing/garbled title never does."""
    try:
        padding = "=" * (-len(value) % 4)
        raw = base64.urlsafe_b64decode(value + padding)
        return raw.decode("utf-8")
    except Exception:  # noqa: BLE001 - malformed header, not fatal
        return ""


def truncate_utf8_bytes(text: str, max_bytes: int) -> str:
    """Truncates text so its UTF-8 encoding is at most max_bytes, without
    ever splitting a multi-byte character. A plain byte-level slice (as
    xtctool's own XTCWriter._write_chapters does on the value it is handed --
    see MAX_CHAPTER_NAME_BYTES and xtctool-chapters.patch) can otherwise cut
    a UTF-8 sequence in half and write invalid UTF-8 into the XTC
    container."""
    if len(text.encode("utf-8")) <= max_bytes:
        return text
    while text and len(text.encode("utf-8")) > max_bytes:
        text = text[:-1]
    return text


def decode_chapters_header(raw_header: str) -> list[dict[str, str]]:
    """Decodes X-Xtc-Chapters (base64url JSON array of {"name", "marker"}
    objects, in chapter order) into a plain list of {"name", "marker"}
    dicts. Malformed input fails soft to [] -- chapters are a nice-to-have
    piece of XTC metadata, never something that should block a conversion,
    matching X-Xtc-Author/X-Xtc-Title's stance on bad headers.

    marker is optional per entry (missing/non-string falls back to "", which
    makes detect_chapter_pages skip straight to the name-based fallback
    search); name is required -- entries missing a non-empty string name are
    dropped rather than raising."""
    decoded = decode_base64url_utf8(raw_header)
    if not decoded:
        return []
    try:
        data = json.loads(decoded)
    except Exception:  # noqa: BLE001 - malformed header, not fatal
        return []
    if not isinstance(data, list):
        return []
    chapters: list[dict[str, str]] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            continue
        marker = entry.get("marker")
        if not isinstance(marker, str):
            marker = ""
        chapters.append({"name": name, "marker": marker})
    return chapters


def sanitize_title(raw: str) -> str:
    """Collapse whitespace/control characters in a PDF-metadata-sourced title
    and cap its length. Shared by the trusted /convert path (read_pdf_metadata
    below) and the untrusted /convert/uploaded-pdf path (pdf_upload.py)."""
    title = "".join(" " if ord(c) < 0x20 or ord(c) == 0x7F else c for c in raw)
    title = " ".join(title.split())
    return title[:MAX_TITLE_CHARS].strip()


def read_pdf_metadata(pdf_bytes: bytes) -> tuple[str, int | None]:
    """Best-effort single-pass read of the PDF /Title metadata (Chromium's
    print-to-PDF stores the page <title> there) and the page count. Returns
    ("", None) when unavailable."""
    if pymupdf is None:
        return "", None
    try:
        with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
            title = (doc.metadata or {}).get("title") or ""
            page_count = doc.page_count
    except Exception:  # noqa: BLE001 - metadata is optional, never fatal
        logger.exception("failed to read PDF metadata")
        return "", None
    return sanitize_title(title), page_count


def extract_pdf_title(pdf_bytes: bytes) -> str:
    """PDF /Title metadata, or "" when unavailable."""
    return read_pdf_metadata(pdf_bytes)[0]


def count_pdf_pages(pdf_bytes: bytes) -> int | None:
    """Page count of the PDF, or None when it cannot be determined."""
    return read_pdf_metadata(pdf_bytes)[1]


def normalize_search_text(text: str) -> str:
    """Strips every whitespace character (space, tab, newline, full-width
    U+3000 IDEOGRAPHIC SPACE -- str.isspace() covers all of these) from text
    before chapter marker/name search. Vertical-writing PDFs can have
    pymupdf's text extraction inject spurious whitespace/line breaks between
    characters that read contiguously on the rendered page, so both the
    haystack (page text) and the needle (marker/name) are normalized the
    same way before substring search. A local test (2026-07, headless
    Chrome 150.0.7871.182 + pymupdf, vertical writing-mode) found no such
    fragmentation for the marker span specifically -- see
    detect_chapter_pages' docstring -- but this normalization is kept as
    insurance regardless, since a different font/layout combination could
    still fragment it."""
    return "".join(ch for ch in text if not ch.isspace())


def detect_chapter_pages(pdf_bytes: bytes, chapters: list[dict[str, str]]) -> list[dict]:
    """Locates each configured chapter's starting page (0-indexed) in
    document order, in two passes against whitespace-stripped page text (see
    normalize_search_text, which guards against vertical-writing layouts
    injecting spurious whitespace/line breaks into extracted text):

    1. Marker pass: every chapter is searched for by its marker string (the
       invisible <span class="xtc-chapter-marker"> the Worker embeds just
       before each heading -- see this module's docstring for the
       X-Xtc-Chapters contract). Verified locally (2026-07, headless Chrome
       150.0.7871.182 + pymupdf, a 30-page vertical-writing document --
       `writing-mode: vertical-rl`, `@page { size: 528px 792px }`): a
       `color: transparent; font-size: 1px` marker span DOES survive in the
       PDF's text layer, including with the Worker's `user-select: none` +
       `aria-hidden="true"` added on top, and it matched even in raw
       (non-whitespace-stripped) extracted text -- vertical writing did not
       fragment it. `display:none`, `visibility:hidden`, `opacity:0`,
       `font-size:0`, and collapsing the box to zero size were all
       confirmed to strip the text instead, which is why the marker uses
       the transparent/1px approach specifically. That said, this was a
       local test against a specific Chromium build -- production runs on
       Cloudflare Browser Rendering, a different Chromium build, so it is
       not a guarantee for every document there. The discard-everything
       behavior below exists precisely for the case where markers are
       nonetheless dropped: if NOT A SINGLE chapter is located this way,
       marker detection is treated as broken for this document and
       name-based fallback is skipped altogether -- trusting it anyway
       risks binding every chapter to an early table-of-contents page that
       lists every chapter title in already-monotonic order, which would
       otherwise sail through the monotonic check below. In that case this
       returns [] (no chapter metadata), which is a strictly better outcome
       than a chapter table that is entirely wrong.

    2. Name-fallback pass (only reached when at least one marker was found
       above): each chapter without a marker hit is searched for by name,
       but the search window is restricted to strictly between its nearest
       marker-located neighbours (the closest preceding and following
       configured chapter that WAS found by marker) -- both a lower and an
       upper bound, not just "after the previous accepted chapter". This
       keeps an early table of contents out of the window whenever a real
       marker hit exists on either side of the gap.

    Finally, a monotonic pass drops any chapter (marker- or name-located)
    whose page does not strictly increase over the previous *accepted*
    chapter's page, as a last-resort safety net.

    Returns [{"name": str, "start_page": int}, ...] for the located
    chapters only, still in chapter order."""
    if not chapters or pymupdf is None:
        return []
    try:
        with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
            page_texts = [normalize_search_text(page.get_text()) for page in doc]
    except Exception:  # noqa: BLE001 - detection is optional, never fatal
        logger.exception("failed to read PDF text for chapter detection")
        return []

    def find_first(needle: str, start: int, end: int) -> int | None:
        """First page index in [start, end] (inclusive) whose text contains
        needle, or None. An inverted range (start > end) never matches."""
        for i in range(max(start, 0), min(end, len(page_texts) - 1) + 1):
            if needle in page_texts[i]:
                return i
        return None

    marker_hits: list[int | None] = []
    for chapter in chapters:
        marker = normalize_search_text(chapter.get("marker") or "")
        marker_hits.append(find_first(marker, 0, len(page_texts) - 1) if marker else None)

    if not any(hit is not None for hit in marker_hits):
        logger.warning(
            "chapter detection: marker matched none of the %d configured "
            "chapters; discarding name-based fallback matches entirely and "
            "proceeding without chapter metadata (marker detection appears "
            "broken for this document -- e.g. Chromium may have dropped the "
            "invisible marker spans from the PDF text layer -- so trusting "
            "name-only matches risks binding every chapter to an unrelated "
            "page, such as an early table of contents)",
            len(chapters),
        )
        return []

    candidates: list[int | None] = []
    for index, chapter in enumerate(chapters):
        if marker_hits[index] is not None:
            candidates.append(marker_hits[index])
            continue
        needle_name = normalize_search_text(chapter["name"])
        if not needle_name:
            candidates.append(None)
            continue
        # Bound the search to strictly between the nearest marker-located
        # neighbours on either side (by configured chapter order, not by
        # page number) -- an unbounded search would happily match an early
        # table of contents that lists this chapter's name too.
        lower = next((h for h in reversed(marker_hits[:index]) if h is not None), None)
        upper = next((h for h in marker_hits[index + 1 :] if h is not None), None)
        start = lower + 1 if lower is not None else 0
        end = upper - 1 if upper is not None else len(page_texts) - 1
        candidates.append(find_first(needle_name, start, end) if start <= end else None)

    located: list[dict] = []
    last_page = -1
    for chapter, page_index in zip(chapters, candidates):
        name = chapter["name"]
        if page_index is None:
            logger.info("chapter %r: not found by marker or name; skipping", name)
            continue
        if page_index <= last_page:
            logger.warning(
                "chapter %r: detected page %d does not follow previous "
                "chapter's page %d; skipping as a likely false match",
                name,
                page_index,
                last_page,
            )
            continue

        located.append({"name": name, "start_page": page_index})
        last_page = page_index

    logger.info("chapter detection: found %d/%d chapters", len(located), len(chapters))
    return located


def build_chapter_entries(located: list[dict], total_pages: int) -> list[dict]:
    """Turns detect_chapter_pages' {"name", "start_page"} results into
    {"name", "start_page", "end_page"} triples for the XTC chapter table:
    each chapter's end_page is the next chapter's start_page - 1 (inclusive
    end), and the last chapter's end_page is total_pages - 1. Entries whose
    start_page/end_page would not fit a uint16 are dropped (and logged) --
    should not happen in practice (total_pages already bounds them) but the
    XTC chapter entry format cannot represent anything else. Chapter names
    are truncated to a UTF-8-safe MAX_CHAPTER_NAME_BYTES here, once, right
    before their only consumer (the TOML chapters block); a name containing
    an unpaired UTF-16 surrogate (json.loads happily decodes one from a
    header into a plain str, even though it can never be UTF-8 encoded) also
    drops just that chapter here, rather than raising all the way out to
    Handler.do_POST and failing the whole conversion -- chapters are always
    best-effort, never a hard requirement for a successful conversion, same
    as every other drop-and-log case in this module."""
    entries: list[dict] = []
    for index, chapter in enumerate(located):
        start_page = chapter["start_page"]
        if index + 1 < len(located):
            end_page = located[index + 1]["start_page"] - 1
        else:
            end_page = total_pages - 1
        if not (0 <= start_page <= 0xFFFF and 0 <= end_page <= 0xFFFF):
            logger.warning(
                "chapter %r: start_page=%d end_page=%d out of uint16 range; "
                "skipping",
                chapter["name"],
                start_page,
                end_page,
            )
            continue
        try:
            name = truncate_utf8_bytes(chapter["name"], MAX_CHAPTER_NAME_BYTES)
        except UnicodeError:
            logger.warning(
                "chapter %r: name cannot be encoded as UTF-8 (e.g. an "
                "unpaired surrogate); skipping",
                chapter["name"],
            )
            continue
        entries.append({"name": name, "start_page": start_page, "end_page": end_page})
    return entries


def resolve_chapters(
    pdf_bytes: bytes, chapters_spec: list[dict[str, str]], page_count: int | None
) -> list[dict]:
    """End-to-end: chapters_spec (decode_chapters_header's decoded
    X-Xtc-Chapters entries) -> located page numbers -> final
    {"name", "start_page", "end_page"} entries ready for the TOML
    [[chapters]] block (see _toml_chapters_block). Returns [] (no chapter
    metadata; the conversion proceeds exactly as it did before this feature
    existed) when chapters_spec is empty, the page count is unknown, or
    detection located zero chapters -- chapters are always best-effort,
    never a hard requirement for a successful conversion."""
    if not chapters_spec:
        return []
    if not page_count:
        logger.warning(
            "X-Xtc-Chapters present but page count is unavailable; "
            "skipping chapter metadata"
        )
        return []
    located = detect_chapter_pages(pdf_bytes, chapters_spec)
    if not located:
        return []
    return build_chapter_entries(located, page_count)


def _toml_value(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        # JSON string escaping is a valid TOML basic string for our values.
        return json.dumps(value, ensure_ascii=False)
    raise ValueError(f"unsupported TOML value type: {type(value).__name__}")


def _toml_chapters_block(chapters: list[dict]) -> str:
    """Serializes resolved chapter entries ({"name", "start_page",
    "end_page"} dicts, see build_chapter_entries) as TOML [[chapters]]
    array-of-tables text. Kept separate from _toml_value -- which only ever
    serializes a table's scalar values -- because a list[dict] is a
    structurally different shape that function was never meant to handle.
    xtctool's cli/convert.py write_xtc (see xtctool-chapters.patch) reads
    this table array back as cfg['chapters'] and turns each entry into an
    XTCChapter passed to XTCWriter."""
    lines = []
    for chapter in chapters:
        lines.append("[[chapters]]")
        lines.append(f"name = {_toml_value(chapter['name'])}")
        lines.append(f"start_page = {_toml_value(chapter['start_page'])}")
        lines.append(f"end_page = {_toml_value(chapter['end_page'])}")
        lines.append("")
    return "\n".join(lines)


def config_with_title_author_chapters(
    title: str, author: str = "", chapters: list[dict] | None = None
) -> str:
    """TOML text of CONFIG_PATH with [output].title (and, when given,
    [output].author) overridden, plus -- when chapters is given -- a
    [[chapters]] array-of-tables appended (see _toml_chapters_block).
    xtctool embeds all of these into the XTC container: title/author via
    XTCMetadata as before, chapters via the XTCChapter list cli/convert.py's
    write_xtc now builds from cfg['chapters'] (see xtctool-chapters.patch).

    author defaults to "" and, when empty, is left untouched -- CONFIG_PATH's
    own [output].author (config-x3.toml: "") governs, exactly as before this
    parameter existed. This keeps /convert's existing callers (Browser-Run
    PDFs from URL conversions, which never have an author) byte-for-byte
    unaffected; only the TXT-upload pipeline (src/workflow.ts, via the
    X-Xtc-Author request header decoded in _handle_convert below) ever passes
    a non-empty author. chapters is likewise only ever non-empty when
    X-Xtc-Chapters was present and resolve_chapters located at least one
    chapter -- every existing caller (no header, or a header that resolves
    to zero chapters) stays unaffected the same way."""
    with open(CONFIG_PATH, "rb") as f:
        config = tomllib.load(f)
    output = config.setdefault("output", {})
    output["title"] = title
    if author:
        output["author"] = author
    lines = []
    for table, values in config.items():
        lines.append(f"[{table}]")
        for key, value in values.items():
            lines.append(f"{key} = {_toml_value(value)}")
        lines.append("")
    if chapters:
        lines.append(_toml_chapters_block(chapters))
    return "\n".join(lines)


def config_with_title_author(title: str, author: str = "") -> str:
    """Backward-compatible alias for config_with_title_author_chapters(title,
    author, None). Kept as its own name since it is part of this module's
    tested surface (test/converter/test_app.py) and is still the only path
    used whenever no chapter metadata is involved."""
    return config_with_title_author_chapters(title, author)


def config_with_title(title: str) -> str:
    """Backward-compatible alias for config_with_title_author(title, "").
    Kept as its own name since it is part of this module's tested surface
    (test/converter/test_app.py)."""
    return config_with_title_author(title)


def _run_xtctool(
    sources: list[str],
    out_path: Path,
    config_path: str,
    timeout_seconds: float,
    total_timeout_seconds: int,
    stage: str,
) -> None:
    """Run one `xtctool convert` invocation and validate its output file.

    timeout_seconds is the remaining share of the request's total budget
    (total_timeout_seconds), which is what error messages report."""
    if timeout_seconds <= 0:
        raise ConversionError(f"conversion timed out after {total_timeout_seconds}s")
    command = ["xtctool", "convert", *sources, "-o", str(out_path), "-c", config_path]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ConversionError(
            f"conversion timed out after {total_timeout_seconds}s ({stage})"
        ) from exc

    if result.returncode != 0:
        raise ConversionError(
            f"xtctool exited with code {result.returncode} ({stage})",
            stderr=result.stderr,
        )
    if not out_path.is_file():
        raise ConversionError(
            f"xtctool reported success but produced no output ({stage})",
            stderr=result.stderr,
        )
    if out_path.stat().st_size == 0:
        raise ConversionError(
            f"xtctool reported success but produced an empty output file ({stage})",
            stderr=result.stderr,
        )


# Sentinel distinguishing "caller did not count pages" (count them here) from
# an explicit page_count=None ("counting already failed; do not parse again").
_UNCOUNTED = object()


def convert_pdf(
    pdf_bytes: bytes,
    title: str = "",
    timeout_seconds: int = CONVERT_TIMEOUT_SECONDS,
    page_count: int | None | object = _UNCOUNTED,
    author: str = "",
    chapters: list[dict] | None = None,
) -> bytes:
    """Run xtctool over the given PDF bytes and return the XTC bytes.

    PDFs longer than CHUNK_THRESHOLD_PAGES are converted sequentially in
    CHUNK_SIZE_PAGES page-range chunks and the chunk XTCs repacked into one
    container, keeping peak memory proportional to the chunk size instead of
    the full document (xtctool preloads every selected page as a PIL image).
    The repacked output is byte-identical to a single-pass conversion.
    timeout_seconds is the total budget across all chunks plus the repack.

    author is only ever non-empty for the TXT-upload pipeline (see
    _handle_convert's X-Xtc-Author handling below) -- the trusted /convert
    path has no other source for it, unlike title (read from the PDF's own
    metadata).

    chapters is resolve_chapters' output: already-resolved
    {"name", "start_page", "end_page"} entries with document-absolute page
    numbers, or [] when there is nothing to embed. It is passed to xtctool
    only on the FINAL invocation (the single-pass call below, or the
    chunk-repack call in the chunked branch) -- never on a per-chunk call.
    Embedding it into intermediate chunk XTCs would be wasted work: those
    files are discarded once the repack step produces the final container,
    and the repack step re-derives all container metadata (title, author,
    chapters) from its own config file rather than from the input chunk
    XTCs' metadata."""
    deadline = time.monotonic() + timeout_seconds
    with tempfile.TemporaryDirectory() as workdir:
        pdf_path = Path(workdir) / "source.pdf"
        xtc_path = Path(workdir) / "output.xtc"
        pdf_path.write_bytes(pdf_bytes)

        config_path = CONFIG_PATH
        if title or author:
            try:
                merged = config_with_title_author(title, author)
            except Exception:  # noqa: BLE001 - metadata must never block conversion
                logger.exception("config title merge failed; using base config")
            else:
                merged_path = Path(workdir) / "config.toml"
                merged_path.write_text(merged, encoding="utf-8")
                config_path = str(merged_path)

        # See the chapters parameter's docstring above for why this is a
        # separate config, used only for the final xtctool invocation.
        final_config_path = config_path
        if chapters:
            try:
                merged_with_chapters = config_with_title_author_chapters(
                    title, author, chapters
                )
            except Exception:  # noqa: BLE001 - metadata must never block conversion
                logger.exception(
                    "chapters config merge failed; omitting chapter metadata"
                )
            else:
                chapters_config_path = Path(workdir) / "config-chapters.toml"
                chapters_config_path.write_text(
                    merged_with_chapters, encoding="utf-8"
                )
                final_config_path = str(chapters_config_path)

        if page_count is _UNCOUNTED:
            page_count = count_pdf_pages(pdf_bytes)
        if page_count is None or page_count <= CHUNK_THRESHOLD_PAGES:
            # A single subprocess gets the whole budget, exactly as before
            # chunking existed.
            _run_xtctool(
                [str(pdf_path)],
                xtc_path,
                final_config_path,
                timeout_seconds,
                timeout_seconds,
                "single-pass",
            )
            return xtc_path.read_bytes()

        # Chunks run sequentially on purpose: parallel chunks inside one
        # instance would multiply peak memory and defeat the point. Cross-
        # request parallelism stays bounded by CONVERSION_SLOTS.
        ranges = [
            (start, min(start + CHUNK_SIZE_PAGES - 1, page_count))
            for start in range(1, page_count + 1, CHUNK_SIZE_PAGES)
        ]
        logger.info(
            "chunked conversion: %d pages in %d chunks of up to %d pages",
            page_count,
            len(ranges),
            CHUNK_SIZE_PAGES,
        )
        chunk_paths: list[Path] = []
        for index, (start, end) in enumerate(ranges, 1):
            chunk_path = Path(workdir) / f"chunk{index:04d}.xtc"
            _run_xtctool(
                [f"{pdf_path}:{start}-{end}"],
                chunk_path,
                config_path,
                deadline - time.monotonic(),
                timeout_seconds,
                f"chunk {index}/{len(ranges)} pages {start}-{end}",
            )
            logger.info(
                "chunk %d/%d (pages %d-%d) converted", index, len(ranges), start, end
            )
            chunk_paths.append(chunk_path)

        # Repack the chunk XTCs into the final container; the config (with the
        # merged title/author/chapters, when present) supplies the output
        # metadata -- see the chapters parameter's docstring above for why
        # this is final_config_path rather than the per-chunk config_path.
        _run_xtctool(
            [str(path) for path in chunk_paths],
            xtc_path,
            final_config_path,
            deadline - time.monotonic(),
            timeout_seconds,
            f"repack of {len(chunk_paths)} chunks",
        )
        logger.info("chunked conversion complete: %d pages", page_count)
        return xtc_path.read_bytes()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 60  # per-socket-read timeout; conversions run off-socket

    def _send_json(self, status: int, payload: dict, close: bool = False) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, payload: bytes, title: str = "") -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(payload)))
        if title:
            # Headers are Latin-1 only; the Worker percent-decodes this back.
            self.send_header("X-Xtc-Title", urllib.parse.quote(title, safe=""))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        with ACTIVE_REQUESTS:
            if self.path == "/healthz":
                self._send_json(200, {"status": "ok"})
            else:
                self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        with ACTIVE_REQUESTS:
            self._handle_post()

    def _handle_post(self) -> None:
        if self.path == "/convert":
            self._handle_convert()
        elif self.path == "/convert/uploaded-pdf":
            # Deferred import: pdf_upload imports this module at its own top
            # level to reuse _run_xtctool/_toml_value/sanitize_title/etc., so
            # importing it eagerly here (at module load time) would create an
            # import cycle. By the time a request arrives the server is fully
            # started and app.py has finished loading, so this is safe and
            # only pays the sys.modules lookup cost per request.
            import pdf_upload

            pdf_upload.handle_uploaded_pdf_request(self)
        else:
            self._send_json(404, {"error": "not found"})

    def _handle_convert(self) -> None:
        """POST /convert: PDF bytes produced by our own Browser Run pipeline.
        Trusted input only -- do not point untrusted/user-uploaded PDFs at
        this handler. See pdf_upload.py for the untrusted-input path."""
        raw_length = self.headers.get("Content-Length")
        if raw_length is None or raw_length.strip() == "":
            self._send_json(
                400, {"error": "request body (PDF bytes) is required"}, close=True
            )
            return
        try:
            content_length = int(raw_length)
        except ValueError:
            self._send_json(400, {"error": "invalid Content-Length"}, close=True)
            return
        if content_length <= 0:
            self._send_json(
                400, {"error": "request body (PDF bytes) is required"}, close=True
            )
            return
        max_pdf_bytes = effective_max_pdf_bytes(self.headers)
        if content_length > max_pdf_bytes:
            # Body is never read, so the connection cannot be reused.
            self._send_json(
                413,
                {"error": f"request body exceeds the {max_pdf_bytes} byte limit"},
                close=True,
            )
            return

        # The Worker aborts its fetch after a per-request budget; honour that
        # here so a slow conversion cannot pin a CONVERSION_SLOTS slot for the
        # full CONVERT_TIMEOUT_SECONDS ceiling. Missing/invalid headers fall
        # back to that ceiling, which also stays the absolute upper bound.
        timeout_seconds = CONVERT_TIMEOUT_SECONDS
        raw_timeout = self.headers.get("X-Convert-Timeout-Seconds")
        if raw_timeout:
            try:
                requested = int(raw_timeout)
            except ValueError:
                requested = 0
            if requested > 0:
                timeout_seconds = max(1, min(requested, CONVERT_TIMEOUT_SECONDS))

        try:
            pdf_bytes = self.rfile.read(content_length)
            if len(pdf_bytes) != content_length:
                self._send_json(400, {"error": "truncated request body"}, close=True)
                return
            # Title extraction opens the PDF in memory too, so keep it inside
            # the slot to bound total concurrent PDF work. Trade-off: unlike
            # convert_pdf, extract_pdf_title has no timeout (pymupdf runs in-
            # process and cannot be cancelled), so a pathological parse holds
            # the slot until it returns. Acceptable here because the input is
            # always a PDF we rendered ourselves via Chromium, not arbitrary
            # client bytes.
            # X-Xtc-Author (spec: text-upload §16/§10): only ever sent by the
            # TXT-upload pipeline (src/workflow.ts), base64url UTF-8 encoded
            # like X-Pdf-Options/X-Source-Filename on the uploaded-pdf path.
            # Absent for every other /convert caller, which is the pre-
            # existing behavior (author stays config-x3.toml's own "").
            raw_author = self.headers.get("X-Xtc-Author")
            author = decode_base64url_utf8(raw_author) if raw_author else ""
            # X-Xtc-Chapters (optional): base64url JSON array of
            # {"name","marker"}, in chapter order -- see this module's
            # docstring and decode_chapters_header/resolve_chapters for the
            # header format and the detection contract. Decoding here is
            # cheap (JSON parse of a short header); the actual page-detection
            # pass over the PDF's text only happens inside resolve_chapters
            # below, and only when this list is non-empty.
            raw_chapters = self.headers.get("X-Xtc-Chapters")
            chapters_spec = decode_chapters_header(raw_chapters) if raw_chapters else []

            with CONVERSION_SLOTS:
                # Single pymupdf pass supplies both the title and the page
                # count convert_pdf uses for its chunking decision.
                title, page_count = read_pdf_metadata(pdf_bytes)
                # A second pymupdf pass (full-document text extraction) only
                # runs when chapters were actually requested -- every other
                # /convert caller pays nothing extra, and effective_timeout_
                # seconds below stays exactly timeout_seconds (unaffected).
                #
                # convert_pdf computes its own deadline as
                # time.monotonic() + (the timeout_seconds it's given),
                # starting fresh from the moment it's called -- so any time
                # already spent here, before convert_pdf even starts, must
                # be subtracted from the budget handed to it, or it would be
                # granted for free on top of the Worker's
                # X-Convert-Timeout-Seconds (which has no way to know this
                # extra pass happened).
                if chapters_spec:
                    detection_start = time.monotonic()
                    chapters = resolve_chapters(pdf_bytes, chapters_spec, page_count)
                    elapsed = time.monotonic() - detection_start
                    effective_timeout_seconds = max(0.0, timeout_seconds - elapsed)
                else:
                    chapters = []
                    effective_timeout_seconds = timeout_seconds
                xtc_bytes = convert_pdf(
                    pdf_bytes,
                    title,
                    effective_timeout_seconds,
                    page_count,
                    author,
                    chapters,
                )
        except ConversionError as exc:
            logger.error("conversion failed: %s; stderr: %s", exc, exc.stderr)
            self._send_json(500, {"error": str(exc)})
        except Exception:  # noqa: BLE001 - a response must always go out
            logger.exception("unexpected error while handling /convert")
            self._send_json(500, {"error": "internal error"}, close=True)
        else:
            self._send_bytes(xtc_bytes, title)

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        logger.info("%s - %s", self.address_string(), format % args)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)

    def handle_sigterm(signum, frame) -> None:  # noqa: ARG001
        logger.info("SIGTERM received; shutting down")
        # shutdown() blocks until serve_forever() exits, so it must run on a
        # different thread than the serve_forever() loop this handler
        # interrupted.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, handle_sigterm)

    logger.info("listening on :%d", PORT)
    try:
        server.serve_forever()
    finally:
        # Drain in-flight conversions before the process exits.
        if not ACTIVE_REQUESTS.wait_idle(timeout=CONVERT_TIMEOUT_SECONDS + 10):
            logger.warning("shutdown drain timed out; exiting with active requests")
        server.server_close()
        logger.info("shutdown complete")


if __name__ == "__main__":
    main()
