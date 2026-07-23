// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Structural types shared across the EPUB parser (EPUB spec §8). Kept free
 * of linkedom/fflate imports so downstream (Phase 3/4) modules can depend on
 * just the shapes without pulling in parsing internals.
 */

/** One manifest item (spec §8.5). `properties` holds the raw OPF3 tokens (e.g. "nav", "cover-image", "scripted"). */
export interface EpubManifestItem {
  id: string;
  /** href exactly as declared in the OPF (raw, NOT URL-decoded), relative to the OPF's directory — see `absolutePath` for the decoded, resolved, safety-checked form. */
  href: string;
  mediaType: string;
  properties: Set<string>;
  /** Normalized, archive-root-relative POSIX path (spec §8.5's traversal check already applied). */
  absolutePath: string;
}

/** One spine entry (spec §8.6), already resolved to its manifest item. Filtering by `linear` (or by includeTableOfContents) is a Phase 3 rendering decision, not done here. */
export interface EpubSpineItem {
  idref: string;
  linear: boolean;
  manifestItem: EpubManifestItem;
}

/** OPF metadata fields consumed by X3 rendering (spec §8.4). */
export interface EpubMetadata {
  /** Never empty — see resolveEpubTitle's 3-tier fallback (spec §8.4.1). */
  title: string;
  /** Up to 3 creators joined by " / " (spec §8.4.2); undefined when the OPF has none. */
  author?: string;
  language?: string;
  identifier?: string;
  renditionLayout?: string;
  renditionOrientation?: string;
  renditionSpread?: string;
}

export type EpubVersion = "2.0" | "3.0" | "unknown";

/** Parsed package document (spec §8.4-8.6). */
export interface EpubPackageDocument {
  version: EpubVersion;
  /** Archive-root-relative POSIX path of the OPF itself. */
  opfPath: string;
  metadata: EpubMetadata;
  /** Keyed by manifest item id. */
  manifest: Map<string, EpubManifestItem>;
  spine: EpubSpineItem[];
  /**
   * Resolved per spec §11.3 priorities 1-3 (manifest properties="cover-image"
   * / EPUB2 <meta name="cover"> / guide type="cover"). Priority 4
   * (cover.xhtml's first image) is content-level and left to Phase 3.
   */
  coverImagePath?: string;
  /** True when spec §8.4.3's fixed-layout detection matched (caller should reject with FIXED_LAYOUT_UNSUPPORTED). */
  isFixedLayout: boolean;
}

/** One navigation entry (spec §8.7), from an EPUB3 nav document or an EPUB2 NCX. */
export interface EpubNavigationEntry {
  label: string;
  /** Archive-root-relative POSIX path; a fragment (if any) is preserved as a trailing "#id". */
  href: string;
}

export interface EpubNavigation {
  source: "nav" | "ncx" | "none";
  entries: EpubNavigationEntry[];
}
