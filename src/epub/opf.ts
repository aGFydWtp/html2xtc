// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { resolveEpubRelativePath } from "./archive";
import { assertNoXxeMarkers, EpubError } from "./errors";
import type {
  EpubManifestItem,
  EpubMetadata,
  EpubPackageDocument,
  EpubSpineItem,
  EpubVersion,
} from "./types";
import { elementsByLocalName, firstByLocalName, localName, parseXmlDocument } from "./xml";
import type { XmlElement } from "./xml";

/**
 * Parses the OPF package document (EPUB spec §8.4-8.6): version, metadata
 * (title/creator/language/identifier + rendition properties), manifest,
 * spine, Fixed Layout detection, and the structural (priorities 1-3) part
 * of cover resolution (spec §11.3 — priority 4, "cover.xhtml's first
 * image", is content-level and left to Phase 3).
 *
 * Uses xml.ts's parseXmlDocument, not parseHTML — see xml.ts's doc comment
 * for why parseHTML is unsafe for OPF/NCX/nav documents (it silently empties
 * an EPUB3 <meta property="...">value</meta> as an HTML5 void element).
 */

const MAX_META_CHARS = 100;
const MAX_CREATORS = 3;

/** Strips control characters and collapses whitespace, capping at `max` code points. Unlike src/jobs.ts#sanitizeTitle, this does NOT strip "/" — spec §8.4.2 joins authors with " / ". */
function cleanMetaText(raw: string, max: number): string {
  const withoutControlChars = Array.from(raw)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      const isC0 = code < 0x20;
      const isDel = code === 0x7f;
      return !isC0 && !isDel;
    })
    .join("");
  const collapsed = withoutControlChars.replace(/\s+/g, " ").trim();
  return Array.from(collapsed).slice(0, max).join("").trim();
}

/** Spec §8.4.1: first non-empty dc:title, else the filename with ".epub" stripped, else "EPUB document". */
export function resolveEpubTitle(rawTitles: string[], filenameFallback: string | undefined): string {
  for (const raw of rawTitles) {
    const cleaned = cleanMetaText(raw, MAX_META_CHARS);
    if (cleaned.length > 0) {
      return cleaned;
    }
  }
  if (filenameFallback !== undefined) {
    const stripped = filenameFallback.replace(/\.epub$/i, "");
    const cleaned = cleanMetaText(stripped, MAX_META_CHARS);
    if (cleaned.length > 0) {
      return cleaned;
    }
  }
  return "EPUB document";
}

/** Spec §8.4.2: up to 3 non-empty dc:creator values, document order, joined by " / ", capped at 100 chars. */
export function resolveEpubAuthor(rawCreators: string[]): string | undefined {
  const cleaned = rawCreators
    .map((raw) => cleanMetaText(raw, MAX_META_CHARS))
    .filter((value) => value.length > 0)
    .slice(0, MAX_CREATORS);
  if (cleaned.length === 0) {
    return undefined;
  }
  return cleanMetaText(cleaned.join(" / "), MAX_META_CHARS);
}

function findMetaProperty(metadataEl: XmlElement, property: string): string | undefined {
  for (const meta of elementsByLocalName(metadataEl, "meta")) {
    if (meta.getAttribute("property") === property) {
      const text = (meta.textContent ?? "").trim();
      if (text.length > 0) {
        return text;
      }
    }
  }
  return undefined;
}

/**
 * Known EPUB2-era fixed-layout hints, in addition to EPUB3's
 * rendition:layout (spec §8.4.3):
 * - "fixed-layout" (Kindle KF8 / the de facto convention most tools adopted)
 * - "original-resolution" (Kindle KF8, always paired with fixed-layout but
 *   checked independently since some real-world files carry only this one)
 * - "region-mag" (Adobe Digital Editions / iBooks region magnification —
 *   review M3: this feature is meaningless for reflowable text, so its
 *   presence with a truthy value is itself a reliable fixed-layout signal
 *   even without an accompanying "fixed-layout" meta)
 */
const FIXED_LAYOUT_META_NAMES = new Set(["fixed-layout", "original-resolution", "region-mag"]);

function detectFixedLayout(metadataEl: XmlElement, renditionLayout: string | undefined): boolean {
  if (renditionLayout === "pre-paginated") {
    return true;
  }
  for (const meta of elementsByLocalName(metadataEl, "meta")) {
    const name = meta.getAttribute("name");
    if (name === null || !FIXED_LAYOUT_META_NAMES.has(name)) {
      continue;
    }
    const content = (meta.getAttribute("content") ?? "").trim().toLowerCase();
    if ((name === "fixed-layout" || name === "region-mag") && (content === "true" || content === "yes" || content === "1")) {
      return true;
    }
    if (name === "original-resolution" && content.length > 0) {
      return true;
    }
  }
  return false;
}

function parseVersion(raw: string | null): EpubVersion {
  if (raw === null) {
    return "unknown";
  }
  if (raw.startsWith("2")) {
    return "2.0";
  }
  if (raw.startsWith("3")) {
    return "3.0";
  }
  return "unknown";
}

function parseManifest(manifestEl: XmlElement, opfPath: string): Map<string, EpubManifestItem> {
  const manifest = new Map<string, EpubManifestItem>();
  for (const itemEl of elementsByLocalName(manifestEl, "item")) {
    const id = itemEl.getAttribute("id");
    const href = itemEl.getAttribute("href");
    if (id === null || id.trim().length === 0 || href === null || href.trim().length === 0) {
      throw new EpubError("INVALID_PACKAGE", "manifest item missing id/href");
    }
    if (manifest.has(id)) {
      throw new EpubError("INVALID_PACKAGE", "duplicate manifest item id");
    }
    const mediaType = itemEl.getAttribute("media-type") ?? "";
    const propertiesRaw = itemEl.getAttribute("properties") ?? "";
    const properties = new Set(propertiesRaw.split(/\s+/).filter((token) => token.length > 0));
    // Spec §8.5: "URLデコード後のパスがarchive外へ出る場合は拒否する" — a
    // manifest href is relative to the OPF's own directory.
    const absolutePath = resolveEpubRelativePath(opfPath, href);

    manifest.set(id, { id, href, mediaType, properties, absolutePath });
  }
  return manifest;
}

function parseSpine(
  spineEl: XmlElement,
  manifest: Map<string, EpubManifestItem>,
): EpubSpineItem[] {
  const spine: EpubSpineItem[] = [];
  for (const itemrefEl of elementsByLocalName(spineEl, "itemref")) {
    const idref = itemrefEl.getAttribute("idref");
    if (idref === null || idref.trim().length === 0) {
      throw new EpubError("INVALID_PACKAGE", "spine itemref missing idref");
    }
    const manifestItem = manifest.get(idref);
    if (manifestItem === undefined) {
      throw new EpubError("MISSING_SPINE_ITEM");
    }
    const linear = itemrefEl.getAttribute("linear") !== "no";
    spine.push({ idref, linear, manifestItem });
  }
  return spine;
}

/** Spec §11.3 priorities 1-3 (priority 4, cover.xhtml's first image, is Phase 3's job). */
function resolveCoverImagePath(
  manifest: Map<string, EpubManifestItem>,
  metadataEl: XmlElement,
  packageEl: XmlElement,
  opfPath: string,
): string | undefined {
  for (const item of manifest.values()) {
    if (item.properties.has("cover-image")) {
      return item.absolutePath;
    }
  }
  for (const meta of elementsByLocalName(metadataEl, "meta")) {
    if (meta.getAttribute("name") === "cover") {
      const contentId = meta.getAttribute("content");
      if (contentId !== null) {
        const item = manifest.get(contentId);
        if (item !== undefined) {
          return item.absolutePath;
        }
      }
    }
  }
  const guideEl = firstByLocalName(packageEl, "guide");
  if (guideEl !== undefined) {
    for (const reference of elementsByLocalName(guideEl, "reference")) {
      if (reference.getAttribute("type") === "cover") {
        const href = reference.getAttribute("href");
        if (href !== null && href.trim().length > 0) {
          try {
            return resolveEpubRelativePath(opfPath, href);
          } catch {
            // An unsafe/unresolvable guide href just means "no cover found
            // this way" — never fails the whole parse.
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Parses the package document at `opfPath` (already resolved and verified
 * to exist by the caller — see container.ts#locatePackageDocument).
 * `filenameFallback` is the uploaded EPUB's original filename, threaded in
 * for spec §8.4.1's title fallback chain (Phase 2 has no access to it
 * otherwise — it is not part of the archive itself).
 */
export function parsePackageDocument(
  entries: Map<string, Uint8Array>,
  opfPath: string,
  filenameFallback?: string,
): EpubPackageDocument {
  const bytes = entries.get(opfPath);
  if (bytes === undefined) {
    throw new EpubError("MISSING_PACKAGE");
  }

  const xml = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  assertNoXxeMarkers(xml, "INVALID_PACKAGE");

  const doc = parseXmlDocument(xml);
  const packageEl = doc.documentElement;
  if (packageEl === null || localName(packageEl.tagName) !== "package") {
    throw new EpubError("INVALID_PACKAGE", "root element is not <package>");
  }

  const version = parseVersion(packageEl.getAttribute("version"));

  const metadataEl = firstByLocalName(packageEl, "metadata");
  const rawTitles = metadataEl === undefined
    ? []
    : elementsByLocalName(metadataEl, "title").map((el) => el.textContent ?? "");
  const rawCreators = metadataEl === undefined
    ? []
    : elementsByLocalName(metadataEl, "creator").map((el) => el.textContent ?? "");
  const language = metadataEl === undefined
    ? undefined
    : firstByLocalName(metadataEl, "language")?.textContent?.trim() || undefined;
  const identifier = metadataEl === undefined
    ? undefined
    : firstByLocalName(metadataEl, "identifier")?.textContent?.trim() || undefined;
  const renditionLayout = metadataEl === undefined ? undefined : findMetaProperty(metadataEl, "rendition:layout");
  const renditionOrientation = metadataEl === undefined ? undefined : findMetaProperty(metadataEl, "rendition:orientation");
  const renditionSpread = metadataEl === undefined ? undefined : findMetaProperty(metadataEl, "rendition:spread");

  const metadata: EpubMetadata = {
    title: resolveEpubTitle(rawTitles, filenameFallback),
    author: resolveEpubAuthor(rawCreators),
    language,
    identifier,
    renditionLayout,
    renditionOrientation,
    renditionSpread,
  };

  const isFixedLayout = metadataEl !== undefined && detectFixedLayout(metadataEl, renditionLayout);

  const manifestEl = firstByLocalName(packageEl, "manifest");
  if (manifestEl === undefined) {
    throw new EpubError("INVALID_PACKAGE", "missing <manifest>");
  }
  const manifest = parseManifest(manifestEl, opfPath);

  const spineEl = firstByLocalName(packageEl, "spine");
  const spine = spineEl === undefined ? [] : parseSpine(spineEl, manifest);
  if (spine.length === 0) {
    throw new EpubError("EMPTY_SPINE");
  }

  const coverImagePath = metadataEl === undefined
    ? undefined
    : resolveCoverImagePath(manifest, metadataEl, packageEl, opfPath);

  return {
    version,
    opfPath,
    metadata,
    manifest,
    spine,
    coverImagePath,
    isFixedLayout,
  };
}
