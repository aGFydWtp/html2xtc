// SPDX-License-Identifier: AGPL-3.0-or-later
// XTC デコーダ（純関数）。xtctool コンテナ形式: 48 バイトのヘッダー、indexOffset
// （絶対位置）に 16 バイト/ページのインデックス、続いて無圧縮 1-bit XTG フレーム
// （22 バイトヘッダー、行方向 MSB 詰め、ビット 1 = 白）。全フィールドリトルエンディアン。

const XTC_MAGIC = 0x00435458;
const XTG_MAGIC = 0x00475458;
const XTC_VERSION = 0x0100;
const XTC_HEADER_SIZE = 48;
const XTC_INDEX_ENTRY_SIZE = 16;
const XTG_HEADER_SIZE = 22;
const MAX_FRAME_DIM = 4096;
const MAX_FRAME_PIXELS = 32000000;

export interface XtcPageEntry {
  offset: number;
  size: number;
}

export interface ParsedXtc {
  dv: DataView;
  pages: XtcPageEntry[];
}

function readU64(dv: DataView, off: number): number {
  const v = dv.getBigUint64(off, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("u64 out of range");
  return Number(v);
}

export function parseXtc(buf: ArrayBuffer): ParsedXtc {
  const dv = new DataView(buf);
  if (buf.byteLength < XTC_HEADER_SIZE || dv.getUint32(0, true) !== XTC_MAGIC) throw new Error("bad magic");
  if (dv.getUint16(4, true) !== XTC_VERSION) throw new Error("unsupported version");
  const pageCount = dv.getUint16(6, true);
  if (!pageCount) throw new Error("no pages");
  const indexOffset = readU64(dv, 24);
  if (indexOffset + pageCount * XTC_INDEX_ENTRY_SIZE > buf.byteLength) throw new Error("index out of range");
  const pages: XtcPageEntry[] = [];
  for (let i = 0; i < pageCount; i++) {
    const base = indexOffset + i * XTC_INDEX_ENTRY_SIZE;
    pages.push({ offset: readU64(dv, base), size: dv.getUint32(base + 8, true) });
  }
  return { dv, pages };
}

export function decodeFrame(dv: DataView, entry: XtcPageEntry): ImageData {
  const off = entry.offset;
  if (off + XTG_HEADER_SIZE > dv.byteLength || off + entry.size > dv.byteLength) throw new Error("frame out of range");
  if (dv.getUint32(off, true) !== XTG_MAGIC) throw new Error("unsupported frame");
  const width = dv.getUint16(off + 4, true);
  const height = dv.getUint16(off + 6, true);
  if (!width || !height) throw new Error("empty frame");
  if (width > MAX_FRAME_DIM || height > MAX_FRAME_DIM || width * height > MAX_FRAME_PIXELS) throw new Error("frame too large");
  if (dv.getUint8(off + 8) !== 0 || dv.getUint8(off + 9) !== 0) throw new Error("unsupported encoding");
  const dataSize = dv.getUint32(off + 10, true);
  const bytesPerRow = Math.ceil(width / 8);
  if (dataSize < bytesPerRow * height || off + XTG_HEADER_SIZE + dataSize > dv.byteLength) throw new Error("bitmap out of range");
  const image = new ImageData(width, height);
  const px = image.data;
  for (let y = 0; y < height; y++) {
    const row = off + XTG_HEADER_SIZE + y * bytesPerRow;
    for (let x = 0; x < width; x++) {
      const v = (dv.getUint8(row + (x >> 3)) >> (7 - (x & 7))) & 1 ? 255 : 0;
      const p = (y * width + x) * 4;
      px[p] = px[p + 1] = px[p + 2] = v;
      px[p + 3] = 255;
    }
  }
  return image;
}
