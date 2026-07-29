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
import types
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
        # page_count = threshold + 1 pins the tightest boundary: one full
        # CHUNK_SIZE_PAGES chunk plus a 1-page remainder. These literal page
        # numbers (81/80/81) are current-default values on purpose -- if
        # CHUNK_THRESHOLD_PAGES or CHUNK_SIZE_PAGES ever changes again, this
        # test should fail loudly rather than silently follow the new value.
        calls = []
        with mock.patch.object(
            app.subprocess, "run", side_effect=self._recording_run(calls)
        ):
            result = app.convert_pdf(FAKE_PDF, page_count=81)
        assert result == FAKE_XTC
        assert len(calls) == 3
        (chunk1,) = self._sources(calls[0])
        (chunk2,) = self._sources(calls[1])
        assert chunk1.endswith("source.pdf:1-80")
        assert chunk2.endswith("source.pdf:81-81")
        # The repack step consumes exactly the chunk outputs, in page order.
        chunk_outputs = [cmd[cmd.index("-o") + 1] for cmd in calls[:2]]
        assert self._sources(calls[2]) == chunk_outputs
        assert all(path.endswith(".xtc") for path in chunk_outputs)

    def test_chunk_failure_raises_with_stage_name(self):
        def run(cmd, **kwargs):
            if any(str(part).endswith(":81-81") for part in cmd):
                return run_failure(cmd, **kwargs)
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=run):
            with pytest.raises(app.ConversionError) as excinfo:
                app.convert_pdf(FAKE_PDF, page_count=81)
        assert "chunk 2/2 pages 81-81" in str(excinfo.value)
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


class TestChunkSizeInvariant:
    def test_chunk_size_does_not_exceed_threshold(self):
        # app.py's chunking comment promises "a single xtctool invocation
        # rasterizes at most CHUNK_SIZE_PAGES pages at once" for *every* PDF,
        # including ones just at or under CHUNK_THRESHOLD_PAGES (which are
        # still sent through in one single-pass call). If CHUNK_SIZE_PAGES
        # ever exceeds CHUNK_THRESHOLD_PAGES, that single-pass call could
        # rasterize more pages than the chunked path ever would, defeating
        # the memory bound this whole feature exists for.
        #
        # This only checks the module's actual load-time default values; it
        # would stay green even if the clamp enforcing the invariant were
        # removed, as long as the two defaults themselves happened to agree.
        # See TestClampChunkSizeToThreshold below for a test of the clamp
        # itself, including the env-override scenario the invariant is
        # actually meant to guard against.
        assert app.CHUNK_SIZE_PAGES <= app.CHUNK_THRESHOLD_PAGES


class TestClampChunkSizeToThreshold:
    def test_within_threshold_is_unchanged(self, caplog):
        with caplog.at_level(logging.WARNING, logger="converter"):
            assert app._clamp_chunk_size_to_threshold(80, 80) == 80
        assert caplog.text == ""

    def test_env_override_of_chunk_size_alone_is_clamped(self, caplog):
        # Reproduces the scenario the invariant exists to prevent: only
        # XTC_CHUNK_SIZE_PAGES is overridden (e.g. to 200) while
        # XTC_CHUNK_THRESHOLD_PAGES stays at its default (80). Without the
        # clamp, an 81-200 page PDF would take the single-pass path (see
        # convert_pdf) and rasterize up to 200 pages in one xtctool call --
        # the same OOM/timeout shape chunking exists to avoid.
        with caplog.at_level(logging.WARNING, logger="converter"):
            clamped = app._clamp_chunk_size_to_threshold(200, 80)
        assert clamped == 80
        assert clamped <= 80
        assert "XTC_CHUNK_SIZE_PAGES" in caplog.text
        assert "200" in caplog.text
        assert "80" in caplog.text


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


class TestConvertPdfConfigPath:
    """convert_pdf's config_path parameter (spec: X4 device support) selects
    the BASE config -- the one read back for title/author/chapters merges,
    and used as-is when there is nothing to merge. Defaulting to None means
    app.CONFIG_PATH (X3), exactly as before this parameter existed."""

    def test_default_config_path_is_config_path(self):
        calls = []

        def recording_run(cmd, **kwargs):
            calls.append(cmd)
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            assert app.convert_pdf(FAKE_PDF) == FAKE_XTC
        assert calls[0][calls[0].index("-c") + 1] == app.CONFIG_PATH

    def test_explicit_config_path_is_used_without_title_or_author(self):
        calls = []

        def recording_run(cmd, **kwargs):
            calls.append(cmd)
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            assert (
                app.convert_pdf(FAKE_PDF, config_path=app.CONFIG_PATH_X4) == FAKE_XTC
            )
        assert calls[0][calls[0].index("-c") + 1] == app.CONFIG_PATH_X4

    def test_explicit_config_path_is_the_base_for_a_title_merge(self, tmp_path):
        config_path = tmp_path / "config-x4.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        seen = {}

        def inspecting_run(cmd, **kwargs):
            merged_path = Path(cmd[cmd.index("-c") + 1])
            seen["config_path"] = str(merged_path)
            seen["config"] = tomllib.loads(merged_path.read_text(encoding="utf-8"))
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=inspecting_run):
            assert (
                app.convert_pdf(
                    FAKE_PDF, "タイトル", config_path=str(config_path)
                )
                == FAKE_XTC
            )
        assert seen["config_path"] != str(config_path)  # merged into a temp file
        assert seen["config"]["output"]["title"] == "タイトル"
        assert seen["config"]["output"]["width"] == 528  # from SAMPLE_CONFIG

    def test_explicit_config_path_is_the_base_for_a_chapters_merge(self, tmp_path):
        config_path = tmp_path / "config-x4.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        chapters = [{"name": "第一章", "start_page": 0, "end_page": 3}]
        seen = {}

        def inspecting_run(cmd, **kwargs):
            merged_path = Path(cmd[cmd.index("-c") + 1])
            seen["config"] = tomllib.loads(merged_path.read_text(encoding="utf-8"))
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=inspecting_run):
            assert (
                app.convert_pdf(
                    FAKE_PDF, chapters=chapters, config_path=str(config_path)
                )
                == FAKE_XTC
            )
        assert seen["config"]["chapters"] == chapters
        assert seen["config"]["output"]["width"] == 528  # from SAMPLE_CONFIG


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


class TestResolveDevice:
    """X-Xtc-Device (spec: X4 device support) is a raw ASCII "x3"/"x4" value
    -- unlike every other X-Xtc-* header in this module, it is NOT
    base64url-encoded, per the contract agreed with the Worker side. Missing/
    unrecognized values must fall back to "x3" so every pre-X4 Worker
    request (which never sends this header) stays byte-for-byte unaffected."""

    def test_x3_header_resolves_to_x3(self):
        assert app.resolve_device({"X-Xtc-Device": "x3"}) == "x3"

    def test_x4_header_resolves_to_x4(self):
        assert app.resolve_device({"X-Xtc-Device": "x4"}) == "x4"

    def test_missing_header_falls_back_to_x3(self):
        assert app.resolve_device({}) == "x3"

    def test_invalid_value_falls_back_to_x3(self):
        assert app.resolve_device({"X-Xtc-Device": "x9000"}) == "x3"
        assert app.resolve_device({"X-Xtc-Device": ""}) == "x3"
        assert app.resolve_device({"X-Xtc-Device": "X4"}) == "x3"  # case-sensitive


class TestResolveConfigPath:
    def test_x3_resolves_to_config_path(self):
        assert app.resolve_config_path("x3") == app.CONFIG_PATH

    def test_x4_resolves_to_config_path_x4(self):
        assert app.resolve_config_path("x4") == app.CONFIG_PATH_X4

    def test_unknown_device_falls_back_to_config_path(self):
        assert app.resolve_config_path("bogus") == app.CONFIG_PATH

    def test_reads_config_path_globals_at_call_time(self):
        # resolve_config_path must respect mock.patch.object(app,
        # "CONFIG_PATH"/"CONFIG_PATH_X4", ...) rather than a value captured
        # once at import time (e.g. via a pre-built {device: path} dict).
        with mock.patch.object(app, "CONFIG_PATH", "/patched/x3.toml"):
            assert app.resolve_config_path("x3") == "/patched/x3.toml"
        with mock.patch.object(app, "CONFIG_PATH_X4", "/patched/x4.toml"):
            assert app.resolve_config_path("x4") == "/patched/x4.toml"


class TestConfigFilesX3X4:
    """Sanity-checks the shipped config-x3.toml/config-x4.toml files
    themselves (not app.CONFIG_PATH/CONFIG_PATH_X4, which default to the
    /app/... in-container paths and are not present in this checkout)."""

    _CONVERTER_DIR = Path(__file__).resolve().parents[2] / "converter"

    def test_x3_config_resolution(self):
        config = tomllib.loads(
            (self._CONVERTER_DIR / "config-x3.toml").read_text(encoding="utf-8")
        )
        assert (config["output"]["width"], config["output"]["height"]) == (528, 792)

    def test_x4_config_resolution(self):
        config = tomllib.loads(
            (self._CONVERTER_DIR / "config-x4.toml").read_text(encoding="utf-8")
        )
        assert (config["output"]["width"], config["output"]["height"]) == (480, 800)

    def test_x4_config_matches_x3_config_except_output_dimensions(self):
        # Every other setting (fonts/margins implied by resample_method,
        # [pdf].resolution, [xth]/[xtg] thresholds/dithering, etc.) must stay
        # identical between the two devices -- X4 support is only supposed
        # to change the output resolution.
        x3 = tomllib.loads(
            (self._CONVERTER_DIR / "config-x3.toml").read_text(encoding="utf-8")
        )
        x4 = tomllib.loads(
            (self._CONVERTER_DIR / "config-x4.toml").read_text(encoding="utf-8")
        )
        x3_output = {k: v for k, v in x3["output"].items() if k not in ("width", "height")}
        x4_output = {k: v for k, v in x4["output"].items() if k not in ("width", "height")}
        assert x3_output == x4_output
        assert x3["pdf"] == x4["pdf"]
        assert x3["xth"] == x4["xth"]
        assert x3["xtg"] == x4["xtg"]


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


class TestHandleConvertWithDeviceHeader:
    """X-Xtc-Device (spec: X4 device support) selects the config passed to
    xtctool -c. Absent or invalid values must fall back to X3 -- the whole
    point being that every pre-X4 Worker request (which never sends this
    header) stays byte-for-byte unaffected."""

    def test_x4_header_selects_config_path_x4(self, server):
        calls = []

        def recording_run(cmd, **kwargs):
            calls.append(cmd)
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            status, _, body = request(
                server,
                "POST",
                "/convert",
                body=FAKE_PDF,
                headers={"X-Xtc-Device": "x4"},
            )
        assert status == 200
        assert body == FAKE_XTC
        assert calls[0][calls[0].index("-c") + 1] == app.CONFIG_PATH_X4

    def test_x3_header_selects_config_path(self, server):
        calls = []

        def recording_run(cmd, **kwargs):
            calls.append(cmd)
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            status, _, body = request(
                server,
                "POST",
                "/convert",
                body=FAKE_PDF,
                headers={"X-Xtc-Device": "x3"},
            )
        assert status == 200
        assert body == FAKE_XTC
        assert calls[0][calls[0].index("-c") + 1] == app.CONFIG_PATH

    def test_missing_device_header_falls_back_to_config_path(self, server):
        # Every pre-X4 Worker request (URL-render pipeline, TXT-upload
        # pipeline) never sends X-Xtc-Device at all; must stay unaffected.
        calls = []

        def recording_run(cmd, **kwargs):
            calls.append(cmd)
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            status, _, body = request(server, "POST", "/convert", body=FAKE_PDF)
        assert status == 200
        assert body == FAKE_XTC
        assert calls[0][calls[0].index("-c") + 1] == app.CONFIG_PATH

    def test_invalid_device_header_falls_back_to_config_path(self, server):
        calls = []

        def recording_run(cmd, **kwargs):
            calls.append(cmd)
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            status, _, body = request(
                server,
                "POST",
                "/convert",
                body=FAKE_PDF,
                headers={"X-Xtc-Device": "not-a-real-device"},
            )
        assert status == 200
        assert body == FAKE_XTC
        assert calls[0][calls[0].index("-c") + 1] == app.CONFIG_PATH


def _b64url_json(payload) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).rstrip(b"=").decode(
        "ascii"
    )


class TestDecodeChaptersHeader:
    """X-Xtc-Chapters: base64url JSON array of {"name","marker"} objects, in
    chapter order (see app.py's module docstring). Malformed input fails
    soft to [] -- chapters are a nice-to-have, never something that should
    block a conversion."""

    def test_decodes_valid_header(self):
        payload = [
            {"name": "第一章 その名", "marker": "XTCCH0001"},
            {"name": "第二章", "marker": "XTCCH0002"},
        ]
        assert app.decode_chapters_header(_b64url_json(payload)) == payload

    def test_missing_marker_defaults_to_empty_string(self):
        payload = [{"name": "第一章"}]
        assert app.decode_chapters_header(_b64url_json(payload)) == [
            {"name": "第一章", "marker": ""}
        ]

    def test_non_string_marker_defaults_to_empty_string(self):
        payload = [{"name": "第一章", "marker": 123}]
        assert app.decode_chapters_header(_b64url_json(payload)) == [
            {"name": "第一章", "marker": ""}
        ]

    def test_entries_missing_a_name_are_dropped(self):
        payload = [
            {"marker": "XTCCH0001"},
            {"name": "", "marker": "XTCCH0002"},
            {"name": 123, "marker": "XTCCH0003"},
            {"name": "OK", "marker": "XTCCH0004"},
        ]
        assert app.decode_chapters_header(_b64url_json(payload)) == [
            {"name": "OK", "marker": "XTCCH0004"}
        ]

    def test_non_dict_entries_are_skipped(self):
        payload = ["not-a-dict", {"name": "OK"}]
        assert app.decode_chapters_header(_b64url_json(payload)) == [
            {"name": "OK", "marker": ""}
        ]

    def test_malformed_base64_is_empty_list(self):
        assert app.decode_chapters_header("not valid base64url!!") == []

    def test_non_json_payload_is_empty_list(self):
        encoded = base64.urlsafe_b64encode(b"not json").rstrip(b"=").decode("ascii")
        assert app.decode_chapters_header(encoded) == []

    def test_non_array_payload_is_empty_list(self):
        assert app.decode_chapters_header(_b64url_json({"name": "x"})) == []

    def test_empty_header_is_empty_list(self):
        assert app.decode_chapters_header("") == []


class TestDecodeChaptersHeaderDiagnostics:
    """decode_chapters_header's optional diagnostics dict (see its
    docstring): populated for /convert's X-Xtc-Chapters-Status response
    header, never changes the (still fail-soft) return value."""

    def test_valid_header_does_not_set_decode_failed(self):
        diagnostics = {}
        payload = [{"name": "第一章", "marker": "XTCCH0001"}]
        app.decode_chapters_header(_b64url_json(payload), diagnostics)
        assert "decode_failed" not in diagnostics

    def test_malformed_base64_sets_decode_failed(self):
        diagnostics = {}
        app.decode_chapters_header("not valid base64url!!", diagnostics)
        assert diagnostics["decode_failed"] is True

    def test_non_json_payload_sets_decode_failed(self):
        diagnostics = {}
        encoded = base64.urlsafe_b64encode(b"not json").rstrip(b"=").decode("ascii")
        app.decode_chapters_header(encoded, diagnostics)
        assert diagnostics["decode_failed"] is True

    def test_non_array_payload_sets_decode_failed(self):
        diagnostics = {}
        app.decode_chapters_header(_b64url_json({"name": "x"}), diagnostics)
        assert diagnostics["decode_failed"] is True

    def test_valid_but_entirely_filtered_array_does_not_set_decode_failed(self):
        # The header itself decoded fine; every entry was individually
        # dropped for missing a name. That is normal per-entry filtering,
        # not a header decode failure.
        diagnostics = {}
        payload = [{"marker": "XTCCH0001"}, {"name": "", "marker": "XTCCH0002"}]
        result = app.decode_chapters_header(_b64url_json(payload), diagnostics)
        assert result == []
        assert "decode_failed" not in diagnostics

    def test_no_diagnostics_dict_does_not_raise(self):
        # The default (diagnostics=None) must stay safe -- every existing
        # caller/test omits it.
        assert app.decode_chapters_header("not valid base64url!!") == []


class TestNormalizeSearchText:
    def test_strips_ascii_whitespace(self):
        assert app.normalize_search_text("a b\tc\nd\r") == "abcd"

    def test_strips_fullwidth_ideographic_space(self):
        assert app.normalize_search_text("第一章　その名") == "第一章その名"

    def test_leaves_non_whitespace_untouched(self):
        assert app.normalize_search_text("第一章その名123abc") == "第一章その名123abc"

    def test_empty_string(self):
        assert app.normalize_search_text("") == ""


def _fake_pymupdf_with_pages(page_texts: list[str]) -> mock.MagicMock:
    """Builds a fake `pymupdf` module whose `.open(...)` context manager
    yields an iterable of fake pages, each returning a fixed get_text()
    value -- mirrors TestTitleHandling's fake_pymupdf pattern above."""
    fake_doc = mock.MagicMock()
    fake_doc.__iter__.return_value = iter(
        types.SimpleNamespace(get_text=(lambda t=t: t)) for t in page_texts
    )
    fake_pymupdf = mock.MagicMock()
    fake_pymupdf.open.return_value.__enter__.return_value = fake_doc
    return fake_pymupdf


class TestDetectChapterPages:
    """Detection is by marker string only -- a chapter whose marker is not
    found on any page is simply dropped (see
    test_missing_marker_is_not_matched_by_name), never falling back to a
    name-based text search (an unrelated page, such as an early table of
    contents that lists every chapter title, matching a chapter's heading
    name by coincidence is a real risk for short/generic headings, and
    binding a chapter to the wrong page is a worse outcome than dropping
    that chapter's metadata entirely). The search runs against
    whitespace-stripped text (vertical-writing PDFs can inject spurious
    whitespace/line breaks into pymupdf's text extraction)."""

    def test_finds_by_marker(self):
        pages = ["intro page", "XTCCH0001 chapter one text", "more", "XTCCH0002 chapter two"]
        chapters = [
            {"name": "第一章", "marker": "XTCCH0001"},
            {"name": "第二章", "marker": "XTCCH0002"},
        ]
        with mock.patch.object(app, "pymupdf", _fake_pymupdf_with_pages(pages)):
            located = app.detect_chapter_pages(b"fake", chapters)
        assert located == [
            {"name": "第一章", "start_page": 1},
            {"name": "第二章", "start_page": 3},
        ]

    def test_marker_match_survives_injected_whitespace(self):
        pages = ["intro", "X T C C H 0 0 0 1\n chapter one"]
        chapters = [{"name": "第一章", "marker": "XTCCH0001"}]
        with mock.patch.object(app, "pymupdf", _fake_pymupdf_with_pages(pages)):
            located = app.detect_chapter_pages(b"fake", chapters)
        assert located == [{"name": "第一章", "start_page": 1}]

    def test_missing_marker_is_not_matched_by_name(self):
        # Chapter 1's marker is found normally. Chapter 2's marker is
        # missing/empty, but its name DOES appear in the page text -- this
        # must NOT be used to locate it (no name-based fallback), so chapter
        # 2 is simply dropped from the result.
        pages = ["intro", "XTCCH0001 first chapter", "第二章 その名\nbody text"]
        chapters = [
            {"name": "第一章", "marker": "XTCCH0001"},
            {"name": "第二章 その名", "marker": ""},
        ]
        with mock.patch.object(app, "pymupdf", _fake_pymupdf_with_pages(pages)):
            located = app.detect_chapter_pages(b"fake", chapters)
        assert located == [{"name": "第一章", "start_page": 1}]

    def test_all_markers_missing_returns_empty(self):
        # None of the configured chapters' markers match anywhere -- e.g.
        # Chromium dropped the invisible marker spans from the PDF text
        # layer entirely. Both chapter names happen to appear, in order, on
        # an early table-of-contents-like page; since there is no name-based
        # fallback, none of that matters and the whole result is empty.
        pages = ["第一章\n第二章", "intro", "real chapter one body", "real chapter two body"]
        chapters = [
            {"name": "第一章", "marker": "XTCCH0001"},
            {"name": "第二章", "marker": "XTCCH0002"},
        ]
        with mock.patch.object(app, "pymupdf", _fake_pymupdf_with_pages(pages)):
            located = app.detect_chapter_pages(b"fake", chapters)
        assert located == []

    def test_chapter_not_found_by_marker_is_dropped_and_logged(self, caplog):
        # Chapter 1's marker is found; chapter 2's marker matches nothing.
        pages = ["XTCCH0001 first chapter, nothing else relevant"]
        chapters = [
            {"name": "第一章", "marker": "XTCCH0001"},
            {"name": "存在しない章", "marker": "XTCCH_GONE"},
        ]
        with caplog.at_level(logging.INFO, logger="converter"):
            with mock.patch.object(app, "pymupdf", _fake_pymupdf_with_pages(pages)):
                located = app.detect_chapter_pages(b"fake", chapters)
        assert located == [{"name": "第一章", "start_page": 0}]
        assert "marker not found" in caplog.text

    def test_non_monotonic_detection_is_dropped_as_a_false_match(self, caplog):
        # Chapter 2's marker actually appears on an EARLIER page than
        # chapter 1's -- almost certainly a false positive -- so it must be
        # dropped rather than silently reordered or accepted.
        pages = ["intro", "XTCCH0002 mistaken early match", "XTCCH0001 real first chapter"]
        chapters = [
            {"name": "第一章", "marker": "XTCCH0001"},
            {"name": "第二章", "marker": "XTCCH0002"},
        ]
        with caplog.at_level(logging.WARNING, logger="converter"):
            with mock.patch.object(app, "pymupdf", _fake_pymupdf_with_pages(pages)):
                located = app.detect_chapter_pages(b"fake", chapters)
        assert located == [{"name": "第一章", "start_page": 2}]
        assert "does not follow previous" in caplog.text

    def test_no_pymupdf_returns_empty(self):
        with mock.patch.object(app, "pymupdf", None):
            assert app.detect_chapter_pages(b"fake", [{"name": "x", "marker": "y"}]) == []

    def test_no_chapters_requested_returns_empty(self):
        assert app.detect_chapter_pages(b"fake", []) == []

    def test_read_failure_is_swallowed_and_logged(self, caplog):
        fake_pymupdf = mock.MagicMock()
        fake_pymupdf.open.side_effect = RuntimeError("broken pdf")
        with caplog.at_level(logging.ERROR, logger="converter"):
            with mock.patch.object(app, "pymupdf", fake_pymupdf):
                located = app.detect_chapter_pages(b"fake", [{"name": "x", "marker": "y"}])
        assert located == []
        assert "failed to read PDF text" in caplog.text

    def test_diagnostics_marks_detect_exception_on_read_failure(self):
        fake_pymupdf = mock.MagicMock()
        fake_pymupdf.open.side_effect = RuntimeError("broken pdf")
        diagnostics = {}
        with mock.patch.object(app, "pymupdf", fake_pymupdf):
            located = app.detect_chapter_pages(
                b"fake", [{"name": "x", "marker": "y"}], diagnostics
            )
        assert located == []
        assert diagnostics["detect_exception"] is True

    def test_diagnostics_not_marked_when_no_exception(self):
        pages = ["XTCCH0001 chapter one"]
        chapters = [{"name": "第一章", "marker": "XTCCH0001"}]
        diagnostics = {}
        with mock.patch.object(app, "pymupdf", _fake_pymupdf_with_pages(pages)):
            app.detect_chapter_pages(b"fake", chapters, diagnostics)
        assert "detect_exception" not in diagnostics


class TestBuildChapterEntries:
    def test_end_page_is_next_start_minus_one(self):
        located = [
            {"name": "第一章", "start_page": 0},
            {"name": "第二章", "start_page": 5},
            {"name": "第三章", "start_page": 12},
        ]
        assert app.build_chapter_entries(located, total_pages=20) == [
            {"name": "第一章", "start_page": 0, "end_page": 4},
            {"name": "第二章", "start_page": 5, "end_page": 11},
            {"name": "第三章", "start_page": 12, "end_page": 19},
        ]

    def test_last_chapter_end_page_is_total_pages_minus_one(self):
        located = [{"name": "全部", "start_page": 0}]
        assert app.build_chapter_entries(located, total_pages=7) == [
            {"name": "全部", "start_page": 0, "end_page": 6}
        ]

    def test_out_of_range_entry_is_dropped_and_logged(self, caplog):
        located = [{"name": "大きすぎる", "start_page": 0}]
        with caplog.at_level(logging.WARNING, logger="converter"):
            entries = app.build_chapter_entries(located, total_pages=70000)
        assert entries == []
        assert "out of the" in caplog.text

    def test_end_page_at_0xfffe_boundary_is_kept(self):
        # 0xFFFE is the largest 0-based value xtctool-chapters.patch's +1
        # on-disk conversion can represent (0xFFFE + 1 == 0xFFFF, the max
        # uint16); total_pages=0xFFFF means end_page == total_pages - 1 ==
        # 0xFFFE exactly.
        located = [{"name": "境界", "start_page": 0}]
        entries = app.build_chapter_entries(located, total_pages=0xFFFF)
        assert entries == [{"name": "境界", "start_page": 0, "end_page": 0xFFFE}]

    def test_end_page_at_0xffff_is_dropped(self):
        # One page beyond the 0xFFFE boundary: total_pages=0x10000 would
        # make end_page == 0xFFFF, which would overflow the on-disk uint16
        # after xtctool-chapters.patch's +1 -- must be dropped, not written.
        located = [{"name": "境界超え", "start_page": 0}]
        entries = app.build_chapter_entries(located, total_pages=0x10000)
        assert entries == []

    def test_name_is_truncated_utf8_safely(self):
        long_name = "章" * 100  # 3 bytes/char in UTF-8 -> 300 bytes, way over the limit
        (entry,) = app.build_chapter_entries(
            [{"name": long_name, "start_page": 0}], total_pages=5
        )
        assert len(entry["name"].encode("utf-8")) <= app.MAX_CHAPTER_NAME_BYTES
        assert long_name.startswith(entry["name"])
        # A partial multi-byte character must never be written -- round-trip
        # through UTF-8 must not raise or lose data.
        assert entry["name"].encode("utf-8").decode("utf-8") == entry["name"]

    def test_empty_located_returns_empty(self):
        assert app.build_chapter_entries([], total_pages=10) == []

    def test_unpaired_surrogate_in_name_is_skipped_not_raised(self, caplog):
        # json.loads happily decodes an unpaired UTF-16 surrogate (e.g.
        # "\ud800") into a plain str -- decode_chapters_header's
        # isinstance(name, str) check passes it right through -- but it can
        # never be UTF-8 encoded. This must drop just that chapter (logged),
        # never raise all the way out to Handler.do_POST and fail the whole
        # conversion (reproduction from the change-reviewer's report).
        located = [{"name": "\ud800bad", "start_page": 0}]
        with caplog.at_level(logging.WARNING, logger="converter"):
            entries = app.build_chapter_entries(located, total_pages=10)
        assert entries == []
        assert "cannot be encoded as UTF-8" in caplog.text

    def test_unpaired_surrogate_chapter_does_not_block_other_chapters(self):
        located = [
            {"name": "第一章", "start_page": 0},
            {"name": "\ud800bad", "start_page": 5},
            {"name": "第三章", "start_page": 8},
        ]
        entries = app.build_chapter_entries(located, total_pages=12)
        assert entries == [
            {"name": "第一章", "start_page": 0, "end_page": 4},
            {"name": "第三章", "start_page": 8, "end_page": 11},
        ]


class TestTruncateUtf8Bytes:
    def test_short_text_is_unchanged(self):
        assert app.truncate_utf8_bytes("hello", 79) == "hello"

    def test_truncates_without_splitting_a_multibyte_character(self):
        text = "あ" * 30  # 3 bytes each = 90 bytes total, over the 79-byte budget
        truncated = app.truncate_utf8_bytes(text, 79)
        encoded = truncated.encode("utf-8")
        assert len(encoded) <= 79
        # A mid-character cut would raise UnicodeDecodeError here.
        assert encoded.decode("utf-8") == truncated
        assert text.startswith(truncated)

    def test_exact_boundary_is_not_truncated_further(self):
        text = "a" * 79
        assert app.truncate_utf8_bytes(text, 79) == text

    def test_empty_text(self):
        assert app.truncate_utf8_bytes("", 79) == ""


class TestResolveChapters:
    def test_empty_spec_returns_empty(self):
        assert app.resolve_chapters(b"pdf", [], 10) == []

    def test_unknown_page_count_returns_empty_and_warns(self, caplog):
        with caplog.at_level(logging.WARNING, logger="converter"):
            result = app.resolve_chapters(b"pdf", [{"name": "x", "marker": "y"}], None)
        assert result == []
        assert "page count is unavailable" in caplog.text

    def test_zero_page_count_returns_empty(self):
        assert app.resolve_chapters(b"pdf", [{"name": "x", "marker": "y"}], 0) == []

    def test_full_pipeline_with_real_pymupdf(self):
        pymupdf = pytest.importorskip("pymupdf")
        doc = pymupdf.open()
        for i in range(4):
            page = doc.new_page()
            if i == 1:
                page.insert_text((72, 72), "XTCCH0001 First Chapter")
            if i == 3:
                page.insert_text((72, 72), "XTCCH0002 Second Chapter")
        pdf_bytes = doc.tobytes()
        chapters_spec = [
            {"name": "First Chapter", "marker": "XTCCH0001"},
            {"name": "Second Chapter", "marker": "XTCCH0002"},
        ]
        result = app.resolve_chapters(pdf_bytes, chapters_spec, doc.page_count)
        assert result == [
            {"name": "First Chapter", "start_page": 1, "end_page": 2},
            {"name": "Second Chapter", "start_page": 3, "end_page": 3},
        ]

    def test_no_chapters_located_returns_empty(self):
        pages = ["nothing relevant"]
        with mock.patch.object(app, "pymupdf", _fake_pymupdf_with_pages(pages)):
            result = app.resolve_chapters(b"pdf", [{"name": "x", "marker": "y"}], 1)
        assert result == []


class TestResolveChaptersDiagnostics:
    """resolve_chapters' optional diagnostics dict (see its docstring):
    populated for /convert's X-Xtc-Chapters-Status response header, never
    changes the (still fail-soft) return value."""

    def test_none_page_count_sets_pdf_metadata_failed(self):
        diagnostics = {}
        result = app.resolve_chapters(
            b"pdf", [{"name": "x", "marker": "y"}], None, diagnostics
        )
        assert result == []
        assert diagnostics["status"] == "pdf-metadata-failed"

    def test_zero_page_count_sets_no_markers_found(self):
        diagnostics = {}
        result = app.resolve_chapters(
            b"pdf", [{"name": "x", "marker": "y"}], 0, diagnostics
        )
        assert result == []
        assert diagnostics["status"] == "no-markers-found"

    def test_detect_exception_sets_detect_exception_status(self):
        fake_pymupdf = mock.MagicMock()
        fake_pymupdf.open.side_effect = RuntimeError("broken pdf")
        diagnostics = {}
        with mock.patch.object(app, "pymupdf", fake_pymupdf):
            result = app.resolve_chapters(
                b"pdf", [{"name": "x", "marker": "y"}], 3, diagnostics
            )
        assert result == []
        assert diagnostics["status"] == "detect-exception"

    def test_no_markers_located_sets_no_markers_found_status(self):
        pages = ["nothing relevant"]
        diagnostics = {}
        with mock.patch.object(app, "pymupdf", _fake_pymupdf_with_pages(pages)):
            result = app.resolve_chapters(
                b"pdf", [{"name": "x", "marker": "XTCCH0001"}], 1, diagnostics
            )
        assert result == []
        assert diagnostics["status"] == "no-markers-found"

    def test_partial_detection_sets_partial_status(self):
        pages = ["intro", "XTCCH0001 chapter one"]
        chapters_spec = [
            {"name": "第一章", "marker": "XTCCH0001"},
            {"name": "第二章", "marker": "XTCCH0002"},
        ]
        diagnostics = {}
        with mock.patch.object(app, "pymupdf", _fake_pymupdf_with_pages(pages)):
            result = app.resolve_chapters(b"pdf", chapters_spec, 2, diagnostics)
        assert len(result) == 1
        assert diagnostics["status"] == "partial"

    def test_all_located_sets_ok_status(self):
        pages = ["intro", "XTCCH0001 chapter one", "XTCCH0002 chapter two"]
        chapters_spec = [
            {"name": "第一章", "marker": "XTCCH0001"},
            {"name": "第二章", "marker": "XTCCH0002"},
        ]
        diagnostics = {}
        with mock.patch.object(app, "pymupdf", _fake_pymupdf_with_pages(pages)):
            result = app.resolve_chapters(b"pdf", chapters_spec, 3, diagnostics)
        assert len(result) == 2
        assert diagnostics["status"] == "ok"

    def test_empty_chapters_spec_leaves_diagnostics_untouched(self):
        diagnostics = {}
        assert app.resolve_chapters(b"pdf", [], 10, diagnostics) == []
        assert diagnostics == {}

    def test_no_diagnostics_dict_does_not_raise(self):
        # The default (diagnostics=None) must stay safe -- every existing
        # caller/test omits it.
        assert app.resolve_chapters(b"pdf", [{"name": "x", "marker": "y"}], None) == []


class TestTomlChaptersBlock:
    def test_serializes_as_array_of_tables(self):
        chapters = [
            {"name": "第一章", "start_page": 0, "end_page": 4},
            {"name": "第二章", "start_page": 5, "end_page": 9},
        ]
        text = app._toml_chapters_block(chapters)
        parsed = tomllib.loads(text)
        assert parsed == {"chapters": chapters}

    def test_config_with_title_author_chapters_appends_valid_toml(self, tmp_path):
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        chapters = [
            {"name": "第一章", "start_page": 0, "end_page": 4},
            {"name": "第二章", "start_page": 5, "end_page": 9},
        ]
        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            merged = tomllib.loads(
                app.config_with_title_author_chapters("タイトル", "著者", chapters)
            )
        assert merged["output"]["title"] == "タイトル"
        assert merged["output"]["author"] == "著者"
        # The rest of the base config survives untouched, types intact.
        assert merged["output"]["width"] == 528
        assert merged["xtg"]["dither_strength"] == 0.8
        assert merged["chapters"] == chapters

    def test_chapters_only_still_merges_without_title_or_author(self, tmp_path):
        # A chapters-only call (title="" and author="") must still trigger
        # the merge -- same "don't silently skip because title is falsy"
        # stance as TestAuthorHandling's author-only case.
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        chapters = [{"name": "第一章", "start_page": 0, "end_page": 4}]
        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            merged = tomllib.loads(
                app.config_with_title_author_chapters("", "", chapters)
            )
        assert merged["chapters"] == chapters
        assert "author" not in merged["output"]

    def test_no_chapters_produces_no_chapters_key(self, tmp_path):
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            merged = tomllib.loads(app.config_with_title_author_chapters("T"))
        assert "chapters" not in merged

    def test_config_with_title_author_is_unaffected_alias(self, tmp_path):
        # Byte-for-byte backward compatibility: the existing entry points
        # must produce exactly what they did before chapters existed.
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            assert app.config_with_title_author("T", "A") == (
                app.config_with_title_author_chapters("T", "A")
            )


class TestConvertPdfWithChapters:
    """Chapters are only ever embedded into the FINAL xtctool invocation
    (single-pass, or the chunk-repack call) -- never into an intermediate
    per-chunk call, since those files are discarded once the repack step
    produces the final container."""

    def test_single_pass_config_includes_chapters(self, tmp_path):
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        chapters = [{"name": "第一章", "start_page": 0, "end_page": 3}]
        seen = {}

        def inspecting_run(cmd, **kwargs):
            merged_path = Path(cmd[cmd.index("-c") + 1])
            seen["config"] = tomllib.loads(merged_path.read_text(encoding="utf-8"))
            return run_success(cmd, **kwargs)

        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            with mock.patch.object(app.subprocess, "run", side_effect=inspecting_run):
                assert app.convert_pdf(FAKE_PDF, chapters=chapters) == FAKE_XTC
        assert seen["config"]["chapters"] == chapters

    def test_no_chapters_uses_base_config_unaffected(self):
        # Every existing /convert caller (no X-Xtc-Chapters header, or one
        # that resolves to zero chapters) must stay byte-for-byte the prior
        # behavior.
        calls = []

        def recording_run(cmd, **kwargs):
            calls.append(cmd)
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=recording_run):
            assert app.convert_pdf(FAKE_PDF, chapters=[]) == FAKE_XTC
            assert app.convert_pdf(FAKE_PDF) == FAKE_XTC
        assert calls[0][calls[0].index("-c") + 1] == app.CONFIG_PATH
        assert calls[1][calls[1].index("-c") + 1] == app.CONFIG_PATH

    def test_chunked_conversion_only_embeds_chapters_in_the_repack_call(self, tmp_path):
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        chapters = [
            {"name": "第一章", "start_page": 0, "end_page": 79},
            {"name": "第二章", "start_page": 80, "end_page": 80},
        ]
        configs_seen = []

        def inspecting_run(cmd, **kwargs):
            merged_path = Path(cmd[cmd.index("-c") + 1])
            configs_seen.append(tomllib.loads(merged_path.read_text(encoding="utf-8")))
            return run_success(cmd, **kwargs)

        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            with mock.patch.object(app.subprocess, "run", side_effect=inspecting_run):
                assert (
                    app.convert_pdf(FAKE_PDF, page_count=81, chapters=chapters)
                    == FAKE_XTC
                )

        # 2 chunks + 1 repack call, matching TestChunkedConversion's shape.
        assert len(configs_seen) == 3
        assert "chapters" not in configs_seen[0]
        assert "chapters" not in configs_seen[1]
        assert configs_seen[2]["chapters"] == chapters

    def test_chapters_config_merge_failure_falls_back_without_chapters(self, caplog):
        # An unreadable CONFIG_PATH must not block the conversion -- same
        # stance as the pre-existing title/author merge-failure fallback.
        calls = []

        def recording_run(cmd, **kwargs):
            calls.append(cmd)
            return run_success(cmd, **kwargs)

        with caplog.at_level(logging.ERROR, logger="converter"):
            with mock.patch.object(app, "CONFIG_PATH", "/nonexistent/config.toml"):
                with mock.patch.object(
                    app.subprocess, "run", side_effect=recording_run
                ):
                    assert (
                        app.convert_pdf(
                            FAKE_PDF, chapters=[{"name": "x", "start_page": 0, "end_page": 0}]
                        )
                        == FAKE_XTC
                    )
        assert "chapters config merge failed" in caplog.text
        # Falls back to CONFIG_PATH itself (no title/author either, in this
        # test), exactly like the pre-existing title-merge-failure fallback.
        assert calls[0][calls[0].index("-c") + 1] == "/nonexistent/config.toml"

    def test_diagnostics_marks_chapters_config_merge_failed(self):
        # Same failure as the test above, but asserting on the diagnostics
        # dict (see convert_pdf's diagnostics parameter docstring) that
        # Handler._handle_convert uses to report X-Xtc-Chapters-Status:
        # config-merge-failed.
        diagnostics = {}
        with mock.patch.object(app, "CONFIG_PATH", "/nonexistent/config.toml"):
            with mock.patch.object(app.subprocess, "run", side_effect=run_success):
                app.convert_pdf(
                    FAKE_PDF,
                    chapters=[{"name": "x", "start_page": 0, "end_page": 0}],
                    diagnostics=diagnostics,
                )
        assert diagnostics["chapters_config_merge_failed"] is True

    def test_diagnostics_untouched_when_no_chapters_given(self):
        diagnostics = {}
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            app.convert_pdf(FAKE_PDF, diagnostics=diagnostics)
        assert diagnostics == {}

    def test_diagnostics_untouched_when_chapters_merge_succeeds(self, tmp_path):
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        diagnostics = {}
        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            with mock.patch.object(app.subprocess, "run", side_effect=run_success):
                app.convert_pdf(
                    FAKE_PDF,
                    chapters=[{"name": "x", "start_page": 0, "end_page": 0}],
                    diagnostics=diagnostics,
                )
        assert diagnostics == {}


class TestHandleConvertWithChaptersHeader:
    def test_chapters_header_resolves_and_merges_into_config(self, server, tmp_path):
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        seen = {}

        def inspecting_run(cmd, **kwargs):
            merged_path = Path(cmd[cmd.index("-c") + 1])
            seen["config"] = tomllib.loads(merged_path.read_text(encoding="utf-8"))
            return run_success(cmd, **kwargs)

        pages = ["intro", "XTCCH0001 chapter one"]
        chapters_header = _b64url_json([{"name": "第一章", "marker": "XTCCH0001"}])

        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            with mock.patch.object(
                app, "read_pdf_metadata", return_value=("", len(pages))
            ):
                with mock.patch.object(
                    app, "pymupdf", _fake_pymupdf_with_pages(pages)
                ):
                    with mock.patch.object(
                        app.subprocess, "run", side_effect=inspecting_run
                    ):
                        status, _, body = request(
                            server,
                            "POST",
                            "/convert",
                            body=FAKE_PDF,
                            headers={"X-Xtc-Chapters": chapters_header},
                        )
        assert status == 200
        assert body == FAKE_XTC
        assert seen["config"]["chapters"] == [
            {"name": "第一章", "start_page": 1, "end_page": 1}
        ]

    def test_missing_chapters_header_is_unaffected(self, server):
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            status, _, body = request(server, "POST", "/convert", body=FAKE_PDF)
        assert status == 200
        assert body == FAKE_XTC

    def test_malformed_chapters_header_does_not_fail_the_conversion(self, server):
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            status, _, body = request(
                server,
                "POST",
                "/convert",
                body=FAKE_PDF,
                headers={"X-Xtc-Chapters": "not valid base64url!!"},
            )
        assert status == 200
        assert body == FAKE_XTC

    def test_unpaired_surrogate_chapter_name_does_not_500_the_conversion(self, server):
        # Regression test for the change-reviewer's report: json.loads
        # happily decodes an unpaired UTF-16 surrogate into a plain str
        # (isinstance(name, str) in decode_chapters_header passes it
        # through), but truncate_utf8_bytes' text.encode("utf-8") previously
        # raised UnicodeEncodeError for it, uncaught all the way out to this
        # handler's generic `except Exception`, turning a should-have-
        # succeeded conversion into a 500. The whole conversion must still
        # succeed; only the offending chapter's metadata is dropped.
        pages = ["XTCCH0001 chapter one"]
        chapters_header = _b64url_json(
            [{"name": "\ud800bad", "marker": "XTCCH0001"}]
        )
        with mock.patch.object(app, "read_pdf_metadata", return_value=("", len(pages))):
            with mock.patch.object(app, "pymupdf", _fake_pymupdf_with_pages(pages)):
                with mock.patch.object(app.subprocess, "run", side_effect=run_success):
                    status, _, body = request(
                        server,
                        "POST",
                        "/convert",
                        body=FAKE_PDF,
                        headers={"X-Xtc-Chapters": chapters_header},
                    )
        assert status == 200
        assert body == FAKE_XTC


class TestChapterDetectionTimeoutBudget:
    """resolve_chapters runs a full-document pymupdf text-extraction pass
    (when X-Xtc-Chapters is present) BEFORE convert_pdf is ever called, but
    convert_pdf computes its own deadline as time.monotonic() + (whatever
    timeout_seconds it's given), starting fresh the moment it's called. Time
    spent on chapter detection must therefore come out of the budget handed
    to convert_pdf, not be granted for free on top of
    X-Convert-Timeout-Seconds."""

    def test_chapter_detection_time_is_subtracted_from_convert_pdf_timeout(self, server):
        clock = iter([0.0, 7.0])  # 7s "elapsed" during resolve_chapters
        captured = {}

        def fake_convert_pdf(pdf_bytes, title, timeout_seconds, page_count, author, chapters, diagnostics=None, config_path=None):
            captured["timeout_seconds"] = timeout_seconds
            return FAKE_XTC

        chapters_header = _b64url_json([{"name": "第一章", "marker": "XTCCH0001"}])
        with mock.patch.object(app.time, "monotonic", side_effect=lambda: next(clock)):
            with mock.patch.object(app, "read_pdf_metadata", return_value=("", 5)):
                with mock.patch.object(app, "resolve_chapters", return_value=[]):
                    with mock.patch.object(app, "convert_pdf", side_effect=fake_convert_pdf):
                        status, _, body = request(
                            server,
                            "POST",
                            "/convert",
                            body=FAKE_PDF,
                            headers={
                                "X-Xtc-Chapters": chapters_header,
                                "X-Convert-Timeout-Seconds": "100",
                            },
                        )
        assert status == 200
        assert body == FAKE_XTC
        assert captured["timeout_seconds"] == pytest.approx(93.0)

    def test_detection_time_exceeding_budget_floors_timeout_at_zero(self, server):
        clock = iter([0.0, 999.0])
        captured = {}

        def fake_convert_pdf(pdf_bytes, title, timeout_seconds, page_count, author, chapters, diagnostics=None, config_path=None):
            captured["timeout_seconds"] = timeout_seconds
            return FAKE_XTC

        chapters_header = _b64url_json([{"name": "第一章", "marker": "XTCCH0001"}])
        with mock.patch.object(app.time, "monotonic", side_effect=lambda: next(clock)):
            with mock.patch.object(app, "read_pdf_metadata", return_value=("", 5)):
                with mock.patch.object(app, "resolve_chapters", return_value=[]):
                    with mock.patch.object(app, "convert_pdf", side_effect=fake_convert_pdf):
                        status, _, body = request(
                            server,
                            "POST",
                            "/convert",
                            body=FAKE_PDF,
                            headers={
                                "X-Xtc-Chapters": chapters_header,
                                "X-Convert-Timeout-Seconds": "10",
                            },
                        )
        assert status == 200
        assert captured["timeout_seconds"] == 0.0

    def test_no_chapters_header_leaves_timeout_untouched(self, server):
        # No detection pass runs at all, so the exact header-derived timeout
        # is passed straight through -- unaffected by this budget
        # accounting, and by extension every pre-existing (no
        # X-Xtc-Chapters) /convert timeout test stays exact.
        captured = {}

        def fake_convert_pdf(pdf_bytes, title, timeout_seconds, page_count, author, chapters, diagnostics=None, config_path=None):
            captured["timeout_seconds"] = timeout_seconds
            return FAKE_XTC

        with mock.patch.object(app, "convert_pdf", side_effect=fake_convert_pdf):
            status, _, body = request(
                server,
                "POST",
                "/convert",
                body=FAKE_PDF,
                headers={"X-Convert-Timeout-Seconds": "5"},
            )
        assert status == 200
        assert body == FAKE_XTC
        assert captured["timeout_seconds"] == 5


class TestChaptersStatusForResponse:
    """chapters_status_for_response is the pure function that maps one
    /convert request's chapter-detection diagnostics into the
    X-Xtc-Chapters-Status response header value (see its docstring for the
    precedence order asserted here)."""

    def test_header_absent_is_not_requested(self):
        assert (
            app.chapters_status_for_response(False, 0, {}, False) == "not-requested"
        )

    def test_decode_failed_takes_precedence_over_config_merge_failed(self):
        assert (
            app.chapters_status_for_response(
                True, 0, {"decode_failed": True}, True
            )
            == "header-decode-failed"
        )

    def test_config_merge_failed_takes_precedence_over_requested_zero(self):
        assert app.chapters_status_for_response(True, 0, {}, True) == (
            "config-merge-failed"
        )

    def test_config_merge_failed_takes_precedence_over_resolve_status(self):
        assert app.chapters_status_for_response(
            True, 2, {"status": "ok"}, True
        ) == "config-merge-failed"

    def test_requested_zero_with_valid_header_is_ok(self):
        assert app.chapters_status_for_response(True, 0, {}, False) == "ok"

    def test_resolve_status_pdf_metadata_failed_is_relayed(self):
        assert (
            app.chapters_status_for_response(
                True, 1, {"status": "pdf-metadata-failed"}, False
            )
            == "pdf-metadata-failed"
        )

    def test_resolve_status_detect_exception_is_relayed(self):
        assert (
            app.chapters_status_for_response(
                True, 1, {"status": "detect-exception"}, False
            )
            == "detect-exception"
        )

    def test_resolve_status_no_markers_found_is_relayed(self):
        assert (
            app.chapters_status_for_response(
                True, 1, {"status": "no-markers-found"}, False
            )
            == "no-markers-found"
        )

    def test_resolve_status_partial_is_relayed(self):
        assert (
            app.chapters_status_for_response(True, 2, {"status": "partial"}, False)
            == "partial"
        )

    def test_resolve_status_ok_is_relayed(self):
        assert (
            app.chapters_status_for_response(True, 2, {"status": "ok"}, False)
            == "ok"
        )

    def test_missing_resolve_status_defaults_to_no_markers_found(self):
        # Defensive fallback: requested > 0 but resolve_chapters was never
        # actually called (should not happen via the real handler).
        assert app.chapters_status_for_response(True, 1, {}, False) == (
            "no-markers-found"
        )


class TestChaptersDiagnosticsResponseHeaders:
    """End-to-end: /convert's X-Xtc-Chapters-Requested/-Detected/-Status and
    X-Xtc-Page-Count response headers (see this module's docstring and
    chapters_status_for_response), covering every status code the real
    handler can actually produce."""

    def test_no_chapters_header_is_not_requested(self, server):
        with mock.patch.object(
            app, "read_pdf_metadata", return_value=("", 3)
        ):
            with mock.patch.object(app.subprocess, "run", side_effect=run_success):
                status, headers, _ = request(
                    server, "POST", "/convert", body=FAKE_PDF
                )
        assert status == 200
        assert headers["X-Xtc-Chapters-Requested"] == "0"
        assert headers["X-Xtc-Chapters-Detected"] == "0"
        assert headers["X-Xtc-Chapters-Status"] == "not-requested"
        assert headers["X-Xtc-Page-Count"] == "3"

    def test_malformed_header_is_header_decode_failed(self, server):
        with mock.patch.object(
            app, "read_pdf_metadata", return_value=("", 3)
        ):
            with mock.patch.object(app.subprocess, "run", side_effect=run_success):
                status, headers, _ = request(
                    server,
                    "POST",
                    "/convert",
                    body=FAKE_PDF,
                    headers={"X-Xtc-Chapters": "not valid base64url!!"},
                )
        assert status == 200
        assert headers["X-Xtc-Chapters-Requested"] == "0"
        assert headers["X-Xtc-Chapters-Detected"] == "0"
        assert headers["X-Xtc-Chapters-Status"] == "header-decode-failed"

    def test_pdf_metadata_failure_reports_empty_page_count(self, server):
        chapters_header = _b64url_json([{"name": "第一章", "marker": "XTCCH0001"}])
        with mock.patch.object(app, "read_pdf_metadata", return_value=("", None)):
            with mock.patch.object(app.subprocess, "run", side_effect=run_success):
                status, headers, _ = request(
                    server,
                    "POST",
                    "/convert",
                    body=FAKE_PDF,
                    headers={"X-Xtc-Chapters": chapters_header},
                )
        assert status == 200
        assert headers["X-Xtc-Chapters-Requested"] == "1"
        assert headers["X-Xtc-Chapters-Detected"] == "0"
        assert headers["X-Xtc-Chapters-Status"] == "pdf-metadata-failed"
        assert headers["X-Xtc-Page-Count"] == ""

    def test_detect_exception_status(self, server):
        chapters_header = _b64url_json([{"name": "第一章", "marker": "XTCCH0001"}])
        fake_pymupdf = mock.MagicMock()
        fake_pymupdf.open.side_effect = RuntimeError("super-secret-parse-failure")
        with mock.patch.object(app, "read_pdf_metadata", return_value=("", 3)):
            with mock.patch.object(app, "pymupdf", fake_pymupdf):
                with mock.patch.object(app.subprocess, "run", side_effect=run_success):
                    status, headers, _ = request(
                        server,
                        "POST",
                        "/convert",
                        body=FAKE_PDF,
                        headers={"X-Xtc-Chapters": chapters_header},
                    )
        assert status == 200
        assert headers["X-Xtc-Chapters-Requested"] == "1"
        assert headers["X-Xtc-Chapters-Detected"] == "0"
        assert headers["X-Xtc-Chapters-Status"] == "detect-exception"
        # The exception message must never leak into a response header.
        assert "super-secret-parse-failure" not in json.dumps(headers)

    def test_no_markers_found_status(self, server):
        pages = ["intro", "nothing relevant here"]
        chapters_header = _b64url_json([{"name": "第一章", "marker": "XTCCH0001"}])
        with mock.patch.object(
            app, "read_pdf_metadata", return_value=("", len(pages))
        ):
            with mock.patch.object(app, "pymupdf", _fake_pymupdf_with_pages(pages)):
                with mock.patch.object(app.subprocess, "run", side_effect=run_success):
                    status, headers, _ = request(
                        server,
                        "POST",
                        "/convert",
                        body=FAKE_PDF,
                        headers={"X-Xtc-Chapters": chapters_header},
                    )
        assert status == 200
        assert headers["X-Xtc-Chapters-Requested"] == "1"
        assert headers["X-Xtc-Chapters-Detected"] == "0"
        assert headers["X-Xtc-Chapters-Status"] == "no-markers-found"

    def test_partial_status(self, server, tmp_path):
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        pages = ["intro", "XTCCH0001 chapter one"]
        chapters_header = _b64url_json(
            [
                {"name": "第一章", "marker": "XTCCH0001"},
                {"name": "第二章", "marker": "XTCCH0002"},
            ]
        )
        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            with mock.patch.object(
                app, "read_pdf_metadata", return_value=("", len(pages))
            ):
                with mock.patch.object(
                    app, "pymupdf", _fake_pymupdf_with_pages(pages)
                ):
                    with mock.patch.object(
                        app.subprocess, "run", side_effect=run_success
                    ):
                        status, headers, _ = request(
                            server,
                            "POST",
                            "/convert",
                            body=FAKE_PDF,
                            headers={"X-Xtc-Chapters": chapters_header},
                        )
        assert status == 200
        assert headers["X-Xtc-Chapters-Requested"] == "2"
        assert headers["X-Xtc-Chapters-Detected"] == "1"
        assert headers["X-Xtc-Chapters-Status"] == "partial"
        # Chapter names/markers must never leak into a response header.
        assert "第一章" not in json.dumps(headers)

    def test_ok_status(self, server, tmp_path):
        config_path = tmp_path / "config.toml"
        config_path.write_text(SAMPLE_CONFIG, encoding="utf-8")
        pages = ["intro", "XTCCH0001 chapter one", "XTCCH0002 chapter two"]
        chapters_header = _b64url_json(
            [
                {"name": "第一章", "marker": "XTCCH0001"},
                {"name": "第二章", "marker": "XTCCH0002"},
            ]
        )
        with mock.patch.object(app, "CONFIG_PATH", str(config_path)):
            with mock.patch.object(
                app, "read_pdf_metadata", return_value=("", len(pages))
            ):
                with mock.patch.object(
                    app, "pymupdf", _fake_pymupdf_with_pages(pages)
                ):
                    with mock.patch.object(
                        app.subprocess, "run", side_effect=run_success
                    ):
                        status, headers, _ = request(
                            server,
                            "POST",
                            "/convert",
                            body=FAKE_PDF,
                            headers={"X-Xtc-Chapters": chapters_header},
                        )
        assert status == 200
        assert headers["X-Xtc-Chapters-Requested"] == "2"
        assert headers["X-Xtc-Chapters-Detected"] == "2"
        assert headers["X-Xtc-Chapters-Status"] == "ok"
        assert headers["X-Xtc-Page-Count"] == "3"

    def test_config_merge_failed_status_reports_zero_detected(self, server, tmp_path):
        # Chapters are located successfully, but the config that would
        # carry them into the XTC fails to build -- the final container
        # ends up with zero chapters, which X-Xtc-Chapters-Detected must
        # reflect (not the number resolve_chapters located).
        pages = ["intro", "XTCCH0001 chapter one"]
        chapters_header = _b64url_json([{"name": "第一章", "marker": "XTCCH0001"}])
        with mock.patch.object(app, "CONFIG_PATH", "/nonexistent/config.toml"):
            with mock.patch.object(
                app, "read_pdf_metadata", return_value=("", len(pages))
            ):
                with mock.patch.object(
                    app, "pymupdf", _fake_pymupdf_with_pages(pages)
                ):
                    with mock.patch.object(
                        app.subprocess, "run", side_effect=run_success
                    ):
                        status, headers, _ = request(
                            server,
                            "POST",
                            "/convert",
                            body=FAKE_PDF,
                            headers={"X-Xtc-Chapters": chapters_header},
                        )
        assert status == 200
        assert headers["X-Xtc-Chapters-Requested"] == "1"
        assert headers["X-Xtc-Chapters-Detected"] == "0"
        assert headers["X-Xtc-Chapters-Status"] == "config-merge-failed"

    def test_header_values_are_ascii_with_no_newlines(self, server):
        chapters_header = _b64url_json([{"name": "第一章", "marker": "XTCCH0001"}])
        pages = ["intro", "XTCCH0001 chapter one"]
        with mock.patch.object(
            app, "read_pdf_metadata", return_value=("", len(pages))
        ):
            with mock.patch.object(app, "pymupdf", _fake_pymupdf_with_pages(pages)):
                with mock.patch.object(app.subprocess, "run", side_effect=run_success):
                    _, headers, _ = request(
                        server,
                        "POST",
                        "/convert",
                        body=FAKE_PDF,
                        headers={"X-Xtc-Chapters": chapters_header},
                    )
        for name in (
            "X-Xtc-Chapters-Requested",
            "X-Xtc-Chapters-Detected",
            "X-Xtc-Chapters-Status",
            "X-Xtc-Page-Count",
        ):
            value = headers[name]
            assert value.isascii()
            assert "\n" not in value
            assert "\r" not in value


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
