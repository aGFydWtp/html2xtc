"""Unit tests for converter/app.py. xtctool itself is never invoked; every
subprocess call is mocked."""

import base64
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


class TestChunkedConversion:
    """PDFs above CHUNK_THRESHOLD_PAGES are converted in CHUNK_SIZE_PAGES
    page-range chunks and repacked; shorter PDFs keep the single-pass path."""

    @staticmethod
    def _recording_run(calls):
        def run(cmd, **kwargs):
            calls.append(list(cmd))
            return run_success(cmd, **kwargs)

        return run

    @staticmethod
    def _sources(cmd):
        return cmd[2 : cmd.index("-o")]

    def test_page_count_at_threshold_uses_single_pass(self):
        calls = []
        with mock.patch.object(
            app.subprocess, "run", side_effect=self._recording_run(calls)
        ):
            result = app.convert_pdf(FAKE_PDF, page_count=app.CHUNK_THRESHOLD_PAGES)
        assert result == FAKE_XTC
        assert len(calls) == 1
        (source,) = self._sources(calls[0])
        assert source.endswith("source.pdf")  # no page-range suffix

    def test_unknown_page_count_falls_back_to_single_pass(self):
        calls = []
        with mock.patch.object(
            app.subprocess, "run", side_effect=self._recording_run(calls)
        ):
            with mock.patch.object(
                app, "count_pdf_pages", return_value=None
            ) as counter:
                assert app.convert_pdf(FAKE_PDF) == FAKE_XTC
        counter.assert_called_once_with(FAKE_PDF)
        assert len(calls) == 1

    def test_above_threshold_converts_in_chunks_then_repacks(self):
        calls = []
        with mock.patch.object(
            app.subprocess, "run", side_effect=self._recording_run(calls)
        ):
            result = app.convert_pdf(FAKE_PDF, page_count=151)
        assert result == FAKE_XTC
        assert len(calls) == 3
        (chunk1,) = self._sources(calls[0])
        (chunk2,) = self._sources(calls[1])
        assert chunk1.endswith("source.pdf:1-100")
        assert chunk2.endswith("source.pdf:101-151")
        # The repack step consumes exactly the chunk outputs, in page order.
        chunk_outputs = [cmd[cmd.index("-o") + 1] for cmd in calls[:2]]
        assert self._sources(calls[2]) == chunk_outputs
        assert all(path.endswith(".xtc") for path in chunk_outputs)

    def test_chunk_failure_raises_with_stage_name(self):
        def run(cmd, **kwargs):
            if any(str(part).endswith(":101-151") for part in cmd):
                return run_failure(cmd, **kwargs)
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=run):
            with pytest.raises(app.ConversionError) as excinfo:
                app.convert_pdf(FAKE_PDF, page_count=151)
        assert "chunk 2/2 pages 101-151" in str(excinfo.value)
        assert "boom: bad pdf" in excinfo.value.stderr

    def test_budget_exhaustion_between_chunks_raises(self):
        # Fake clock: deadline calc at t=0, chunk 1 at t=1 (within budget),
        # chunk 2 at t=9999 (budget exhausted before the subprocess starts).
        clock = iter([0.0, 1.0, 9999.0])
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            with mock.patch.object(app.time, "monotonic", side_effect=lambda: next(clock)):
                with pytest.raises(app.ConversionError) as excinfo:
                    app.convert_pdf(FAKE_PDF, page_count=151, timeout_seconds=10)
        assert "timed out after 10s" in str(excinfo.value)

    def test_read_pdf_metadata_returns_page_count_with_real_pymupdf(self):
        pymupdf = pytest.importorskip("pymupdf")
        doc = pymupdf.open()
        doc.new_page()
        doc.new_page()
        title, page_count = app.read_pdf_metadata(doc.tobytes())
        assert page_count == 2


class TestPositiveEnvInt:
    def test_missing_env_returns_default(self, monkeypatch):
        monkeypatch.delenv("XTC_CHUNK_SIZE_PAGES", raising=False)
        assert app._positive_env_int("XTC_CHUNK_SIZE_PAGES", 100) == 100

    def test_valid_value_is_used(self, monkeypatch):
        monkeypatch.setenv("XTC_CHUNK_SIZE_PAGES", "80")
        assert app._positive_env_int("XTC_CHUNK_SIZE_PAGES", 100) == 80

    def test_invalid_values_fall_back_to_default_with_warning(
        self, monkeypatch, caplog
    ):
        for bad in ("0", "-5", "many"):
            monkeypatch.setenv("XTC_CHUNK_SIZE_PAGES", bad)
            with caplog.at_level(logging.WARNING, logger="converter"):
                assert app._positive_env_int("XTC_CHUNK_SIZE_PAGES", 100) == 100
        assert "XTC_CHUNK_SIZE_PAGES" in caplog.text


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


class TestAuthorHandling:
    """text-upload spec §16/§10: [output].author, set the same way title
    is — via a merged TOML config — but sourced from the X-Xtc-Author
    request header (converter/app.py has no other source for it, unlike
    the title which is read back from the rendered PDF's own metadata)."""

    def test_config_with_title_author_overrides_both(self, tmp_path):
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            merged = tomllib.loads(app.config_with_title_author("タイトル", "著者名"))
        assert merged["output"]["title"] == "タイトル"
        assert merged["output"]["author"] == "著者名"
        # The rest of the config survives the round trip, types intact.
        assert merged["output"]["width"] == 528
        assert merged["xtg"]["dither_strength"] == 0.8

    def test_config_with_title_author_leaves_default_author_when_empty(self, tmp_path):
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            merged = tomllib.loads(app.config_with_title_author("タイトルのみ"))
        assert merged["output"]["title"] == "タイトルのみ"
        # SAMPLE_CONFIG has no [output].author key at all; author="" must not
        # invent one -- config_with_title (the pre-existing /convert callers)
        # must stay byte-for-byte unaffected.
        assert "author" not in merged["output"]

    def test_config_with_title_is_a_backward_compatible_alias(self, tmp_path):
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            assert app.config_with_title("T") == app.config_with_title_author("T", "")

    def test_convert_pdf_with_author_passes_merged_config(self, tmp_path):
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        seen = {}

        def inspecting_run(cmd, **kwargs):
            merged_path = Path(cmd[cmd.index("-c") + 1])
            seen["config"] = tomllib.loads(merged_path.read_text(encoding="utf-8"))
            return run_success(cmd, **kwargs)

        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            with mock.patch.object(app.subprocess, "run", side_effect=inspecting_run):
                assert (
                    app.convert_pdf(FAKE_PDF, "タイトル", author="著者名")
                    == FAKE_XTC
                )

        assert seen["config"]["output"]["title"] == "タイトル"
        assert seen["config"]["output"]["author"] == "著者名"

    def test_convert_pdf_with_only_author_still_merges_config(self, tmp_path):
        # title="" but author set: the merge must still trigger (spec: same
        # mechanism as title), not silently skip because title is falsy.
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        calls = []

        def recording_run(cmd, **kwargs):
            calls.append(cmd)
            return run_success(cmd, **kwargs)

        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
                app.convert_pdf(FAKE_PDF, "", author="著者のみ")
        assert calls[0][calls[0].index("-c") + 1] != str(config_path)

    def test_convert_pdf_without_title_or_author_uses_base_config(self):
        calls = []

        def recording_run(cmd, **kwargs):
            calls.append(cmd)
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            app.convert_pdf(FAKE_PDF, "")
        assert calls[0][calls[0].index("-c") + 1] == app.CONFIG_PATH

    def test_decode_base64url_utf8_roundtrip(self):
        encoded = base64.urlsafe_b64encode("著者名".encode("utf-8")).rstrip(b"=").decode("ascii")
        assert app.decode_base64url_utf8(encoded) == "著者名"

    def test_decode_base64url_utf8_falls_back_to_empty_on_malformed_input(self):
        # Fail-soft: a garbled X-Xtc-Author must never fail the conversion,
        # same stance as a missing/garbled title.
        assert app.decode_base64url_utf8("not valid base64url!!") == ""
        assert app.decode_base64url_utf8("") == ""

    def test_convert_success_with_author_header_merges_it_into_config(self, server, tmp_path):
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        seen = {}

        def inspecting_run(cmd, **kwargs):
            merged_path = Path(cmd[cmd.index("-c") + 1])
            seen["config"] = tomllib.loads(merged_path.read_text(encoding="utf-8"))
            return run_success(cmd, **kwargs)

        encoded_author = (
            base64.urlsafe_b64encode("小説の著者".encode("utf-8")).rstrip(b"=").decode("ascii")
        )
        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            with mock.patch.object(app.subprocess, "run", side_effect=inspecting_run):
                status, _, body = request(
                    server,
                    "POST",
                    "/convert",
                    body=FAKE_PDF,
                    headers={"X-Xtc-Author": encoded_author},
                )
        assert status == 200
        assert body == FAKE_XTC
        assert seen["config"]["output"]["author"] == "小説の著者"

    def test_convert_success_without_author_header_is_unaffected(self, server):
        # Every pre-existing /convert caller (URL-render pipeline) never
        # sends X-Xtc-Author; this must stay byte-for-byte the prior
        # behavior (author untouched from config-x3.toml's own "").
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            status, headers, body = request(server, "POST", "/convert", body=FAKE_PDF)
        assert status == 200
        assert body == FAKE_XTC
        assert "X-Xtc-Title" not in headers

    def test_convert_malformed_author_header_falls_back_to_no_author(self, server):
        # A garbled header must degrade gracefully, never 400/500 the whole
        # conversion.
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            status, _, body = request(
                server,
                "POST",
                "/convert",
                body=FAKE_PDF,
                headers={"X-Xtc-Author": "not valid base64url!!"},
            )
        assert status == 200
        assert body == FAKE_XTC


class TestEffectiveMaxPdfBytes:
    def test_header_value_at_or_below_hard_max_is_used_as_is(self):
        assert app.effective_max_pdf_bytes({"X-Max-Pdf-Bytes": "8"}) == 8
        assert (
            app.effective_max_pdf_bytes({"X-Max-Pdf-Bytes": str(app.HARD_MAX_PDF_BYTES)})
            == app.HARD_MAX_PDF_BYTES
        )

    def test_header_value_above_hard_max_is_clamped(self):
        # Defense-in-depth: a compromised/misconfigured Worker must not be able
        # to remove the size floor by sending an arbitrarily large limit.
        assert (
            app.effective_max_pdf_bytes({"X-Max-Pdf-Bytes": str(10**18)})
            == app.HARD_MAX_PDF_BYTES
        )


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
        with mock.patch.object(app, "read_pdf_metadata", return_value=("日本語 T", 1)):
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

    def test_convert_header_limit_overrides_default(self, server):
        # The Worker's X-Max-Pdf-Bytes wins over the module default: a body
        # under MAX_PDF_BYTES but over the header limit is still rejected.
        with mock.patch.object(app, "MAX_PDF_BYTES", 10_000):
            status, _, body = request(
                server,
                "POST",
                "/convert",
                body=FAKE_PDF,
                headers={"X-Max-Pdf-Bytes": "8"},
            )
        assert status == 413
        assert "exceeds the 8 byte limit" in json.loads(body)["error"]

    def test_convert_invalid_header_limit_falls_back_to_default(self, server):
        # A non-numeric header is ignored; the module default applies.
        with mock.patch.object(app, "MAX_PDF_BYTES", 8):
            status, _, body = request(
                server,
                "POST",
                "/convert",
                body=FAKE_PDF,
                headers={"X-Max-Pdf-Bytes": "not-a-number"},
            )
        assert status == 413
        assert "exceeds the 8 byte limit" in json.loads(body)["error"]

    def test_convert_header_limit_raises_above_default(self, server):
        # The intended direction: the Worker raises X-Max-Pdf-Bytes above the
        # module default, so a body over the default still converts.
        with mock.patch.object(app, "MAX_PDF_BYTES", 8):
            with mock.patch.object(app.subprocess, "run", side_effect=run_success):
                status, headers, body = request(
                    server,
                    "POST",
                    "/convert",
                    body=FAKE_PDF,
                    headers={"X-Max-Pdf-Bytes": str(len(FAKE_PDF) + 1)},
                )
        assert status == 200
        assert headers["Content-Type"] == "application/octet-stream"
        assert body == FAKE_XTC

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
            return "", 1

        with mock.patch.object(app, "CONVERSION_SLOTS", slot):
            with mock.patch.object(
                app, "read_pdf_metadata", side_effect=probing_extract
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
