"""Unit tests for converter/app.py. xtctool itself is never invoked; every
subprocess call is mocked."""

import http.client
import json
import logging
import socket
import subprocess
import sys
import threading
import time
import tomllib
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "converter"))

import app  # noqa: E402

FAKE_XTC = b"XTC-FAKE-BYTES"
FAKE_PDF = b"%PDF-1.4 fake"


def run_success(cmd, **kwargs):
    """Simulate xtctool writing the output file next to the input."""
    out_path = Path(cmd[cmd.index("-o") + 1])
    out_path.write_bytes(FAKE_XTC)
    return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")


def run_failure(cmd, **kwargs):
    return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="boom: bad pdf")


def run_timeout(cmd, **kwargs):
    raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout", 0))


def run_no_output(cmd, **kwargs):
    return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")


def run_empty_output(cmd, **kwargs):
    """Simulate xtctool succeeding but writing a zero-byte output file."""
    Path(cmd[cmd.index("-o") + 1]).write_bytes(b"")
    return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="empty run")


def run_echo(cmd, **kwargs):
    """Write output derived from the input so cross-talk would be visible."""
    source = Path(cmd[2]).read_bytes()
    time.sleep(0.05)
    Path(cmd[cmd.index("-o") + 1]).write_bytes(b"XTC:" + source)
    return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")


class TestConvertPdf:
    def test_success_returns_xtc_bytes(self):
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            assert app.convert_pdf(FAKE_PDF) == FAKE_XTC

    def test_invokes_xtctool_with_config(self):
        calls = []

        def recording_run(cmd, **kwargs):
            calls.append((cmd, kwargs))
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            app.convert_pdf(FAKE_PDF)

        (cmd, kwargs) = calls[0]
        assert cmd[0:2] == ["xtctool", "convert"]
        assert cmd[cmd.index("-c") + 1] == app.CONFIG_PATH
        assert kwargs["timeout"] == app.CONVERT_TIMEOUT_SECONDS
        assert Path(cmd[2]).name == "source.pdf"

    def test_writes_pdf_bytes_to_source_file(self):
        seen = {}

        def inspecting_run(cmd, **kwargs):
            seen["source"] = Path(cmd[2]).read_bytes()
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=inspecting_run):
            app.convert_pdf(FAKE_PDF)
        assert seen["source"] == FAKE_PDF

    def test_nonzero_exit_raises_with_stderr(self):
        with mock.patch.object(app.subprocess, "run", side_effect=run_failure):
            with pytest.raises(app.ConversionError) as excinfo:
                app.convert_pdf(FAKE_PDF)
        assert "exited with code 1" in str(excinfo.value)
        assert "boom: bad pdf" in excinfo.value.stderr

    def test_timeout_raises(self):
        with mock.patch.object(app.subprocess, "run", side_effect=run_timeout):
            with pytest.raises(app.ConversionError) as excinfo:
                app.convert_pdf(FAKE_PDF)
        assert "timed out" in str(excinfo.value)

    def test_missing_output_file_raises(self):
        with mock.patch.object(app.subprocess, "run", side_effect=run_no_output):
            with pytest.raises(app.ConversionError) as excinfo:
                app.convert_pdf(FAKE_PDF)
        assert "no output" in str(excinfo.value)

    def test_empty_output_file_raises_with_stderr(self):
        with mock.patch.object(app.subprocess, "run", side_effect=run_empty_output):
            with pytest.raises(app.ConversionError) as excinfo:
                app.convert_pdf(FAKE_PDF)
        assert "empty output file" in str(excinfo.value)
        assert "empty run" in excinfo.value.stderr

    def test_default_timeout_is_convert_timeout_seconds(self):
        seen = {}

        def recording_run(cmd, **kwargs):
            seen["timeout"] = kwargs["timeout"]
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            app.convert_pdf(FAKE_PDF)
        assert seen["timeout"] == app.CONVERT_TIMEOUT_SECONDS

    def test_timeout_seconds_is_passed_to_subprocess_run(self):
        seen = {}

        def recording_run(cmd, **kwargs):
            seen["timeout"] = kwargs["timeout"]
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            app.convert_pdf(FAKE_PDF, timeout_seconds=42)
        assert seen["timeout"] == 42

    def test_timeout_message_includes_timeout_seconds(self):
        with mock.patch.object(app.subprocess, "run", side_effect=run_timeout):
            with pytest.raises(app.ConversionError) as excinfo:
                app.convert_pdf(FAKE_PDF, timeout_seconds=42)
        assert "timed out after 42s" in str(excinfo.value)


SAMPLE_CONFIG = """\
[output]
width = 528
format = "xtg"
title = ""
[xtg]
invert = false
dither_strength = 0.8
"""


class TestTitleHandling:
    def test_extract_returns_empty_without_pymupdf(self):
        with mock.patch.object(app, "pymupdf", None):
            assert app.extract_pdf_title(FAKE_PDF) == ""

    def test_extract_reads_and_sanitizes_metadata_title(self):
        fake_doc = mock.MagicMock()
        fake_doc.metadata = {"title": "  日本語の\tタイトル\r\n続き  "}
        fake_pymupdf = mock.MagicMock()
        fake_pymupdf.open.return_value.__enter__.return_value = fake_doc
        with mock.patch.object(app, "pymupdf", fake_pymupdf):
            assert app.extract_pdf_title(FAKE_PDF) == "日本語の タイトル 続き"

    def test_extract_caps_length(self):
        fake_doc = mock.MagicMock()
        fake_doc.metadata = {"title": "x" * 500}
        fake_pymupdf = mock.MagicMock()
        fake_pymupdf.open.return_value.__enter__.return_value = fake_doc
        with mock.patch.object(app, "pymupdf", fake_pymupdf):
            assert app.extract_pdf_title(FAKE_PDF) == "x" * app.MAX_TITLE_CHARS

    def test_extract_swallows_parser_errors(self):
        fake_pymupdf = mock.MagicMock()
        fake_pymupdf.open.side_effect = RuntimeError("broken pdf")
        with mock.patch.object(app, "pymupdf", fake_pymupdf):
            assert app.extract_pdf_title(FAKE_PDF) == ""

    def test_extract_roundtrip_with_real_pymupdf(self):
        pymupdf = pytest.importorskip("pymupdf")
        doc = pymupdf.open()
        doc.new_page()
        doc.set_metadata({"title": "日本語のタイトル – Test"})
        assert app.extract_pdf_title(doc.tobytes()) == "日本語のタイトル – Test"

    def test_config_with_title_overrides_output_title(self, tmp_path):
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            merged = tomllib.loads(app.config_with_title('日本語 "引用" タイトル'))
        assert merged["output"]["title"] == '日本語 "引用" タイトル'
        # The rest of the config survives the round trip, types intact.
        assert merged["output"]["width"] == 528
        assert merged["output"]["format"] == "xtg"
        assert merged["xtg"]["invert"] is False
        assert merged["xtg"]["dither_strength"] == 0.8

    def test_convert_pdf_with_title_passes_merged_config(self, tmp_path):
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        seen = {}

        def inspecting_run(cmd, **kwargs):
            # The merged config lives in the conversion workdir; read it while
            # it still exists.
            merged_path = Path(cmd[cmd.index("-c") + 1])
            seen["config_path"] = str(merged_path)
            seen["config"] = tomllib.loads(merged_path.read_text(encoding="utf-8"))
            return run_success(cmd, **kwargs)

        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            with mock.patch.object(app.subprocess, "run", side_effect=inspecting_run):
                assert app.convert_pdf(FAKE_PDF, "ページタイトル") == FAKE_XTC

        assert seen["config_path"] != str(config_path)
        assert seen["config"]["output"]["title"] == "ページタイトル"

    def test_convert_pdf_without_title_uses_base_config(self):
        calls = []

        def recording_run(cmd, **kwargs):
            calls.append(cmd)
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            app.convert_pdf(FAKE_PDF, "")
        assert calls[0][calls[0].index("-c") + 1] == app.CONFIG_PATH

    def test_convert_pdf_title_merge_failure_falls_back(self, caplog):
        # An unreadable config must not block the conversion itself.
        calls = []

        def recording_run(cmd, **kwargs):
            calls.append(cmd)
            return run_success(cmd, **kwargs)

        with caplog.at_level(logging.ERROR, logger="converter"):
            with mock.patch.object(app, "CONFIG_PATH", "/nonexistent/config.toml"):
                with mock.patch.object(
                    app.subprocess, "run", side_effect=recording_run
                ):
                    assert app.convert_pdf(FAKE_PDF, "タイトル") == FAKE_XTC
        assert calls[0][calls[0].index("-c") + 1] == "/nonexistent/config.toml"
        assert "config title merge failed" in caplog.text


@pytest.fixture()
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv
    srv.shutdown()
    srv.server_close()


def request(srv, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        conn.close()


def raw_request(srv, payload: bytes, half_close: bool = False) -> bytes:
    """Send raw bytes and return whatever the server answers."""
    port = srv.server_address[1]
    response = b""
    with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
        sock.sendall(payload)
        if half_close:
            sock.shutdown(socket.SHUT_WR)
        sock.settimeout(5)
        try:
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
        except TimeoutError:
            pass
    return response


class TestHttpServer:
    def test_healthz(self, server):
        status, _, body = request(server, "GET", "/healthz")
        assert status == 200
        assert json.loads(body) == {"status": "ok"}

    def test_get_unknown_path_is_404(self, server):
        status, _, _ = request(server, "GET", "/nope")
        assert status == 404

    def test_post_unknown_path_is_404(self, server):
        status, _, _ = request(server, "POST", "/nope", body=FAKE_PDF)
        assert status == 404

    def test_convert_success(self, server):
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            status, headers, body = request(server, "POST", "/convert", body=FAKE_PDF)
        assert status == 200
        assert headers["Content-Type"] == "application/octet-stream"
        assert headers["Content-Length"] == str(len(FAKE_XTC))
        assert body == FAKE_XTC
        # FAKE_PDF has no title metadata, so no title header is sent.
        assert "X-Xtc-Title" not in headers

    def test_convert_success_sends_percent_encoded_title_header(self, server):
        with mock.patch.object(app, "extract_pdf_title", return_value="日本語 T"):
            with mock.patch.object(app.subprocess, "run", side_effect=run_success):
                status, headers, body = request(
                    server, "POST", "/convert", body=FAKE_PDF
                )
        assert status == 200
        assert body == FAKE_XTC
        assert headers["X-Xtc-Title"] == urllib.parse.quote("日本語 T", safe="")

    def test_convert_empty_body_is_400(self, server):
        status, _, body = request(server, "POST", "/convert", body=b"")
        assert status == 400
        assert "required" in json.loads(body)["error"]

    def test_convert_missing_content_length_is_400(self, server):
        # http.client sends no Content-Length when body is None.
        status, _, body = request(server, "POST", "/convert")
        assert status == 400
        assert "required" in json.loads(body)["error"]

    def test_convert_non_numeric_content_length_is_400(self, server):
        response = raw_request(
            server,
            b"POST /convert HTTP/1.1\r\n"
            b"Host: test\r\n"
            b"Content-Length: abc\r\n"
            b"\r\n",
        )
        assert response.split(b"\r\n", 1)[0].split(b" ")[1] == b"400"
        assert b"invalid Content-Length" in response

    def test_convert_truncated_body_is_400(self, server):
        response = raw_request(
            server,
            b"POST /convert HTTP/1.1\r\n"
            b"Host: test\r\n"
            b"Content-Length: 100\r\n"
            b"\r\n"
            b"short",
            half_close=True,
        )
        assert response.split(b"\r\n", 1)[0].split(b" ")[1] == b"400"
        assert b"truncated" in response

    def test_convert_oversized_body_is_413(self, server):
        with mock.patch.object(app, "MAX_PDF_BYTES", 8):
            status, _, body = request(server, "POST", "/convert", body=FAKE_PDF)
        assert status == 413
        assert "exceeds" in json.loads(body)["error"]

    def test_convert_failure_is_500_generic_with_stderr_logged(self, server, caplog):
        with caplog.at_level(logging.ERROR, logger="converter"):
            with mock.patch.object(app.subprocess, "run", side_effect=run_failure):
                status, headers, body = request(
                    server, "POST", "/convert", body=FAKE_PDF
                )
        assert status == 500
        assert headers["Content-Type"] == "application/json"
        payload = json.loads(body)
        assert "exited with code 1" in payload["error"]
        # stderr must be logged but never sent to the client.
        assert "stderr" not in payload
        assert "boom: bad pdf" not in json.dumps(payload)
        assert "boom: bad pdf" in caplog.text

    def test_convert_timeout_is_500(self, server):
        with mock.patch.object(app.subprocess, "run", side_effect=run_timeout):
            status, _, body = request(server, "POST", "/convert", body=FAKE_PDF)
        assert status == 500
        assert "timed out" in json.loads(body)["error"]

    def test_convert_timeout_header_sets_subprocess_timeout(self, server):
        seen = {}

        def recording_run(cmd, **kwargs):
            seen["timeout"] = kwargs["timeout"]
            return run_success(cmd, **kwargs)

        expected = min(5, app.CONVERT_TIMEOUT_SECONDS)
        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            status, _, _ = request(
                server,
                "POST",
                "/convert",
                body=FAKE_PDF,
                headers={"X-Convert-Timeout-Seconds": "5"},
            )
        assert status == 200
        assert seen["timeout"] == expected

    def test_convert_timeout_header_is_clamped_to_ceiling(self, server):
        seen = {}

        def recording_run(cmd, **kwargs):
            seen["timeout"] = kwargs["timeout"]
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            status, _, _ = request(
                server,
                "POST",
                "/convert",
                body=FAKE_PDF,
                headers={"X-Convert-Timeout-Seconds": "9999"},
            )
        assert status == 200
        assert seen["timeout"] == app.CONVERT_TIMEOUT_SECONDS

    def test_convert_missing_timeout_header_uses_default(self, server):
        seen = {}

        def recording_run(cmd, **kwargs):
            seen["timeout"] = kwargs["timeout"]
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            status, _, _ = request(server, "POST", "/convert", body=FAKE_PDF)
        assert status == 200
        assert seen["timeout"] == app.CONVERT_TIMEOUT_SECONDS

    def test_convert_non_numeric_timeout_header_uses_default(self, server):
        seen = {}

        def recording_run(cmd, **kwargs):
            seen["timeout"] = kwargs["timeout"]
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            status, _, _ = request(
                server,
                "POST",
                "/convert",
                body=FAKE_PDF,
                headers={"X-Convert-Timeout-Seconds": "not-a-number"},
            )
        assert status == 200
        assert seen["timeout"] == app.CONVERT_TIMEOUT_SECONDS

    def test_convert_empty_output_is_500(self, server):
        with mock.patch.object(app.subprocess, "run", side_effect=run_empty_output):
            status, _, body = request(server, "POST", "/convert", body=FAKE_PDF)
        assert status == 500
        assert "empty output file" in json.loads(body)["error"]

    def test_title_extraction_runs_inside_conversion_slot(self, server):
        # A single-permit semaphore stands in for CONVERSION_SLOTS; if the title
        # parse ran outside the slot, the non-blocking acquire below would win.
        observed = {}
        slot = threading.Semaphore(1)

        def probing_extract(pdf_bytes):
            acquired = slot.acquire(blocking=False)
            observed["slot_free_during_extract"] = acquired
            if acquired:
                slot.release()
            return ""

        with mock.patch.object(app, "CONVERSION_SLOTS", slot):
            with mock.patch.object(
                app, "extract_pdf_title", side_effect=probing_extract
            ):
                with mock.patch.object(
                    app.subprocess, "run", side_effect=run_success
                ):
                    status, _, body = request(
                        server, "POST", "/convert", body=FAKE_PDF
                    )

        assert status == 200
        assert body == FAKE_XTC
        assert observed["slot_free_during_extract"] is False

    def test_unexpected_exception_still_gets_response(self, server, caplog):
        with caplog.at_level(logging.ERROR, logger="converter"):
            with mock.patch.object(
                app.subprocess, "run", side_effect=RuntimeError("surprise")
            ):
                status, _, body = request(server, "POST", "/convert", body=FAKE_PDF)
        assert status == 500
        payload = json.loads(body)
        assert payload["error"] == "internal error"
        assert "surprise" not in json.dumps(payload)
        assert "surprise" in caplog.text

    def test_concurrent_requests_do_not_cross_talk(self, server):
        bodies = [f"pdf-{i}".encode() for i in range(4)]

        def convert(body):
            return request(server, "POST", "/convert", body=body)

        with mock.patch.object(app.subprocess, "run", side_effect=run_echo):
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(convert, bodies))

        for body, (status, _, response) in zip(bodies, results):
            assert status == 200
            assert response == b"XTC:" + body


class TestGracefulShutdown:
    def test_wait_idle_blocks_until_requests_finish(self):
        tracker = app.ActiveRequestTracker()
        release = threading.Event()
        started = threading.Event()

        def busy():
            with tracker:
                started.set()
                release.wait(5)

        thread = threading.Thread(target=busy)
        thread.start()
        started.wait(5)
        assert tracker.wait_idle(timeout=0.05) is False
        release.set()
        thread.join(5)
        assert tracker.wait_idle(timeout=5) is True
