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
MAX_CONCURRENT_CONVERSIONS = int(os.environ.get("MAX_CONCURRENT_CONVERSIONS", "2"))

logger = logging.getLogger("converter")

if pymupdf is None:  # pragma: no cover - always present in the container image
    logger.warning("pymupdf is unavailable; PDF title extraction is disabled")

# Bounds concurrent xtctool subprocesses (each rasterizes a whole PDF into
# memory); excess requests queue on their handler threads.
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


class ConversionError(Exception):
    def __init__(self, message: str, stderr: str = "") -> None:
        super().__init__(message)
        self.stderr = stderr


# Matches MAX_TITLE_CHARS in src/jobs.ts; xtctool itself truncates the XTC
# metadata title to 127 UTF-8 bytes on write.
MAX_TITLE_CHARS = 100


def extract_pdf_title(pdf_bytes: bytes) -> str:
    """Best-effort read of the PDF /Title metadata (Chromium's print-to-PDF
    stores the page <title> there). Returns "" when unavailable."""
    if pymupdf is None:
        return ""
    try:
        with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
            title = (doc.metadata or {}).get("title") or ""
    except Exception:  # noqa: BLE001 - metadata is optional, never fatal
        logger.exception("failed to read PDF title metadata")
        return ""
    # Collapse whitespace/control characters and cap the length.
    title = "".join(" " if ord(c) < 0x20 or ord(c) == 0x7F else c for c in title)
    title = " ".join(title.split())
    return title[:MAX_TITLE_CHARS].strip()


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


def convert_pdf(pdf_bytes: bytes, title: str = "") -> bytes:
    """Run xtctool over the given PDF bytes and return the XTC bytes."""
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

        command = [
            "xtctool",
            "convert",
            str(pdf_path),
            "-o",
            str(xtc_path),
            "-c",
            config_path,
        ]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=CONVERT_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise ConversionError(
                f"conversion timed out after {CONVERT_TIMEOUT_SECONDS}s"
            ) from exc

        if result.returncode != 0:
            raise ConversionError(
                f"xtctool exited with code {result.returncode}",
                stderr=result.stderr,
            )
        if not xtc_path.is_file():
            raise ConversionError(
                "xtctool reported success but produced no output",
                stderr=result.stderr,
            )
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
        if content_length > MAX_PDF_BYTES:
            # Body is never read, so the connection cannot be reused.
            self._send_json(
                413,
                {"error": f"request body exceeds the {MAX_PDF_BYTES} byte limit"},
                close=True,
            )
            return

        try:
            pdf_bytes = self.rfile.read(content_length)
            if len(pdf_bytes) != content_length:
                self._send_json(400, {"error": "truncated request body"}, close=True)
                return
            title = extract_pdf_title(pdf_bytes)
            with CONVERSION_SLOTS:
                xtc_bytes = convert_pdf(pdf_bytes, title)
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
