# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 aGFydWtp

"""HTTP wrapper around the xtctool CLI. Standard library only, except for an
optional pymupdf import (shipped with xtctool) used to read PDF metadata.

POST /convert  request body = PDF bytes -> response body = XTC bytes
               (X-Xtc-Title response header carries the PDF title,
                UTF-8 percent-encoded, when one could be extracted)
GET  /healthz  liveness probe

Error responses carry generic JSON messages; xtctool stderr and tracebacks go
to the process log only.
"""

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


# xtctool rasterizes every selected page into memory before packing (~1.7MB
# per page measured), so long PDFs are converted in page-range chunks and the
# chunk XTCs are repacked into the final container. PDFs at or below the
# threshold use the original single-pass conversion.
CHUNK_THRESHOLD_PAGES = _positive_env_int("XTC_CHUNK_THRESHOLD_PAGES", 150)
CHUNK_SIZE_PAGES = _positive_env_int("XTC_CHUNK_SIZE_PAGES", 100)

if pymupdf is None:  # pragma: no cover - always present in the container image
    logger.warning("pymupdf is unavailable; PDF title extraction is disabled")

# Bounds concurrent xtctool subprocesses (each rasterizes up to
# CHUNK_THRESHOLD_PAGES, or one chunk of a long PDF, into memory); excess
# requests queue on their handler threads. Two concurrent chunked conversions
# of the 665-page reference PDF peak at ~750MiB total (measured under
# docker --memory=1g), leaving ~27% headroom on a basic (1GiB) instance, so
# the chunked path needs no extra serialization beyond this semaphore.
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
    # Collapse whitespace/control characters and cap the length.
    title = "".join(" " if ord(c) < 0x20 or ord(c) == 0x7F else c for c in title)
    title = " ".join(title.split())
    return title[:MAX_TITLE_CHARS].strip(), page_count


def extract_pdf_title(pdf_bytes: bytes) -> str:
    """PDF /Title metadata, or "" when unavailable."""
    return read_pdf_metadata(pdf_bytes)[0]


def count_pdf_pages(pdf_bytes: bytes) -> int | None:
    """Page count of the PDF, or None when it cannot be determined."""
    return read_pdf_metadata(pdf_bytes)[1]


def _toml_value(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        # JSON string escaping is a valid TOML basic string for our values.
        return json.dumps(value, ensure_ascii=False)
    raise ValueError(f"unsupported TOML value type: {type(value).__name__}")


def config_with_title(title: str) -> str:
    """TOML text of CONFIG_PATH with [output].title overridden, so xtctool
    embeds the page title into the XTC container metadata."""
    with open(CONFIG_PATH, "rb") as f:
        config = tomllib.load(f)
    config.setdefault("output", {})["title"] = title
    lines = []
    for table, values in config.items():
        lines.append(f"[{table}]")
        for key, value in values.items():
            lines.append(f"{key} = {_toml_value(value)}")
        lines.append("")
    return "\n".join(lines)


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
) -> bytes:
    """Run xtctool over the given PDF bytes and return the XTC bytes.

    PDFs longer than CHUNK_THRESHOLD_PAGES are converted sequentially in
    CHUNK_SIZE_PAGES page-range chunks and the chunk XTCs repacked into one
    container, keeping peak memory proportional to the chunk size instead of
    the full document (xtctool preloads every selected page as a PIL image).
    The repacked output is byte-identical to a single-pass conversion.
    timeout_seconds is the total budget across all chunks plus the repack."""
    deadline = time.monotonic() + timeout_seconds
    with tempfile.TemporaryDirectory() as workdir:
        pdf_path = Path(workdir) / "source.pdf"
        xtc_path = Path(workdir) / "output.xtc"
        pdf_path.write_bytes(pdf_bytes)

        config_path = CONFIG_PATH
        if title:
            try:
                merged = config_with_title(title)
            except Exception:  # noqa: BLE001 - metadata must never block conversion
                logger.exception("config title merge failed; using base config")
            else:
                merged_path = Path(workdir) / "config.toml"
                merged_path.write_text(merged, encoding="utf-8")
                config_path = str(merged_path)

        if page_count is _UNCOUNTED:
            page_count = count_pdf_pages(pdf_bytes)
        if page_count is None or page_count <= CHUNK_THRESHOLD_PAGES:
            # A single subprocess gets the whole budget, exactly as before
            # chunking existed.
            _run_xtctool(
                [str(pdf_path)],
                xtc_path,
                config_path,
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
        # merged title, when present) supplies the output metadata.
        _run_xtctool(
            [str(path) for path in chunk_paths],
            xtc_path,
            config_path,
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
        if self.path != "/convert":
            self._send_json(404, {"error": "not found"})
            return

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
            with CONVERSION_SLOTS:
                # Single pymupdf pass supplies both the title and the page
                # count convert_pdf uses for its chunking decision.
                title, page_count = read_pdf_metadata(pdf_bytes)
                xtc_bytes = convert_pdf(pdf_bytes, title, timeout_seconds, page_count)
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
