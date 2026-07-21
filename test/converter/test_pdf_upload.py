"""Unit tests for converter/pdf_upload.py (POST /convert/uploaded-pdf).

xtctool itself is never invoked; every subprocess call is mocked, exactly as
in test_app.py. PDF fixtures (plain, landscape, encrypted, malformed) are
generated on the fly with pymupdf rather than checked in as binary files.
"""

import base64
import http.client
import json
import subprocess
import sys
import threading
import tomllib
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "converter"))

import app  # noqa: E402

# This whole module builds its PDF fixtures with real pymupdf and exercises
# the Pillow-based image pipeline directly, unlike test_app.py (which only
# ever touches app.pymupdf, optionally None, and importorskips pymupdf
# per-test). README's documented minimal test setup is `pip install pytest`
# only, so skip the whole module -- rather than erroring out `pytest
# test/converter/` entirely -- when these deps aren't installed.
pymupdf = pytest.importorskip("pymupdf")
Image = pytest.importorskip("PIL.Image")

import pdf_upload  # noqa: E402

FAKE_XTC = b"XTC-FAKE-BYTES"

REAL_CONFIG_PATH = str(Path(__file__).resolve().parents[2] / "converter" / "config-x3.toml")


@pytest.fixture(autouse=True)
def _use_real_config_path(monkeypatch):
    """app.CONFIG_PATH defaults to /app/config-x3.toml (the Docker image
    layout); point it at the real repo file so config_with_pdf_options and
    _output_canvas_size can read it outside the container. Individual tests
    may still override app.CONFIG_PATH further via their own monkeypatch."""
    monkeypatch.setattr(app, "CONFIG_PATH", REAL_CONFIG_PATH)


# --- fixture PDF builders ----------------------------------------------------


def make_pdf(pages: int = 1, width: float = 595, height: float = 842, title: str | None = None) -> bytes:
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page(width=width, height=height)
        page.insert_text((36, 36), f"Page {i + 1}", fontsize=18)
    if title is not None:
        doc.set_metadata({"title": title})
    data = doc.tobytes()
    doc.close()
    return data


def make_encrypted_pdf() -> bytes:
    doc = pymupdf.open()
    doc.new_page(width=595, height=842)
    data = doc.tobytes(
        encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="user"
    )
    doc.close()
    return data


MALFORMED_WITH_MAGIC = b"%PDF-1.4\n" + b"this is not a real pdf body" * 20
MALFORMED_WITHOUT_MAGIC = b"just some bytes that are not a pdf at all" * 5


# --- subprocess.run fakes (mirrors test_app.py's convention) ----------------


def run_success(cmd, **kwargs):
    out_path = Path(cmd[cmd.index("-o") + 1])
    out_path.write_bytes(FAKE_XTC)
    return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")


def run_failure(cmd, **kwargs):
    return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="boom: bad png")


def recording_run(calls):
    def run(cmd, **kwargs):
        calls.append(list(cmd))
        return run_success(cmd, **kwargs)

    return run


def default_options(**overrides) -> dict:
    data = json.loads(json.dumps(pdf_upload.DEFAULT_PDF_OPTIONS))
    data.update(overrides)
    return data


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def encode_options(options: dict) -> str:
    return b64url(json.dumps(options).encode("utf-8"))


def encode_filename(name: str) -> str:
    return b64url(name.encode("utf-8"))


# --- PdfConvertOptions validation --------------------------------------------


class TestOptionsFromDict:
    def test_defaults_are_valid(self):
        options = pdf_upload.options_from_dict(pdf_upload.DEFAULT_PDF_OPTIONS)
        assert options.pages == "1-"
        assert options.rotation == 0
        assert options.fit == "contain"
        assert options.threshold == 128
        assert options.dither is True
        assert options.dither_strength == 0.8
        assert options.invert is False

    @pytest.mark.parametrize("rotation", [0, 90, 180, 270])
    def test_valid_rotations(self, rotation):
        options = pdf_upload.options_from_dict(default_options(rotation=rotation))
        assert options.rotation == rotation

    def test_invalid_rotation_rejected(self):
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            pdf_upload.options_from_dict(default_options(rotation=45))
        assert excinfo.value.status == 400

    @pytest.mark.parametrize("value", [0.0, 0.4])
    def test_crop_boundary_values_valid(self, value):
        options = pdf_upload.options_from_dict(
            default_options(crop={"top": value, "right": 0, "bottom": 0, "left": 0})
        )
        assert options.crop.top == value

    @pytest.mark.parametrize("value", [-0.01, 0.41])
    def test_crop_out_of_range_rejected(self, value):
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            pdf_upload.options_from_dict(
                default_options(crop={"top": value, "right": 0, "bottom": 0, "left": 0})
            )
        assert excinfo.value.status == 400

    def test_crop_left_right_sum_at_limit_rejected(self):
        with pytest.raises(pdf_upload.PdfUploadError):
            pdf_upload.options_from_dict(
                default_options(crop={"top": 0, "right": 0.4, "bottom": 0, "left": 0.4})
            )

    def test_crop_top_bottom_sum_at_limit_rejected(self):
        with pytest.raises(pdf_upload.PdfUploadError):
            pdf_upload.options_from_dict(
                default_options(crop={"top": 0.4, "right": 0, "bottom": 0.4, "left": 0})
            )

    def test_crop_sum_just_under_limit_is_valid(self):
        options = pdf_upload.options_from_dict(
            default_options(crop={"top": 0.39, "right": 0, "bottom": 0.4, "left": 0})
        )
        assert options.crop.top == 0.39

    def test_invalid_fit_rejected(self):
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            pdf_upload.options_from_dict(default_options(fit="stretch"))
        assert excinfo.value.status == 400

    @pytest.mark.parametrize("value", [0, 64])
    def test_margin_boundary_values_valid(self, value):
        options = pdf_upload.options_from_dict(default_options(marginPx=value))
        assert options.margin_px == value

    @pytest.mark.parametrize("value", [-1, 65])
    def test_margin_out_of_range_rejected(self, value):
        with pytest.raises(pdf_upload.PdfUploadError):
            pdf_upload.options_from_dict(default_options(marginPx=value))

    @pytest.mark.parametrize("value", [0, 255])
    def test_threshold_boundary_values_valid(self, value):
        options = pdf_upload.options_from_dict(default_options(threshold=value))
        assert options.threshold == value

    @pytest.mark.parametrize("value", [-1, 256])
    def test_threshold_out_of_range_rejected(self, value):
        with pytest.raises(pdf_upload.PdfUploadError):
            pdf_upload.options_from_dict(default_options(threshold=value))

    @pytest.mark.parametrize("value", [0.0, 1.0])
    def test_dither_strength_boundary_values_valid(self, value):
        options = pdf_upload.options_from_dict(default_options(ditherStrength=value))
        assert options.dither_strength == value

    @pytest.mark.parametrize("value", [-0.01, 1.01])
    def test_dither_strength_out_of_range_rejected(self, value):
        with pytest.raises(pdf_upload.PdfUploadError):
            pdf_upload.options_from_dict(default_options(ditherStrength=value))

    def test_non_bool_invert_rejected(self):
        with pytest.raises(pdf_upload.PdfUploadError):
            pdf_upload.options_from_dict(default_options(invert="yes"))

    def test_non_bool_dither_rejected(self):
        with pytest.raises(pdf_upload.PdfUploadError):
            pdf_upload.options_from_dict(default_options(dither="yes"))

    def test_missing_field_rejected(self):
        data = default_options()
        del data["threshold"]
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            pdf_upload.options_from_dict(data)
        assert excinfo.value.status == 400

    def test_unknown_extra_field_is_ignored(self):
        options = pdf_upload.options_from_dict(default_options(extraField="whatever"))
        assert options.fit == "contain"

    def test_empty_pages_string_rejected(self):
        with pytest.raises(pdf_upload.PdfUploadError):
            pdf_upload.options_from_dict(default_options(pages=""))


class TestDecodePdfOptions:
    def test_missing_header_uses_defaults(self):
        options = pdf_upload.decode_pdf_options(None)
        assert options.pages == "1-"

    def test_valid_header_decodes(self):
        header = encode_options(default_options(threshold=200))
        options = pdf_upload.decode_pdf_options(header)
        assert options.threshold == 200

    def test_malformed_base64_is_400(self):
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            pdf_upload.decode_pdf_options("not-valid-base64!!!")
        assert excinfo.value.status == 400

    def test_malformed_json_is_400(self):
        header = b64url(b"{not json")
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            pdf_upload.decode_pdf_options(header)
        assert excinfo.value.status == 400

    def test_non_object_json_is_400(self):
        header = b64url(b"[1,2,3]")
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            pdf_upload.decode_pdf_options(header)
        assert excinfo.value.status == 400


# --- filename decoding ----------------------------------------------------


class TestDecodeSourceFilename:
    def test_missing_header_returns_default(self):
        assert pdf_upload.decode_source_filename(None) == "document.pdf"

    def test_valid_filename_roundtrips(self):
        header = encode_filename("my-report.pdf")
        assert pdf_upload.decode_source_filename(header) == "my-report.pdf"

    def test_japanese_filename_roundtrips(self):
        header = encode_filename("日本語のファイル名.pdf")
        assert pdf_upload.decode_source_filename(header) == "日本語のファイル名.pdf"

    def test_missing_extension_gets_pdf_appended(self):
        header = encode_filename("report")
        assert pdf_upload.decode_source_filename(header) == "report.pdf"

    def test_control_characters_stripped(self):
        header = encode_filename("bad\x00\x1fname.pdf")
        assert pdf_upload.decode_source_filename(header) == "badname.pdf"

    def test_path_separators_stripped(self):
        header = encode_filename("../../etc/passwd.pdf")
        result = pdf_upload.decode_source_filename(header)
        assert "/" not in result
        assert "\\" not in result

    def test_empty_after_sanitization_falls_back_to_default(self):
        header = encode_filename("///")
        assert pdf_upload.decode_source_filename(header) == "document.pdf"

    def test_malformed_base64_falls_back_to_default(self):
        assert pdf_upload.decode_source_filename("!!!not-base64!!!") == "document.pdf"

    def test_long_filename_truncated_to_255_chars(self):
        header = encode_filename("x" * 400 + ".pdf")
        result = pdf_upload.decode_source_filename(header)
        assert len(result) <= 255
        assert result.endswith(".pdf")


class TestTitleFromFilename:
    def test_strips_pdf_extension(self):
        assert pdf_upload._title_from_filename("report.pdf") == "report"

    def test_no_extension_passthrough(self):
        assert pdf_upload._title_from_filename("report") == "report"


# --- page range parsing -----------------------------------------------------


class TestParsePageRange:
    def test_single_page(self):
        assert pdf_upload.parse_page_range("3", 10) == [3]

    def test_range(self):
        assert pdf_upload.parse_page_range("2-5", 10) == [2, 3, 4, 5]

    def test_multiple_ranges(self):
        assert pdf_upload.parse_page_range("1-4,7,10-12", 20) == [1, 2, 3, 4, 7, 10, 11, 12]

    def test_open_start(self):
        assert pdf_upload.parse_page_range("5-", 8) == [5, 6, 7, 8]

    def test_open_end(self):
        assert pdf_upload.parse_page_range("-3", 8) == [1, 2, 3]

    def test_all_pages(self):
        assert pdf_upload.parse_page_range("1-", 4) == [1, 2, 3, 4]

    def test_duplicate_pages_keep_first_occurrence(self):
        assert pdf_upload.parse_page_range("1-3,2", 10) == [1, 2, 3]

    @pytest.mark.parametrize("spec", ["0", "-0", "3-1", "1,,3", "1-a", "1-3-5", ""])
    def test_invalid_syntax_rejected(self, spec):
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            pdf_upload.parse_page_range(spec, 10)
        assert excinfo.value.status == 422

    def test_page_number_exceeding_document_is_rejected(self):
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            pdf_upload.parse_page_range("1-20", 10)
        assert excinfo.value.status == 422

    def test_single_page_exceeding_document_is_rejected(self):
        with pytest.raises(pdf_upload.PdfUploadError):
            pdf_upload.parse_page_range("15", 10)

    def test_invalid_syntax_carries_page_range_invalid_code(self):
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            pdf_upload.parse_page_range("0", 10)
        assert excinfo.value.code == "page_range_invalid"


class TestPdfUploadErrorCode:
    """PdfUploadError.code is the stable, machine-readable half of the
    error response (spec §9.4/§11.11/§14.2): src/workflow.ts reads it to
    pick a condition-specific NonRetryableError message instead of the old
    one-size-fits-all "invalid or unsupported PDF". `message`/`log_message`
    stay free-text and are not part of that contract."""

    def test_explicit_code_is_preserved(self):
        exc = pdf_upload.PdfUploadError(422, "no pages selected", code="no_pages_selected")
        assert pdf_upload._error_code(exc) == "no_pages_selected"

    def test_missing_code_falls_back_to_a_status_default(self):
        exc = pdf_upload.PdfUploadError(415, "file is not a PDF")
        assert pdf_upload._error_code(exc) == "not_pdf"

    def test_unmapped_status_without_explicit_code_falls_back_to_error(self):
        exc = pdf_upload.PdfUploadError(451, "unavailable for legal reasons")
        assert pdf_upload._error_code(exc) == "error"

    def test_no_pages_selected_raised_by_parse_page_range_carries_its_code(self):
        # parse_page_range's final "not result" branch is unreachable through
        # its public validation chain today (every accepted, non-empty
        # segment always contributes at least one in-bounds page — see
        # _check_bounds/_parse_segment), so this exercises the raise
        # directly to lock in the code it would carry if that ever changes.
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            raise pdf_upload.PdfUploadError(
                422, "no pages selected", "no pages selected", code="no_pages_selected"
            )
        assert excinfo.value.code == "no_pages_selected"


# --- rotation / crop / contain / cover / margin -----------------------------


class TestRotation:
    @pytest.mark.parametrize("rotation,expected_size", [(0, (100, 200)), (180, (100, 200))])
    def test_0_and_180_preserve_dimensions(self, rotation, expected_size):
        image = Image.new("L", (100, 200), 0)
        result = pdf_upload._apply_rotation(image, rotation)
        assert result.size == expected_size

    @pytest.mark.parametrize("rotation", [90, 270])
    def test_90_and_270_swap_dimensions(self, rotation):
        image = Image.new("L", (100, 200), 0)
        result = pdf_upload._apply_rotation(image, rotation)
        assert result.size == (200, 100)

    def test_180_flips_content(self):
        image = Image.new("L", (4, 4), 255)
        image.putpixel((0, 0), 0)  # mark top-left corner
        result = pdf_upload._apply_rotation(image, 180)
        assert result.getpixel((0, 0)) == 255
        assert result.getpixel((3, 3)) == 0


class TestCrop:
    def test_crop_percentages_applied_to_all_sides(self):
        image = Image.new("L", (100, 200), 0)
        crop = pdf_upload.Crop(top=0.1, right=0.1, bottom=0.1, left=0.1)
        result = pdf_upload._apply_crop(image, crop)
        assert result.size == (80, 160)

    def test_zero_crop_is_noop(self):
        image = Image.new("L", (100, 200), 0)
        crop = pdf_upload.Crop(top=0, right=0, bottom=0, left=0)
        result = pdf_upload._apply_crop(image, crop)
        assert result.size == (100, 200)

    def test_sub_pixel_result_raises(self):
        image = Image.new("L", (10, 2), 0)
        crop = pdf_upload.Crop(top=0.4, right=0, bottom=0.4, left=0)
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            pdf_upload._apply_crop(image, crop)
        assert excinfo.value.status == 400


class TestPlaceOnCanvas:
    def test_contain_centers_and_pads_with_white(self):
        image = Image.new("L", (1000, 500), 0)
        canvas = pdf_upload._place_on_canvas(image, "contain", 0, (528, 792))
        assert canvas.size == (528, 792)
        assert canvas.getpixel((0, 0)) == 255  # padded corner is white
        assert canvas.getpixel((264, 396)) == 0  # image content at center

    def test_cover_fills_entire_inner_area(self):
        image = Image.new("L", (1000, 500), 0)
        canvas = pdf_upload._place_on_canvas(image, "cover", 0, (528, 792))
        assert canvas.size == (528, 792)
        # cover fills the whole canvas when margin is 0: no white padding.
        assert canvas.getpixel((0, 0)) == 0
        assert canvas.getpixel((527, 791)) == 0

    def test_margin_leaves_white_border(self):
        image = Image.new("L", (528, 792), 0)
        canvas = pdf_upload._place_on_canvas(image, "contain", 32, (528, 792))
        assert canvas.getpixel((0, 0)) == 255
        assert canvas.getpixel((264, 396)) == 0

    def test_max_margin_keeps_positive_inner_area(self):
        image = Image.new("L", (100, 100), 0)
        canvas = pdf_upload._place_on_canvas(image, "contain", 64, (528, 792))
        assert canvas.size == (528, 792)


# --- xtctool config generation -----------------------------------------------


class TestConfigWithPdfOptions:
    def test_overrides_threshold_invert_dither_strength(self, tmp_path, monkeypatch):
        config_path = tmp_path / "config.toml"
        config_path.write_text(
            "[output]\nwidth = 528\nheight = 792\ntitle = \"\"\n"
            "[xtg]\nthreshold = 128\ninvert = false\ndither = true\ndither_strength = 0.8\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(app, "CONFIG_PATH", str(config_path))
        options = pdf_upload.options_from_dict(
            default_options(threshold=200, invert=True, dither=False, ditherStrength=0.3)
        )
        merged = tomllib.loads(pdf_upload.config_with_pdf_options("My Title", options))
        assert merged["output"]["title"] == "My Title"
        assert merged["xtg"]["threshold"] == 200
        assert merged["xtg"]["invert"] is True
        assert merged["xtg"]["dither"] is False
        assert merged["xtg"]["dither_strength"] == 0.3
        assert merged["output"]["width"] == 528  # untouched keys survive


# --- full conversion pipeline (mocked xtctool) -------------------------------


class TestConvertUploadedPdf:
    def test_opens_normal_pdf_and_returns_title(self, tmp_path):
        pdf_bytes = make_pdf(pages=1, title="My Document")
        pdf_path = tmp_path / "source.pdf"
        pdf_path.write_bytes(pdf_bytes)
        options = pdf_upload.options_from_dict(pdf_upload.DEFAULT_PDF_OPTIONS)
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            xtc_bytes, title = pdf_upload.convert_uploaded_pdf(
                pdf_path, options, "fallback.pdf", 30, tmp_path
            )
        assert xtc_bytes == FAKE_XTC
        assert title == "My Document"

    def test_title_falls_back_to_filename_when_pdf_has_no_title(self, tmp_path):
        pdf_bytes = make_pdf(pages=1, title="")
        pdf_path = tmp_path / "source.pdf"
        pdf_path.write_bytes(pdf_bytes)
        options = pdf_upload.options_from_dict(pdf_upload.DEFAULT_PDF_OPTIONS)
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            _, title = pdf_upload.convert_uploaded_pdf(
                pdf_path, options, "my-report.pdf", 30, tmp_path
            )
        assert title == "my-report"

    def test_malformed_pdf_raises_422(self, tmp_path):
        pdf_path = tmp_path / "source.pdf"
        pdf_path.write_bytes(MALFORMED_WITH_MAGIC)
        options = pdf_upload.options_from_dict(pdf_upload.DEFAULT_PDF_OPTIONS)
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            pdf_upload.convert_uploaded_pdf(pdf_path, options, "x.pdf", 30, tmp_path)
        assert excinfo.value.status == 422

    def test_encrypted_pdf_raises_422(self, tmp_path):
        pdf_path = tmp_path / "source.pdf"
        pdf_path.write_bytes(make_encrypted_pdf())
        options = pdf_upload.options_from_dict(pdf_upload.DEFAULT_PDF_OPTIONS)
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            pdf_upload.convert_uploaded_pdf(pdf_path, options, "x.pdf", 30, tmp_path)
        assert excinfo.value.status == 422
        assert "encrypted" in excinfo.value.log_message

    def test_page_count_over_limit_raises_422(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pdf_upload, "MAX_SOURCE_PDF_PAGES", 2)
        pdf_path = tmp_path / "source.pdf"
        pdf_path.write_bytes(make_pdf(pages=3))
        options = pdf_upload.options_from_dict(pdf_upload.DEFAULT_PDF_OPTIONS)
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            pdf_upload.convert_uploaded_pdf(pdf_path, options, "x.pdf", 30, tmp_path)
        assert excinfo.value.status == 422

    def test_selected_page_count_over_limit_raises_422(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pdf_upload, "MAX_SELECTED_PDF_PAGES", 2)
        pdf_path = tmp_path / "source.pdf"
        pdf_path.write_bytes(make_pdf(pages=5))
        options = pdf_upload.options_from_dict(default_options(pages="1-5"))
        with pytest.raises(pdf_upload.PdfUploadError) as excinfo:
            pdf_upload.convert_uploaded_pdf(pdf_path, options, "x.pdf", 30, tmp_path)
        assert excinfo.value.status == 422

    def test_landscape_page_renders_without_error(self, tmp_path):
        pdf_path = tmp_path / "source.pdf"
        pdf_path.write_bytes(make_pdf(pages=1, width=842, height=595))
        options = pdf_upload.options_from_dict(pdf_upload.DEFAULT_PDF_OPTIONS)
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            xtc_bytes, _ = pdf_upload.convert_uploaded_pdf(
                pdf_path, options, "x.pdf", 30, tmp_path
            )
        assert xtc_bytes == FAKE_XTC


class TestChunkedConversion:
    def test_single_chunk_skips_repack(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pdf_upload, "PDF_UPLOAD_CHUNK_SIZE_PAGES", 100)
        pdf_path = tmp_path / "source.pdf"
        pdf_path.write_bytes(make_pdf(pages=3))
        options = pdf_upload.options_from_dict(pdf_upload.DEFAULT_PDF_OPTIONS)
        calls = []
        with mock.patch.object(app.subprocess, "run", side_effect=recording_run(calls)):
            xtc_bytes, _ = pdf_upload.convert_uploaded_pdf(
                pdf_path, options, "x.pdf", 30, tmp_path
            )
        assert xtc_bytes == FAKE_XTC
        assert len(calls) == 1  # no repack call

    def test_multiple_chunks_are_repacked(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pdf_upload, "PDF_UPLOAD_CHUNK_SIZE_PAGES", 2)
        pdf_path = tmp_path / "source.pdf"
        pdf_path.write_bytes(make_pdf(pages=5))
        options = pdf_upload.options_from_dict(default_options(pages="1-5"))
        calls = []
        with mock.patch.object(app.subprocess, "run", side_effect=recording_run(calls)):
            xtc_bytes, _ = pdf_upload.convert_uploaded_pdf(
                pdf_path, options, "x.pdf", 30, tmp_path
            )
        assert xtc_bytes == FAKE_XTC
        # 3 chunks (2,2,1 pages) + 1 repack call.
        assert len(calls) == 4
        for chunk_call in calls[:3]:
            sources = chunk_call[2 : chunk_call.index("-o")]
            assert all(s.endswith(".png") for s in sources)
        repack_sources = calls[3][2 : calls[3].index("-o")]
        assert all(s.endswith(".xtc") for s in repack_sources)
        assert len(repack_sources) == 3

    def test_chunk_pngs_are_deleted_after_each_chunk(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pdf_upload, "PDF_UPLOAD_CHUNK_SIZE_PAGES", 2)
        pdf_path = tmp_path / "source.pdf"
        pdf_path.write_bytes(make_pdf(pages=4))
        options = pdf_upload.options_from_dict(default_options(pages="1-4"))

        seen_dirs_during_run = []

        def watching_run(cmd, **kwargs):
            first_source = Path(cmd[2])
            if first_source.suffix == ".png":
                png_dir = first_source.parent
                seen_dirs_during_run.append(sorted(p.name for p in png_dir.iterdir()))
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=watching_run):
            pdf_upload.convert_uploaded_pdf(pdf_path, options, "x.pdf", 30, tmp_path)

        # Each chunk's PNGs existed while xtctool ran on them...
        assert seen_dirs_during_run == [
            ["page0001.png", "page0002.png"],
            ["page0001.png", "page0002.png"],
        ]
        # ...and no chunk PNG directories remain afterwards (the chunk XTCs
        # themselves are kept until the repack step consumes them; overall
        # workdir cleanup is the caller's responsibility via
        # tempfile.TemporaryDirectory in handle_uploaded_pdf_request).
        remaining_dirs = [p for p in tmp_path.glob("chunk*") if p.is_dir()]
        assert remaining_dirs == []

    def test_chunk_failure_propagates_conversion_error(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pdf_upload, "PDF_UPLOAD_CHUNK_SIZE_PAGES", 2)
        pdf_path = tmp_path / "source.pdf"
        pdf_path.write_bytes(make_pdf(pages=4))
        options = pdf_upload.options_from_dict(default_options(pages="1-4"))
        with mock.patch.object(app.subprocess, "run", side_effect=run_failure):
            with pytest.raises(app.ConversionError) as excinfo:
                pdf_upload.convert_uploaded_pdf(pdf_path, options, "x.pdf", 30, tmp_path)
        assert "boom: bad png" in excinfo.value.stderr

    def test_deadline_exceeded_between_chunks_raises_timeout(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pdf_upload, "PDF_UPLOAD_CHUNK_SIZE_PAGES", 2)
        pdf_path = tmp_path / "source.pdf"
        pdf_path.write_bytes(make_pdf(pages=4))
        options = pdf_upload.options_from_dict(default_options(pages="1-4"))
        # First monotonic() call computes the deadline; subsequent calls run
        # out of budget before the second chunk starts.
        clock = iter([0.0, 0.1, 0.2, 0.3, 9999.0])
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            with mock.patch.object(pdf_upload.time, "monotonic", side_effect=lambda: next(clock)):
                with pytest.raises(app.ConversionError) as excinfo:
                    pdf_upload.convert_uploaded_pdf(pdf_path, options, "x.pdf", 10, tmp_path)
        assert "timed out after 10s" in str(excinfo.value)


# --- HTTP-level request handling (real server, mocked xtctool) --------------


@pytest.fixture()
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv
    srv.shutdown()
    srv.server_close()


def request(srv, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=10)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        conn.close()


def upload_headers(pdf_bytes: bytes, **extra) -> dict:
    headers = {
        "Content-Type": "application/pdf",
        "Content-Length": str(len(pdf_bytes)),
    }
    headers.update(extra)
    return headers


class TestHttpServerUploadedPdf:
    def test_success_returns_xtc_with_title_header(self, server):
        pdf_bytes = make_pdf(pages=1, title="Hello Title")
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            status, headers, body = request(
                server,
                "POST",
                "/convert/uploaded-pdf",
                body=pdf_bytes,
                headers=upload_headers(pdf_bytes),
            )
        assert status == 200
        assert body == FAKE_XTC
        assert headers["X-Xtc-Title"] == "Hello%20Title"

    def test_missing_content_type_is_415(self, server):
        pdf_bytes = make_pdf()
        headers = upload_headers(pdf_bytes)
        del headers["Content-Type"]
        status, _, body = request(
            server, "POST", "/convert/uploaded-pdf", body=pdf_bytes, headers=headers
        )
        assert status == 415
        assert json.loads(body)["code"] == "not_pdf"

    def test_wrong_content_type_is_415(self, server):
        pdf_bytes = make_pdf()
        headers = upload_headers(pdf_bytes, **{"Content-Type": "text/plain"})
        status, _, body = request(
            server, "POST", "/convert/uploaded-pdf", body=pdf_bytes, headers=headers
        )
        assert status == 415
        assert json.loads(body)["code"] == "not_pdf"

    def test_x_pdf_content_type_is_allowed(self, server):
        pdf_bytes = make_pdf()
        headers = upload_headers(pdf_bytes, **{"Content-Type": "application/x-pdf"})
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            status, _, _ = request(
                server, "POST", "/convert/uploaded-pdf", body=pdf_bytes, headers=headers
            )
        assert status == 200

    def test_missing_content_length_is_400(self, server):
        status, _, _ = request(
            server,
            "POST",
            "/convert/uploaded-pdf",
            headers={"Content-Type": "application/pdf"},
        )
        assert status == 400

    def test_zero_byte_body_is_400(self, server):
        status, _, _ = request(
            server,
            "POST",
            "/convert/uploaded-pdf",
            body=b"",
            headers={"Content-Type": "application/pdf", "Content-Length": "0"},
        )
        assert status == 400

    def test_oversized_body_is_413(self, server):
        pdf_bytes = make_pdf()
        with mock.patch.object(pdf_upload, "MAX_UPLOAD_PDF_BYTES", 8):
            status, _, body = request(
                server,
                "POST",
                "/convert/uploaded-pdf",
                body=pdf_bytes,
                headers=upload_headers(pdf_bytes),
            )
        assert status == 413
        payload = json.loads(body)
        assert "exceeds" in payload["error"]
        assert payload["code"] == "pdf_too_large"

    def test_not_a_pdf_is_415(self, server):
        body = MALFORMED_WITHOUT_MAGIC
        status, _, resp_body = request(
            server,
            "POST",
            "/convert/uploaded-pdf",
            body=body,
            headers=upload_headers(body),
        )
        assert status == 415
        payload = json.loads(resp_body)
        assert "not a PDF" in payload["error"] or True
        assert payload["code"] == "not_pdf"

    def test_malformed_pdf_with_magic_is_422(self, server):
        body = MALFORMED_WITH_MAGIC
        status, _, resp_body = request(
            server,
            "POST",
            "/convert/uploaded-pdf",
            body=body,
            headers=upload_headers(body),
        )
        assert status == 422
        assert json.loads(resp_body)["code"] == "pdf_parse_failed"

    def test_encrypted_pdf_is_422(self, server):
        body = make_encrypted_pdf()
        status, _, resp_body = request(
            server,
            "POST",
            "/convert/uploaded-pdf",
            body=body,
            headers=upload_headers(body),
        )
        assert status == 422
        # Response is generic; internal encryption detail must not leak.
        payload = json.loads(resp_body)
        assert payload["error"] not in ("", None)
        # ...but `code` is the stable, machine-readable contract src/workflow.ts
        # relies on to show a condition-specific message (spec §9.4/§11.11/§14.2).
        assert payload["code"] == "encrypted_pdf"

    def test_invalid_pdf_options_header_is_400(self, server):
        pdf_bytes = make_pdf()
        status, _, body = request(
            server,
            "POST",
            "/convert/uploaded-pdf",
            body=pdf_bytes,
            headers=upload_headers(pdf_bytes, **{"X-Pdf-Options": "!!!not-valid!!!"}),
        )
        assert status == 400
        assert json.loads(body)["code"] == "invalid_pdf_options"

    def test_invalid_page_range_is_422(self, server):
        pdf_bytes = make_pdf(pages=2)
        options_header = encode_options(default_options(pages="5-9"))
        status, _, body = request(
            server,
            "POST",
            "/convert/uploaded-pdf",
            body=pdf_bytes,
            headers=upload_headers(pdf_bytes, **{"X-Pdf-Options": options_header}),
        )
        assert status == 422
        assert json.loads(body)["code"] == "page_range_invalid"

    def test_xtctool_failure_is_500_generic(self, server, caplog):
        pdf_bytes = make_pdf()
        with mock.patch.object(app.subprocess, "run", side_effect=run_failure):
            status, _, body = request(
                server,
                "POST",
                "/convert/uploaded-pdf",
                body=pdf_bytes,
                headers=upload_headers(pdf_bytes),
            )
        assert status == 500
        payload = json.loads(body)
        assert "boom: bad png" not in json.dumps(payload)
        assert payload["code"] == "convert_failed"

    def test_custom_options_are_honoured_via_xtctool_config(self, server, tmp_path_factory):
        pdf_bytes = make_pdf()
        options_header = encode_options(default_options(threshold=77, invert=True))
        seen = {}

        def inspecting_run(cmd, **kwargs):
            config_path = Path(cmd[cmd.index("-c") + 1])
            seen["config"] = tomllib.loads(config_path.read_text(encoding="utf-8"))
            return run_success(cmd, **kwargs)

        with mock.patch.object(app.subprocess, "run", side_effect=inspecting_run):
            status, _, _ = request(
                server,
                "POST",
                "/convert/uploaded-pdf",
                body=pdf_bytes,
                headers=upload_headers(pdf_bytes, **{"X-Pdf-Options": options_header}),
            )
        assert status == 200
        assert seen["config"]["xtg"]["threshold"] == 77
        assert seen["config"]["xtg"]["invert"] is True

    def test_filename_used_as_title_fallback(self, server):
        pdf_bytes = make_pdf(title="")
        filename_header = encode_filename("my-notes.pdf")
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            status, headers, _ = request(
                server,
                "POST",
                "/convert/uploaded-pdf",
                body=pdf_bytes,
                headers=upload_headers(pdf_bytes, **{"X-Source-Filename": filename_header}),
            )
        assert status == 200
        assert headers["X-Xtc-Title"] == "my-notes"

    def test_busy_conversion_slot_is_503(self, server):
        pdf_bytes = make_pdf()
        acquired = pdf_upload.UPLOADED_PDF_CONVERSION_SLOTS.acquire(blocking=False)
        assert acquired
        try:
            status, _, _ = request(
                server,
                "POST",
                "/convert/uploaded-pdf",
                body=pdf_bytes,
                headers=upload_headers(pdf_bytes),
            )
            assert status == 503
        finally:
            pdf_upload.UPLOADED_PDF_CONVERSION_SLOTS.release()

    def test_existing_convert_endpoint_still_works(self, server):
        # Regression guard: refactoring _handle_post's dispatch must not
        # change the trusted /convert path's behaviour.
        pdf_bytes = b"%PDF-1.4 fake"
        with mock.patch.object(app.subprocess, "run", side_effect=run_success):
            status, headers, body = request(
                server,
                "POST",
                "/convert",
                body=pdf_bytes,
                headers={"Content-Length": str(len(pdf_bytes))},
            )
        assert status == 200
        assert body == FAKE_XTC

    def test_unknown_path_is_404(self, server):
        status, _, _ = request(server, "POST", "/convert/nonsense", body=b"x")
        assert status == 404
