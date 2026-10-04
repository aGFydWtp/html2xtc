# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 aGFydWtp

"""Child-process entry point for /convert/uploaded-pdf (see pdf_upload.py).

Everything that hands an untrusted, user-uploaded PDF to PyMuPDF runs here,
in a fresh interpreter the HTTP server can SIGKILL on timeout. Some crafted
PDFs make PyMuPDF spin inside C without ever returning (and without
releasing the GIL), which in the server process would freeze /healthz and
every other request with no way to recover; in this process it only costs
one killable child.

Invoked as `python pdf_worker.py <job.json>`. The only argv is the path of a
job file inside the request's temp directory, so nothing derived from request
headers reaches argv (see pdf_upload's module docstring). The job file names
the operation ("inspect" or "render") and carries its parameters; the result
is written as JSON to the path the job names. Exit status 0 plus a
well-formed result means the job ran to a conclusion, including expected
rejections (unparseable PDF, invalid crop), which travel inside the result.
Anything else -- non-zero exit, a signal, a missing or malformed result -- is
an abnormal termination the parent reports as a conversion failure.

This runs outside the HTTP server: no request state, no logging setup beyond
stderr, which the parent captures into the server log only.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import app
import pdf_upload


def _inspect(job: dict) -> dict:
    """Opens the PDF and reports what the parent needs to validate the
    request: encryption, page count, and the metadata title. An unopenable
    PDF is a result (the parent maps it to a 422), not a crash."""
    try:
        doc = app.pymupdf.open(job["pdf"])
    except Exception as exc:  # noqa: BLE001 - any parse failure is a 422
        return {"status": "open_failed", "detail": f"pymupdf.open failed: {exc}"}
    try:
        if doc.is_encrypted or doc.needs_pass:
            return {"status": "ok", "encrypted": True}
        title = (doc.metadata or {}).get("title") or ""
        return {
            "status": "ok",
            "encrypted": False,
            "page_count": doc.page_count,
            "title": title if isinstance(title, str) else "",
        }
    finally:
        doc.close()


def _options_from_job(data: dict) -> pdf_upload.PdfConvertOptions:
    fields = dict(data)
    fields["crop"] = pdf_upload.Crop(**fields["crop"])
    return pdf_upload.PdfConvertOptions(**fields)


def _render(job: dict) -> dict:
    """Renders job["pages"] (1-indexed) to out_dir/page0001.png, page0002.png,
    ... using the same pipeline the server process used before it moved here
    (pdf_upload.render_page_image)."""
    options = _options_from_job(job["options"])
    canvas_size = (int(job["canvas_size"][0]), int(job["canvas_size"][1]))
    out_dir = Path(job["out_dir"])
    doc = app.pymupdf.open(job["pdf"])
    try:
        for image_index, page_number in enumerate(job["pages"], start=1):
            page = doc[page_number - 1]
            image = pdf_upload.render_page_image(
                page, options, int(job["dpi"]), canvas_size
            )
            image.save(out_dir / f"page{image_index:04d}.png")
    finally:
        doc.close()
    return {"status": "ok", "pages": len(job["pages"])}


_OPERATIONS = {"inspect": _inspect, "render": _render}


def run_job(job: dict) -> dict:
    try:
        return _OPERATIONS[job["op"]](job)
    except pdf_upload.PdfUploadError as exc:
        # An expected, client-attributable rejection (e.g. a crop that leaves
        # no pixels): handed back whole so the parent answers exactly as it
        # did when this ran in-process.
        return {
            "status": "upload_error",
            "http_status": exc.status,
            "message": exc.message,
            "log_message": exc.log_message,
            "code": exc.code,
        }


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: pdf_worker.py <job.json>", file=sys.stderr)
        return 2
    job = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    result = run_job(job)
    Path(job["result"]).write_text(json.dumps(result), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
