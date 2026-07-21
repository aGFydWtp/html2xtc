# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 aGFydWtp

"""POST /convert/uploaded-pdf: converts an arbitrary, untrusted, user-uploaded
PDF into an XTC for the Xteink X3, honouring a PdfConvertOptions payload
(page selection, rotation, crop, contain/cover fit, margin, threshold,
invert, dithering).

Unlike app.py's /convert (which only ever sees PDFs this system rendered
itself via Browser Run), the input here is attacker-controlled: it may be
oversized, malformed, encrypted, or crafted to exhaust memory/CPU. Every
validation step in this module exists to defend against that, and none of
it is optional:

  - the body is streamed to a fixed-name temp file in 1 MiB chunks, never
    held in memory as a whole (see _receive_body_to_file);
  - the PDF magic, encryption flag, and page count are checked before any
    page is rendered;
  - page images are produced and packed into the XTC in bounded-size chunks
    (see _convert_in_chunks) so peak memory stays roughly constant
    regardless of how many pages were selected;
  - every temporary path is a fixed name inside a tempfile-managed
    directory -- nothing derived from request headers (filename, options)
    ever reaches a filesystem path or a subprocess argv used for path
    purposes.

Response bodies are generic JSON on error (self.error). Tracebacks, xtctool
stderr, and any other implementation detail go to the process log only, via
`logger`, matching app.py's existing convention.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import threading
import time
import tomllib
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image

# app.py never imports this module at its own top level (only lazily, inside
# Handler._handle_post, once the server is already running), so this import
# can never race a partially-initialized `app` module -- see the comment in
# app.py's _handle_post for the full explanation.
import app

logger = logging.getLogger("converter")

# --- limits (env-overridable; see the Dockerfile/deploy config for the
# operational defaults) ------------------------------------------------------

# 50331648 = 48 MiB, matching the spec's default exactly.
MAX_UPLOAD_PDF_BYTES = app._positive_env_int("MAX_UPLOAD_PDF_BYTES", 48 * 1024 * 1024)
MAX_SOURCE_PDF_PAGES = app._positive_env_int("MAX_SOURCE_PDF_PAGES", 1000)
MAX_SELECTED_PDF_PAGES = app._positive_env_int("MAX_SELECTED_PDF_PAGES", 700)
PDF_RENDER_DPI = app._positive_env_int("PDF_RENDER_DPI", 200)
PDF_UPLOAD_CHUNK_SIZE_PAGES = app._positive_env_int("PDF_UPLOAD_CHUNK_SIZE_PAGES", 100)

# Defense-in-depth ceiling on the Worker-supplied X-Convert-Timeout-Seconds,
# mirroring app.HARD_MAX_PDF_BYTES's role for X-Max-Pdf-Bytes: the Worker
# owns the authoritative per-request budget (its Workflow step timeout is 12
# minutes per the spec), but a compromised/misconfigured Worker must not be
# able to pin a conversion slot indefinitely.
HARD_MAX_UPLOAD_TIMEOUT_SECONDS = app._positive_env_int(
    "PDF_UPLOAD_HARD_MAX_TIMEOUT_SECONDS", 900
)

# Separate from app.CONVERSION_SLOTS on purpose: uploaded-PDF conversions are
# untrusted, chunked, and can run far longer than the Browser-Run-sourced
# /convert path. Sharing one semaphore would let a burst of large uploads
# starve the trusted URL-conversion path (and vice versa) on the same
# instance. Default is deliberately conservative (1) since a single chunked
# conversion can already approach the instance's memory budget; raise via env
# once real memory measurements for this pipeline are available.
MAX_CONCURRENT_UPLOADED_PDF_CONVERSIONS = app._positive_env_int(
    "MAX_CONCURRENT_UPLOADED_PDF_CONVERSIONS", 1
)
UPLOADED_PDF_CONVERSION_SLOTS = threading.Semaphore(
    MAX_CONCURRENT_UPLOADED_PDF_CONVERSIONS
)

OUTPUT_CANVAS_DEFAULT = (528, 792)

_ALLOWED_CONTENT_TYPES = {"application/pdf", "application/x-pdf"}
_PDF_MAGIC = b"%PDF-"
_MAGIC_SEARCH_WINDOW = 1024
_RECEIVE_CHUNK_SIZE = 1024 * 1024  # 1 MiB, per spec 11.3


class PdfUploadError(Exception):
    """Carries the HTTP status this request must fail with, plus a client-
    facing generic message and an optional, more detailed message for the
    server log only (never sent to the client -- see module docstring).

    `code` is a stable, machine-readable identifier (e.g. "encrypted_pdf")
    that travels alongside `message` in the JSON error response. Unlike
    `message` -- which stays deliberately generic/free-text and is not a
    contract -- `code` is what src/workflow.ts matches on to pick a
    condition-specific NonRetryableError, which frontend/src/lib/i18n.svelte.ts's
    serverErrorText() then maps to a localized string (spec 14.2). It never
    carries internal exception detail, same as `message`."""

    def __init__(
        self,
        status: int,
        message: str,
        log_message: str | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.log_message = log_message or message
        self.code = code


# Fallback code by HTTP status, used when a raise site didn't set one
# explicitly. Keeps handle_uploaded_pdf_request's response always carrying a
# `code` field even for less-common/protocol-level failures.
_DEFAULT_CODE_BY_STATUS: dict[int, str] = {
    400: "bad_request",
    413: "pdf_too_large",
    415: "not_pdf",
    422: "unsupported_pdf",
    500: "convert_failed",
    503: "service_busy",
}


def _error_code(exc: "PdfUploadError") -> str:
    return exc.code or _DEFAULT_CODE_BY_STATUS.get(exc.status, "error")


# --- PdfConvertOptions -------------------------------------------------------


@dataclass(frozen=True)
class Crop:
    top: float
    right: float
    bottom: float
    left: float


@dataclass(frozen=True)
class PdfConvertOptions:
    pages: str
    rotation: int
    crop: Crop
    fit: str
    margin_px: int
    threshold: int
    dither: bool
    dither_strength: float
    invert: bool


DEFAULT_PDF_OPTIONS: dict[str, Any] = {
    "pages": "1-",
    "rotation": 0,
    "crop": {"top": 0, "right": 0, "bottom": 0, "left": 0},
    "fit": "contain",
    "marginPx": 0,
    "threshold": 128,
    "dither": True,
    "ditherStrength": 0.8,
    "invert": False,
}

_ALLOWED_ROTATIONS = {0, 90, 180, 270}
_ALLOWED_FITS = {"contain", "cover"}


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def options_from_dict(data: dict) -> PdfConvertOptions:
    """Strict validation of a decoded PdfConvertOptions JSON object per spec
    section 5.3. Invalid values are never implicitly coerced -- any failure
    raises PdfUploadError(400). Unknown extra top-level fields are ignored
    (forward-compatible with future frontend additions)."""
    try:
        pages = data["pages"]
        rotation = data["rotation"]
        crop_data = data["crop"]
        fit = data["fit"]
        margin_px = data["marginPx"]
        threshold = data["threshold"]
        dither = data["dither"]
        dither_strength = data["ditherStrength"]
        invert = data["invert"]
    except (KeyError, TypeError) as exc:
        raise PdfUploadError(
            400, "invalid pdf options", f"pdf options missing field: {exc}",
            code="invalid_pdf_options",
        ) from exc

    if not isinstance(pages, str) or pages == "":
        raise PdfUploadError(
            400, "invalid pdf options", "pages must be a non-empty string",
            code="invalid_pdf_options",
        )

    if not _is_int(rotation) or rotation not in _ALLOWED_ROTATIONS:
        raise PdfUploadError(
            400, "invalid pdf options", f"invalid rotation: {rotation!r}",
            code="invalid_pdf_options",
        )

    if not isinstance(crop_data, dict):
        raise PdfUploadError(
            400, "invalid pdf options", "crop must be an object", code="invalid_pdf_options"
        )
    crop_values: dict[str, float] = {}
    for key in ("top", "right", "bottom", "left"):
        raw = crop_data.get(key)
        if not _is_number(raw) or not (0.0 <= float(raw) <= 0.4):
            raise PdfUploadError(
                400, "invalid pdf options", f"invalid crop.{key}: {raw!r}",
                code="invalid_pdf_options",
            )
        crop_values[key] = float(raw)
    if crop_values["left"] + crop_values["right"] >= 0.8:
        raise PdfUploadError(
            400, "invalid pdf options", "crop left+right must be under 0.8",
            code="invalid_pdf_options",
        )
    if crop_values["top"] + crop_values["bottom"] >= 0.8:
        raise PdfUploadError(
            400, "invalid pdf options", "crop top+bottom must be under 0.8",
            code="invalid_pdf_options",
        )

    if not isinstance(fit, str) or fit not in _ALLOWED_FITS:
        raise PdfUploadError(
            400, "invalid pdf options", f"invalid fit: {fit!r}", code="invalid_pdf_options"
        )

    if not _is_int(margin_px) or not (0 <= margin_px <= 64):
        raise PdfUploadError(
            400, "invalid pdf options", f"invalid marginPx: {margin_px!r}",
            code="invalid_pdf_options",
        )

    if not _is_int(threshold) or not (0 <= threshold <= 255):
        raise PdfUploadError(
            400, "invalid pdf options", f"invalid threshold: {threshold!r}",
            code="invalid_pdf_options",
        )

    if not isinstance(dither, bool):
        raise PdfUploadError(
            400, "invalid pdf options", f"invalid dither: {dither!r}", code="invalid_pdf_options"
        )

    if not _is_number(dither_strength) or not (0.0 <= float(dither_strength) <= 1.0):
        raise PdfUploadError(
            400, "invalid pdf options", f"invalid ditherStrength: {dither_strength!r}",
            code="invalid_pdf_options",
        )

    if not isinstance(invert, bool):
        raise PdfUploadError(
            400, "invalid pdf options", f"invalid invert: {invert!r}", code="invalid_pdf_options"
        )

    return PdfConvertOptions(
        pages=pages,
        rotation=rotation,
        crop=Crop(**crop_values),
        fit=fit,
        margin_px=margin_px,
        threshold=threshold,
        dither=dither,
        dither_strength=float(dither_strength),
        invert=invert,
    )


def _b64url_decode(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded)


def decode_pdf_options(raw_header: str | None) -> PdfConvertOptions:
    """Decodes X-Pdf-Options (base64url JSON). A missing/empty header falls
    back to DEFAULT_PDF_OPTIONS; a present-but-malformed header is a hard
    400 (it indicates a Worker/Container contract violation, not a benign
    absence)."""
    if not raw_header:
        return options_from_dict(DEFAULT_PDF_OPTIONS)
    try:
        decoded = _b64url_decode(raw_header)
        data = json.loads(decoded.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - any decode failure is a 400
        raise PdfUploadError(
            400, "invalid pdf options", f"X-Pdf-Options decode failed: {exc}",
            code="invalid_pdf_options",
        ) from exc
    if not isinstance(data, dict):
        raise PdfUploadError(
            400, "invalid pdf options", "X-Pdf-Options is not a JSON object",
            code="invalid_pdf_options",
        )
    return options_from_dict(data)


# --- filename -----------------------------------------------------------


def decode_source_filename(raw_header: str | None) -> str:
    """Decodes X-Source-Filename (base64url UTF-8) and sanitizes it per spec
    section 8.1/11.2. Used only for display and as an XTC title fallback --
    never as a filesystem path (see module docstring). Decode failure falls
    back to the default name rather than failing the request: the filename
    is cosmetic, unlike PdfConvertOptions which affects output correctness."""
    if not raw_header:
        return "document.pdf"
    try:
        decoded = _b64url_decode(raw_header).decode("utf-8")
    except Exception:  # noqa: BLE001 - filename is cosmetic, never fatal
        logger.warning("X-Source-Filename decode failed; using default filename")
        return "document.pdf"
    return _sanitize_filename(decoded)


def _sanitize_filename(raw: str) -> str:
    cleaned = "".join(ch for ch in raw if ord(ch) >= 0x20 and ch != "\x7f")
    cleaned = cleaned.replace("/", "").replace("\\", "")
    cleaned = unicodedata.normalize("NFC", cleaned).strip()
    cleaned = cleaned[:255]
    if not cleaned:
        return "document.pdf"
    if not cleaned.lower().endswith(".pdf"):
        cleaned = cleaned[: 255 - 4] + ".pdf"
    return cleaned


def _title_from_filename(filename: str) -> str:
    if filename.lower().endswith(".pdf"):
        return filename[:-4]
    return filename


# --- page range parsing (spec section 5.4) ----------------------------------

_RANGE_RE = re.compile(r"^(\d+)-(\d+)$")
_OPEN_START_RE = re.compile(r"^(\d+)-$")
_OPEN_END_RE = re.compile(r"^-(\d+)$")
_SINGLE_RE = re.compile(r"^(\d+)$")


def _check_bounds(page_number: int, total_pages: int, segment: str) -> None:
    if page_number < 1:
        raise PdfUploadError(
            422, "invalid page range", f"page {page_number} < 1 in segment {segment!r}",
            code="page_range_invalid",
        )
    if page_number > total_pages:
        raise PdfUploadError(
            422,
            "invalid page range",
            f"page {page_number} exceeds page count {total_pages} in segment {segment!r}",
            code="page_range_invalid",
        )


def _parse_segment(segment: str, total_pages: int) -> tuple[int, int]:
    match = _RANGE_RE.match(segment)
    if match:
        start, end = int(match.group(1)), int(match.group(2))
        _check_bounds(start, total_pages, segment)
        _check_bounds(end, total_pages, segment)
        if start > end:
            raise PdfUploadError(
                422, "invalid page range", f"reversed range {segment!r}",
                code="page_range_invalid",
            )
        return start, end

    match = _OPEN_START_RE.match(segment)
    if match:
        start = int(match.group(1))
        _check_bounds(start, total_pages, segment)
        return start, total_pages

    match = _OPEN_END_RE.match(segment)
    if match:
        end = int(match.group(1))
        _check_bounds(end, total_pages, segment)
        return 1, end

    match = _SINGLE_RE.match(segment)
    if match:
        page = int(match.group(1))
        _check_bounds(page, total_pages, segment)
        return page, page

    raise PdfUploadError(
        422, "invalid page range", f"malformed segment {segment!r}", code="page_range_invalid"
    )


def parse_page_range(spec: str, total_pages: int) -> list[int]:
    """Expands a pages spec (spec section 5.4) into a 1-indexed page list,
    preserving the order segments were specified in and dropping repeat
    occurrences of a page after its first appearance."""
    if not spec:
        raise PdfUploadError(
            422, "invalid page range", "empty pages spec", code="page_range_invalid"
        )

    result: list[int] = []
    seen: set[int] = set()
    for segment in spec.split(","):
        if segment == "":
            raise PdfUploadError(
                422, "invalid page range", f"empty segment in {spec!r}",
                code="page_range_invalid",
            )
        start, end = _parse_segment(segment, total_pages)
        for page in range(start, end + 1):
            if page not in seen:
                seen.add(page)
                result.append(page)

    if not result:
        # Syntactically valid (e.g. every referenced page exists) but expands
        # to zero pages -- can only happen via a completely empty spec, which
        # is caught above, so this is defensive. Distinct code from the
        # generic page_range_invalid: spec 14.2 gives it its own message
        # ("変換するページを1ページ以上選択してください。").
        raise PdfUploadError(
            422, "no pages selected", "no pages selected", code="no_pages_selected"
        )
    return result


# --- image pipeline (spec section 6, 11.5-11.8) ------------------------------

# Rotation is applied clockwise (the conventional meaning of "rotate this
# page N degrees" in scanning/viewer UIs). PIL's ROTATE_* transpose constants
# are counter-clockwise, so a clockwise rotation of N degrees is
# transpose(ROTATE_(360-N)).
_ROTATE_TRANSPOSE = {
    0: None,
    90: Image.ROTATE_270,
    180: Image.ROTATE_180,
    270: Image.ROTATE_90,
}


def _apply_rotation(image: Image.Image, rotation: int) -> Image.Image:
    transpose = _ROTATE_TRANSPOSE.get(rotation)
    if transpose is None:
        return image
    return image.transpose(transpose)


def _apply_crop(image: Image.Image, crop: Crop) -> Image.Image:
    width, height = image.size
    left = round(width * crop.left)
    top = round(height * crop.top)
    right = width - round(width * crop.right)
    bottom = height - round(height * crop.bottom)
    if right - left < 1 or bottom - top < 1:
        raise PdfUploadError(
            400,
            "invalid crop settings",
            f"crop leaves {right - left}x{bottom - top}px from {width}x{height}",
            code="invalid_pdf_options",
        )
    return image.crop((left, top, right, bottom))


def _place_on_canvas(
    image: Image.Image, fit: str, margin_px: int, canvas_size: tuple[int, int]
) -> Image.Image:
    canvas_w, canvas_h = canvas_size
    inner_w = canvas_w - 2 * margin_px
    inner_h = canvas_h - 2 * margin_px
    src_w, src_h = image.size

    canvas = Image.new("L", (canvas_w, canvas_h), 255)

    if fit == "contain":
        scale = min(inner_w / src_w, inner_h / src_h)
        new_w = max(1, round(src_w * scale))
        new_h = max(1, round(src_h * scale))
        resized = image.resize((new_w, new_h), Image.BOX)
        offset_x = margin_px + (inner_w - new_w) // 2
        offset_y = margin_px + (inner_h - new_h) // 2
        canvas.paste(resized, (offset_x, offset_y))
        return canvas

    # cover: scale to fill the inner area, then center-crop the overflow.
    scale = max(inner_w / src_w, inner_h / src_h)
    new_w = max(1, round(src_w * scale))
    new_h = max(1, round(src_h * scale))
    resized = image.resize((new_w, new_h), Image.BOX)
    crop_left = max(0, (new_w - inner_w) // 2)
    crop_top = max(0, (new_h - inner_h) // 2)
    resized = resized.crop((crop_left, crop_top, crop_left + inner_w, crop_top + inner_h))
    canvas.paste(resized, (margin_px, margin_px))
    return canvas


def render_page_image(
    page: "app.pymupdf.Page",
    options: PdfConvertOptions,
    dpi: int,
    canvas_size: tuple[int, int],
) -> Image.Image:
    """Renders one PDF page into a canvas_size grayscale image following the
    spec section 6 pipeline (through step 7; invert/threshold/dither are
    left to xtctool via the generated config, see config_with_pdf_options)."""
    scale = dpi / 72
    matrix = app.pymupdf.Matrix(scale, scale)
    pix = page.get_pixmap(matrix=matrix, colorspace=app.pymupdf.csGRAY, alpha=False)
    image = Image.frombytes("L", (pix.width, pix.height), pix.samples)
    image = _apply_rotation(image, options.rotation)
    image = _apply_crop(image, options.crop)
    return _place_on_canvas(image, options.fit, options.margin_px, canvas_size)


# --- xtctool config -----------------------------------------------------


def config_with_pdf_options(title: str, options: PdfConvertOptions) -> str:
    """TOML text of app.CONFIG_PATH with [output].title and the
    threshold/invert/dither/dither_strength overrides from options applied,
    per spec section 11.10. Reuses app._toml_value for identical formatting
    to config_with_title."""
    with open(app.CONFIG_PATH, "rb") as f:
        config = tomllib.load(f)
    config.setdefault("output", {})["title"] = title
    xtg = config.setdefault("xtg", {})
    xtg["threshold"] = options.threshold
    xtg["invert"] = options.invert
    xtg["dither"] = options.dither
    xtg["dither_strength"] = options.dither_strength
    lines = []
    for table, values in config.items():
        lines.append(f"[{table}]")
        for key, value in values.items():
            lines.append(f"{key} = {app._toml_value(value)}")
        lines.append("")
    return "\n".join(lines)


def _output_canvas_size() -> tuple[int, int]:
    try:
        with open(app.CONFIG_PATH, "rb") as f:
            config = tomllib.load(f)
        output = config.get("output", {})
        width, height = output.get("width"), output.get("height")
        if isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0:
            return width, height
    except Exception:  # noqa: BLE001 - fall back to the known X3 resolution
        logger.exception("failed to read output canvas size from config; using default")
    return OUTPUT_CANVAS_DEFAULT


# --- request-level validation --------------------------------------------


def _parse_content_length(raw: str | None) -> int:
    if raw is None or raw.strip() == "":
        raise PdfUploadError(400, "Content-Length header is required", code="bad_request")
    try:
        value = int(raw)
    except ValueError as exc:
        raise PdfUploadError(400, "invalid Content-Length", code="bad_request") from exc
    if value <= 0:
        raise PdfUploadError(
            400, "request body (PDF bytes) is required", code="bad_request"
        )
    return value


def _effective_max_upload_pdf_bytes(headers) -> int:
    raw = headers.get("X-Max-Pdf-Bytes")
    if raw is not None:
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if value > 0:
            return min(value, app.HARD_MAX_PDF_BYTES)
    return MAX_UPLOAD_PDF_BYTES


def _is_allowed_content_type(raw: str | None) -> bool:
    if raw is None:
        return False
    media_type = raw.split(";", 1)[0].strip().lower()
    return media_type in _ALLOWED_CONTENT_TYPES


def _resolve_timeout_seconds(headers) -> int:
    raw = headers.get("X-Convert-Timeout-Seconds")
    if raw:
        try:
            requested = int(raw)
        except ValueError:
            requested = 0
        if requested > 0:
            return max(1, min(requested, HARD_MAX_UPLOAD_TIMEOUT_SECONDS))
    return HARD_MAX_UPLOAD_TIMEOUT_SECONDS


def _receive_body_to_file(rfile, content_length: int, destination: Path) -> None:
    """Streams exactly content_length bytes from rfile to destination in
    1 MiB chunks (spec section 11.3), never holding the whole body in
    memory."""
    written = 0
    with open(destination, "wb") as f:
        while written < content_length:
            to_read = min(_RECEIVE_CHUNK_SIZE, content_length - written)
            chunk = rfile.read(to_read)
            if not chunk:
                break
            f.write(chunk)
            written += len(chunk)
    if written != content_length:
        raise PdfUploadError(400, "truncated request body", code="bad_request")


def _validate_pdf_magic(path: Path) -> None:
    with open(path, "rb") as f:
        head = f.read(_MAGIC_SEARCH_WINDOW)
    if _PDF_MAGIC not in head:
        raise PdfUploadError(415, "file is not a PDF", code="not_pdf")


# --- conversion pipeline --------------------------------------------------


def _chunked(items: list[int], size: int) -> list[list[int]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def convert_uploaded_pdf(
    pdf_path: Path,
    options: PdfConvertOptions,
    filename: str,
    timeout_seconds: int,
    workdir: Path,
) -> tuple[bytes, str]:
    """Validates and converts the PDF at pdf_path into XTC bytes, returning
    (xtc_bytes, title). Raises PdfUploadError for any validation failure and
    app.ConversionError for xtctool failures (mapped to 500 by the caller)."""
    deadline = time.monotonic() + timeout_seconds
    canvas_size = _output_canvas_size()

    try:
        doc = app.pymupdf.open(pdf_path)
    except Exception as exc:  # noqa: BLE001 - any parse failure is a 422
        raise PdfUploadError(
            422, "unable to parse PDF", f"pymupdf.open failed: {exc}",
            code="pdf_parse_failed",
        ) from exc

    try:
        if doc.is_encrypted or doc.needs_pass:
            raise PdfUploadError(
                422, "encrypted PDF is not supported", code="encrypted_pdf"
            )

        total_pages = doc.page_count
        if total_pages > MAX_SOURCE_PDF_PAGES:
            raise PdfUploadError(
                422,
                "PDF has too many pages",
                f"{total_pages} pages exceeds MAX_SOURCE_PDF_PAGES={MAX_SOURCE_PDF_PAGES}",
                code="page_range_invalid",
            )

        selected_pages = parse_page_range(options.pages, total_pages)
        if len(selected_pages) > MAX_SELECTED_PDF_PAGES:
            raise PdfUploadError(
                422,
                "too many pages selected",
                f"{len(selected_pages)} pages exceeds "
                f"MAX_SELECTED_PDF_PAGES={MAX_SELECTED_PDF_PAGES}",
                code="page_range_invalid",
            )

        raw_title = (doc.metadata or {}).get("title") or ""
        title = app.sanitize_title(raw_title) or _title_from_filename(filename)

        config_path = workdir / "config.toml"
        config_path.write_text(
            config_with_pdf_options(title, options), encoding="utf-8"
        )

        xtc_bytes = _convert_in_chunks(
            doc, selected_pages, options, config_path, canvas_size, workdir, deadline, timeout_seconds
        )
        return xtc_bytes, title
    finally:
        doc.close()


def _convert_in_chunks(
    doc,
    selected_pages: list[int],
    options: PdfConvertOptions,
    config_path: Path,
    canvas_size: tuple[int, int],
    workdir: Path,
    deadline: float,
    total_timeout_seconds: int,
) -> bytes:
    """Renders selected_pages in PDF_UPLOAD_CHUNK_SIZE_PAGES-page batches,
    packs each batch into a chunk XTC via xtctool, deletes the batch's PNGs,
    and finally repacks the chunk XTCs into one XTC (spec section 11.9).
    A single-chunk PDF skips the repack step and returns its one chunk
    directly, exactly mirroring app.convert_pdf's chunking shape."""
    chunks = _chunked(selected_pages, PDF_UPLOAD_CHUNK_SIZE_PAGES)
    chunk_xtc_paths: list[Path] = []

    for chunk_index, chunk_pages in enumerate(chunks, start=1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise app.ConversionError(
                f"conversion timed out after {total_timeout_seconds}s"
            )

        png_dir = workdir / f"chunk{chunk_index:04d}"
        png_dir.mkdir()
        png_paths: list[Path] = []
        try:
            for image_index, page_number in enumerate(chunk_pages, start=1):
                if time.monotonic() > deadline:
                    raise app.ConversionError(
                        f"conversion timed out after {total_timeout_seconds}s"
                    )
                page = doc[page_number - 1]
                image = render_page_image(page, options, PDF_RENDER_DPI, canvas_size)
                png_path = png_dir / f"page{image_index:04d}.png"
                image.save(png_path)
                png_paths.append(png_path)

            chunk_xtc_path = workdir / f"chunk{chunk_index:04d}.xtc"
            app._run_xtctool(
                [str(p) for p in png_paths],
                chunk_xtc_path,
                str(config_path),
                deadline - time.monotonic(),
                total_timeout_seconds,
                f"chunk {chunk_index}/{len(chunks)} pages "
                f"{chunk_pages[0]}-{chunk_pages[-1]}",
            )
        finally:
            # PNGs are deleted as soon as their chunk XTC exists (or the
            # chunk failed), keeping temp disk usage bounded regardless of
            # how many pages were selected -- spec section 11.9.
            for p in png_paths:
                p.unlink(missing_ok=True)
            png_dir.rmdir()
        chunk_xtc_paths.append(chunk_xtc_path)

    if len(chunk_xtc_paths) == 1:
        return chunk_xtc_paths[0].read_bytes()

    final_path = workdir / "output.xtc"
    app._run_xtctool(
        [str(p) for p in chunk_xtc_paths],
        final_path,
        str(config_path),
        deadline - time.monotonic(),
        total_timeout_seconds,
        f"repack of {len(chunk_xtc_paths)} chunks",
    )
    return final_path.read_bytes()


# --- HTTP entry point ------------------------------------------------------


def handle_uploaded_pdf_request(handler) -> None:
    """Entry point called from app.Handler._handle_post for
    POST /convert/uploaded-pdf. handler is the app.Handler instance (an
    http.server.BaseHTTPRequestHandler); this function uses its
    .headers/.rfile/._send_json/._send_bytes."""
    try:
        _handle_uploaded_pdf(handler)
    except PdfUploadError as exc:
        logger.error("uploaded-pdf request failed (%d): %s", exc.status, exc.log_message)
        # Connection cannot be safely reused whenever the body was never (or
        # only partially) read -- same rule app.py's /convert follows.
        close = exc.status in (400, 411, 413, 415)
        # `code` is the stable contract src/workflow.ts matches on to produce
        # a condition-specific NonRetryableError message (see PdfUploadError's
        # docstring); `error` stays the free-text, non-contractual detail.
        handler._send_json(
            exc.status, {"error": exc.message, "code": _error_code(exc)}, close=close
        )
    except app.ConversionError as exc:
        logger.error("uploaded-pdf conversion failed: %s; stderr: %s", exc, exc.stderr)
        handler._send_json(500, {"error": str(exc), "code": "convert_failed"})
    except Exception:  # noqa: BLE001 - a response must always go out
        logger.exception("unexpected error while handling /convert/uploaded-pdf")
        handler._send_json(500, {"error": "internal error", "code": "internal_error"}, close=True)


def _handle_uploaded_pdf(handler) -> None:
    if not _is_allowed_content_type(handler.headers.get("Content-Type")):
        raise PdfUploadError(415, "unsupported content type", code="not_pdf")

    content_length = _parse_content_length(handler.headers.get("Content-Length"))
    max_bytes = _effective_max_upload_pdf_bytes(handler.headers)
    if content_length > max_bytes:
        # Body is never read, so the connection cannot be reused.
        raise PdfUploadError(
            413, f"request body exceeds the {max_bytes} byte limit", code="pdf_too_large"
        )

    options = decode_pdf_options(handler.headers.get("X-Pdf-Options"))
    filename = decode_source_filename(handler.headers.get("X-Source-Filename"))
    timeout_seconds = _resolve_timeout_seconds(handler.headers)

    # Acquired before the body is read: a full instance should say "busy" up
    # front rather than accept multi-megabyte bodies it cannot act on yet.
    if not UPLOADED_PDF_CONVERSION_SLOTS.acquire(blocking=False):
        raise PdfUploadError(
            503, "conversion service is busy, try again shortly", code="service_busy"
        )
    try:
        with app.tempfile.TemporaryDirectory(prefix="pdf-upload-") as workdir_str:
            workdir = Path(workdir_str)
            pdf_path = workdir / "source.pdf"  # fixed name; never user input
            _receive_body_to_file(handler.rfile, content_length, pdf_path)
            _validate_pdf_magic(pdf_path)

            xtc_bytes, title = convert_uploaded_pdf(
                pdf_path, options, filename, timeout_seconds, workdir
            )
    finally:
        UPLOADED_PDF_CONVERSION_SLOTS.release()

    handler._send_bytes(xtc_bytes, title)
