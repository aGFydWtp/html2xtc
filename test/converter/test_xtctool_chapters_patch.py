# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 aGFydWtp

"""Integration test for converter/xtctool-chapters.patch's effect on the
real, patched xtctool package.

xtctool is a build-time-only dependency of this repo: converter/Dockerfile
clones it, applies xtctool-chapters.patch (and xtctool-packbits.patch), and
pip-installs the patched checkout into the container image (see the
Dockerfile). It is never pip-installed in a plain dev checkout -- the
README's documented minimal test setup is `pip install pytest` -- so, in the
same spirit as test_pdf_upload.py's PIL-missing skip, this whole module
SKIPS entirely wherever the patched `xtctool` package is not already
importable (i.e. every plain dev checkout), and only actually exercises the
patch inside an environment where it has been installed (the container
image itself, or a dev venv where someone manually pip-installed the
patched xtctool locally).

This makes NO network calls and never clones or fetches xtctool itself: it
only imports whatever `xtctool` package (if any) is already present on
sys.path. Every other converter test mocks xtctool/subprocess entirely and
so provides no protection against a regression in the patch itself (see the
Dockerfile's own patch-application step, which is the only other place this
is currently checked, manually, at review time); this module closes that
gap for any environment where the patched package is actually available.
"""

import struct
import tempfile
from pathlib import Path

import pytest

xtc = pytest.importorskip("xtctool.core.xtc")


def _write_and_read(writer, frames: list[bytes]) -> tuple[bytes, list[bytes], "xtc.XTCReader"]:
    with tempfile.TemporaryDirectory() as workdir:
        out_path = Path(workdir) / "output.xtc"
        writer.write(str(out_path), frames)
        data = out_path.read_bytes()
        reader = xtc.XTCReader()
        frames_out = reader.read(str(out_path))
    return data, frames_out, reader


def test_chapters_round_trip_matches_firmware_requirements():
    """Firmware requirements (crosspoint-reader/XtcParser.cpp, cited in full
    in xtctool-chapters.patch's header): hasChapters==1 at offset 0x0B,
    pageTableOffset>=56 at 0x18, a valid chapterOffset in [56, fileSize) at
    0x30, zero gap between the chapters section and the page table (the
    firmware counts chapters as (pageTableOffset-chapterOffset)/96, never
    from any stored count), and a full XTCWriter/XTCReader round trip
    recovering every chapter's name/start_page/end_page."""
    chapters = [
        xtc.XTCChapter(name="第一章 その名", start_page=0, end_page=4),
        xtc.XTCChapter(name="第二章", start_page=5, end_page=9),
        xtc.XTCChapter(name="第三章 最終章", start_page=10, end_page=12),
    ]
    metadata = xtc.XTCMetadata(title="テスト本", author="著者")
    writer = xtc.XTCWriter(
        width=528, height=792, metadata=metadata, chapters=chapters, page_format="xtg"
    )
    frames = [b"FRAME" + bytes([i]) * 20 for i in range(13)]

    data, frames_out, reader = _write_and_read(writer, frames)

    has_chapters = data[0x0B]
    page_table_offset = struct.unpack("<Q", data[0x18:0x20])[0]
    chapter_offset = struct.unpack("<Q", data[0x30:0x38])[0]

    assert has_chapters == 1
    assert page_table_offset >= 56
    assert 56 <= chapter_offset < len(data)
    assert (page_table_offset - chapter_offset) % xtc.XTCWriter.CHAPTER_SIZE == 0
    firmware_count = (page_table_offset - chapter_offset) // xtc.XTCWriter.CHAPTER_SIZE
    assert firmware_count == len(chapters)

    assert frames_out == frames
    assert reader.page_count == len(frames)
    assert [(c.name, c.start_page, c.end_page) for c in reader.chapters] == [
        (c.name, c.start_page, c.end_page) for c in chapters
    ]


def test_no_chapters_requested_is_unaffected():
    """A conversion that never sets chapters must keep hasChapters==0 and
    chapterOffset==0 -- this patch must be a no-op for every pre-existing
    (chapter-less) conversion."""
    writer = xtc.XTCWriter(
        width=528, height=792, metadata=xtc.XTCMetadata(title="無章"), page_format="xtg"
    )
    frames = [b"FRAME0", b"FRAME1"]

    data, frames_out, reader = _write_and_read(writer, frames)

    assert data[0x0B] == 0
    assert struct.unpack("<Q", data[0x30:0x38])[0] == 0
    assert frames_out == frames
    assert reader.chapters == []


def test_start_page_zero_is_written_as_one_on_disk():
    """The on-disk XTC chapter entry is 1-based (see
    XTCWriter._write_chapters' docstring, citing the firmware's
    XtcParser.cpp readChapters(): `if (startPage > 0) startPage--;`), while
    XTCChapter.start_page/end_page are 0-based. A chapter starting at page 0
    must therefore be written to disk as 1, not 0 -- writing 0 would collide
    with the firmware's start/end-both-zero terminator sentinel and would
    also just be off by one after the firmware's own decrement."""
    chapters = [xtc.XTCChapter(name="第一章", start_page=0, end_page=4)]
    writer = xtc.XTCWriter(width=8, height=8, chapters=chapters, page_format="xtg")
    frames = [b"F0"]

    data, frames_out, reader = _write_and_read(writer, frames)

    chapter_offset = struct.unpack("<Q", data[0x30:0x38])[0]
    disk_start_page = struct.unpack("<H", data[chapter_offset + 80 : chapter_offset + 82])[0]
    disk_end_page = struct.unpack("<H", data[chapter_offset + 82 : chapter_offset + 84])[0]
    assert disk_start_page == 1
    assert disk_end_page == 5

    # And the reader converts back to the original 0-based values.
    assert reader.chapters[0].start_page == 0
    assert reader.chapters[0].end_page == 4


def test_chapter_page_at_0xfffe_round_trips_without_overflow():
    """0xFFFE is the largest 0-based page value the on-disk +1 conversion
    can represent (0xFFFE + 1 == 0xFFFF, the max uint16); this must not
    raise and must round-trip losslessly. converter/app.py's
    build_chapter_entries enforces this bound before ever constructing a
    chapters TOML entry, so xtctool itself should never see anything
    larger."""
    chapters = [xtc.XTCChapter(name="境界", start_page=0xFFFE, end_page=0xFFFE)]
    writer = xtc.XTCWriter(width=8, height=8, chapters=chapters, page_format="xtg")
    frames = [b"F0"]

    data, frames_out, reader = _write_and_read(writer, frames)

    chapter_offset = struct.unpack("<Q", data[0x30:0x38])[0]
    disk_start_page = struct.unpack("<H", data[chapter_offset + 80 : chapter_offset + 82])[0]
    disk_end_page = struct.unpack("<H", data[chapter_offset + 82 : chapter_offset + 84])[0]
    assert disk_start_page == 0xFFFF
    assert disk_end_page == 0xFFFF
    assert reader.chapters[0].start_page == 0xFFFE
    assert reader.chapters[0].end_page == 0xFFFE


def test_chapter_page_at_0xffff_overflows_uint16():
    """One page beyond the 0xFFFE boundary: writing start_page=0xFFFF would
    require packing 0x10000 into the on-disk uint16, which struct.pack
    rejects. converter/app.py's build_chapter_entries is responsible for
    never letting a chapter reach xtctool with a page this large (see its
    0xFFFE range check) -- this test documents why that bound exists."""
    chapters = [xtc.XTCChapter(name="境界超え", start_page=0xFFFF, end_page=0xFFFF)]
    writer = xtc.XTCWriter(width=8, height=8, chapters=chapters, page_format="xtg")
    with tempfile.TemporaryDirectory() as workdir:
        out_path = Path(workdir) / "output.xtc"
        with pytest.raises(struct.error):
            writer.write(str(out_path), [b"F0"])


def test_single_chapter_still_sets_valid_chapter_offset():
    # A regression-prone edge case: exactly one chapter, no metadata (title/
    # author both empty) -- has_metadata is False, so the chapter section
    # must start immediately after the header, not after a metadata section
    # that was never written.
    chapters = [xtc.XTCChapter(name="唯一の章", start_page=0, end_page=2)]
    writer = xtc.XTCWriter(width=528, height=792, chapters=chapters, page_format="xtg")
    frames = [b"F0", b"F1", b"F2"]

    data, frames_out, reader = _write_and_read(writer, frames)

    chapter_offset = struct.unpack("<Q", data[0x30:0x38])[0]
    assert chapter_offset == xtc.XTCWriter.HEADER_SIZE  # no metadata section precedes it
    assert frames_out == frames
    assert len(reader.chapters) == 1
    assert reader.chapters[0].name == "唯一の章"
