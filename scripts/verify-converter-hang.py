#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 aGFydWtp

"""Checks, against the real converter container, that a PDF which makes
PyMuPDF hang cannot wedge the server.

Builds converter/Dockerfile (linux/amd64), starts a container, uploads the
given PDF(s) to POST /convert/uploaded-pdf with a short
X-Convert-Timeout-Seconds, and while that request is in flight polls
GET /healthz once a second and tries a second upload. Afterwards it uploads a
normal PDF and lists the processes left in the container. Per PDF it checks:

  1. the hanging upload is answered 500 {"code": "convert_timeout"} at about
     the timeout (not after the render would have finished);
  2. every /healthz during that time returned 200;
  3. every concurrent upload during that time returned 503 service_busy;
  4. a normal PDF uploaded right afterwards converts (200, XTC magic);
  5. no pdf_worker.py process (and no zombie) remains in the container.

Unless --skip-build is given, this leaves the built image "<name>-image"
(default h2x-conv-verify-image) on the host for reuse; remove it with
`docker rmi h2x-conv-verify-image`. The container is always removed on exit.

Exit status: 0 when every check passed for every PDF, 1 otherwise, 2 for
usage/environment errors. The PDFs are inputs only; nothing is committed.

Usage: scripts/verify-converter-hang.py [--timeout N] [--good-pdf FILE]
                                         [--image TAG] [--skip-build] PDF...
Env:   H2X_VERIFY_NAME  image/container name prefix (default h2x-conv-verify)
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
NAME = os.environ.get("H2X_VERIFY_NAME", "h2x-conv-verify")
# Hard stop for the whole script: a hung container must not hang the verifier.
OVERALL_LIMIT_SECONDS = 900
# Probes start this long after the hanging upload, so that its conversion slot
# is certainly held (an earlier probe would take the slot itself).
PROBE_START_DELAY_SECONDS = 3.0
# Allowed lateness of the timeout response (child start-up, kill, upload of
# the body) under amd64 emulation.
RESPONSE_SLACK_SECONDS = 12.0


def log(message: str) -> None:
    print(message, flush=True)


def minimal_pdf() -> bytes:
    """A valid one-page PDF with a line of text, built by hand so this script
    needs nothing but the standard library."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        None,  # content stream, filled below
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    stream = b"BT /F1 24 Tf 72 720 Td (verify-converter-hang normal page) Tj ET"
    objects[3] = b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream)
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref_at = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref_at,
    )
    return bytes(out)


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, text=True, capture_output=True, check=False, **kwargs)


class Container:
    def __init__(self, image: str, name: str) -> None:
        self.image = image
        self.name = name
        self.port = 0

    def start(self) -> None:
        run(["docker", "rm", "-f", self.name])
        result = run(
            [
                "docker", "run", "-d", "--name", self.name, "--platform", "linux/amd64",
                "-p", "127.0.0.1::8080", self.image,
            ]
        )
        if result.returncode != 0:
            raise RuntimeError(f"docker run failed: {result.stderr.strip()}")
        mapping = run(["docker", "port", self.name, "8080/tcp"]).stdout.strip().splitlines()
        self.port = int(mapping[0].rsplit(":", 1)[1])

    def stop(self) -> None:
        run(["docker", "rm", "-f", self.name])

    def logs(self) -> str:
        result = run(["docker", "logs", self.name])
        return result.stdout + result.stderr

    def processes(self) -> list[tuple[str, str, str]]:
        """(pid, state, cmdline) of everything in the container, read from
        /proc because the slim image has no ps."""
        script = (
            'for d in /proc/[0-9]*; do '
            'pid=${d#/proc/}; '
            'state=$(sed -n "s/^State:[[:space:]]*\\(.\\).*/\\1/p" $d/status 2>/dev/null); '
            'cmd=$(tr "\\0" " " < $d/cmdline 2>/dev/null); '
            'echo "$pid|$state|$cmd"; done'
        )
        try:
            result = run(["docker", "exec", self.name, "sh", "-c", script], timeout=30)
        except subprocess.TimeoutExpired:
            return []
        rows = []
        for line in result.stdout.splitlines():
            pid, _, rest = line.partition("|")
            state, _, cmd = rest.partition("|")
            rows.append((pid, state, cmd.strip()))
        return rows


def http_request(port: int, method: str, path: str, body: bytes | None = None,
                 headers: dict | None = None, timeout: float = 30):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        return response.status, response.read()
    finally:
        conn.close()


def upload(port: int, pdf: bytes, timeout_header: int | None, client_timeout: float):
    headers = {"Content-Type": "application/pdf", "Content-Length": str(len(pdf))}
    if timeout_header is not None:
        headers["X-Convert-Timeout-Seconds"] = str(timeout_header)
    return http_request(port, "POST", "/convert/uploaded-pdf", pdf, headers, client_timeout)


def wait_healthy(port: int, limit: float = 120) -> bool:
    end = time.monotonic() + limit
    while time.monotonic() < end:
        try:
            if http_request(port, "GET", "/healthz", timeout=3)[0] == 200:
                return True
        except OSError:
            pass
        time.sleep(1)
    return False


def decode(body: bytes) -> dict:
    try:
        payload = json.loads(body)
        return payload if isinstance(payload, dict) else {}
    except ValueError:
        return {}


def verify_one(container: Container, pdf_path: Path, good_pdf: bytes, timeout: int) -> bool:
    port = container.port
    hang_pdf = pdf_path.read_bytes()
    log(f"== {pdf_path.name} ({len(hang_pdf)} bytes), X-Convert-Timeout-Seconds: {timeout}")

    outcome: dict = {}

    def send_hanging() -> None:
        started = time.monotonic()
        try:
            outcome["status"], outcome["body"] = upload(
                port, hang_pdf, timeout, timeout + 120
            )
        except Exception as exc:  # noqa: BLE001 - reported below
            outcome["error"] = repr(exc)
        outcome["elapsed"] = time.monotonic() - started

    sender = threading.Thread(target=send_hanging, daemon=True)
    started = time.monotonic()
    sender.start()

    health_ok = health_bad = 0
    busy_ok = 0
    busy_other: list[tuple[int, str]] = []
    while sender.is_alive():
        time.sleep(1)
        try:
            status, _ = http_request(port, "GET", "/healthz", timeout=3)
        except OSError as exc:
            status = f"error {exc!r}"
        if status == 200:
            health_ok += 1
        else:
            health_bad += 1
            log(f"   t={time.monotonic() - started:5.1f}s /healthz -> {status}")
        if time.monotonic() - started >= PROBE_START_DELAY_SECONDS and sender.is_alive():
            try:
                pstatus, pbody = upload(port, good_pdf, None, 10)
                code = decode(pbody).get("code", "")
            except OSError as exc:
                pstatus, code = 0, repr(exc)
            if pstatus == 503 and code == "service_busy":
                busy_ok += 1
            elif sender.is_alive():
                # A probe answered after the hanging upload ended is not
                # evidence either way.
                busy_other.append((pstatus, code))
    sender.join()

    payload = decode(outcome.get("body", b""))
    elapsed = outcome.get("elapsed", float("nan"))
    log(
        f"   hanging upload: HTTP {outcome.get('status')} {payload.get('code')!r} "
        f"after {elapsed:.1f}s; error={payload.get('error')!r}"
        + (f" client_error={outcome['error']}" if "error" in outcome else "")
    )
    log(f"   /healthz while it ran: {health_ok} x 200, {health_bad} other")
    log(f"   concurrent uploads while it ran: {busy_ok} x 503 service_busy, other: {busy_other}")

    try:
        after_status, after_body = upload(port, good_pdf, None, 60)
    except OSError as exc:
        log(f"   normal upload afterwards failed: {exc!r}")
        after_status, after_body = 0, b""
    log(f"   normal upload afterwards: HTTP {after_status}, {len(after_body)} bytes, "
        f"magic={after_body[:4]!r}")

    procs = container.processes()
    leftovers = [p for p in procs if "pdf_worker" in p[2] or p[1] == "Z"]
    log(f"   container processes afterwards: {[(p[0], p[1], p[2][:60]) for p in procs]}")

    checks = {
        "1 timeout answered as convert_timeout at the deadline": (
            outcome.get("status") == 500
            and payload.get("code") == "convert_timeout"
            and timeout - 1 <= elapsed <= timeout + RESPONSE_SLACK_SECONDS
        ),
        "2 /healthz stayed 200": health_ok >= 3 and health_bad == 0,
        "3 concurrent upload got 503 service_busy": busy_ok >= 3 and not busy_other,
        "4 normal upload succeeded afterwards": (
            after_status == 200 and after_body[:4] == b"XTC\x00"
        ),
        "5 no worker process or zombie left": bool(procs) and not leftovers,
    }
    for name, passed in checks.items():
        log(f"   [{'PASS' if passed else 'FAIL'}] {name}")
    return all(checks.values())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("pdfs", nargs="+", type=Path)
    parser.add_argument("--timeout", type=int, default=15,
                        help="X-Convert-Timeout-Seconds for the hanging upload (default 15)")
    parser.add_argument("--good-pdf", type=Path, help="normal PDF (default: a built-in one-page PDF)")
    parser.add_argument("--image", default=f"{NAME}-image",
                        help="image tag to build/use")
    parser.add_argument("--skip-build", action="store_true", help="use --image as it is")
    args = parser.parse_args()

    for pdf in args.pdfs:
        if not pdf.is_file():
            print(f"not a file: {pdf}", file=sys.stderr)
            return 2
    good_pdf = args.good_pdf.read_bytes() if args.good_pdf else minimal_pdf()

    if not args.skip_build:
        log(f"building {args.image} (linux/amd64)")
        build = run(
            ["docker", "build", "--platform", "linux/amd64", "-t", args.image,
             "-f", str(REPO_ROOT / "converter" / "Dockerfile"), str(REPO_ROOT / "converter")]
        )
        if build.returncode != 0:
            print(build.stdout[-2000:] + build.stderr[-2000:], file=sys.stderr)
            return 2

    container = Container(args.image, f"{NAME}-{os.getpid()}")

    def on_alarm(signum, frame):  # noqa: ARG001
        container.stop()
        print(f"overall limit of {OVERALL_LIMIT_SECONDS}s exceeded", file=sys.stderr)
        os._exit(2)

    signal.signal(signal.SIGALRM, on_alarm)
    signal.alarm(OVERALL_LIMIT_SECONDS)

    all_passed = True
    try:
        container.start()
        if not wait_healthy(container.port):
            print("container never became healthy", file=sys.stderr)
            print(container.logs()[-3000:], file=sys.stderr)
            return 2
        for pdf in args.pdfs:
            all_passed &= verify_one(container, pdf, good_pdf, args.timeout)
        log("")
        log("server log tail:")
        log("\n".join(container.logs().splitlines()[-12:]))
    finally:
        container.stop()
    log("RESULT: " + ("all checks passed" if all_passed else "FAILED"))
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
