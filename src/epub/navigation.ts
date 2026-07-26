// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { resolveEpubRelativePath } from "./archive";
import { assertNoXxeMarkers } from "./errors";
import type { EpubNavigation, EpubNavigationEntry, EpubPackageDocument } from "./types";
import { elementsByLocalName, localName, parseXmlDocument } from "./xml";
import type { XmlElement } from "./xml";

/**
 * Parses the EPUB3 navigation document or EPUB2 NCX (spec §8.7) into a flat
 * list of (label, href) entries, used for spec §8.7's stated purposes:
 * spine item chapter-title hints and the optional generated table of
 * contents (includeTableOfContents=true, Phase 3). Never throws — "目次解析
 * に失敗しても本文変換は継続する" (spec §8.7) is implemented by catching
 * everything here and degrading to { source: "none", entries: [] }.
 */

const MAX_LABEL_CHARS = 200;

/** Resolves an href that may carry a "#fragment", re-attaching the fragment verbatim after resolving the path part. An href that is only a fragment resolves to `basePath` itself. */
function resolveHrefWithFragment(basePath: string, href: string): string {
  const hashIndex = href.indexOf("#");
  const pathPart = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : href.slice(hashIndex);
  if (pathPart.trim().length === 0) {
    return `${basePath}${fragment}`;
  }
  return `${resolveEpubRelativePath(basePath, pathPart)}${fragment}`;
}

function cleanLabel(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS);
}

/**
 * EPUB3 nav top-level test: true iff, walking up from `a`'s parent to (but
 * not including) `tocNav`, exactly one `<li>` ancestor is crossed. Anchors
 * inside a NESTED `<ol>`/`<ul>` (a sub-heading under some other entry) cross
 * a SECOND `<li>` on the way up and come back false. Deliberately tag-name
 * agnostic (checks for `<li>`, not specifically `<ol>` vs `<ul>`) so this
 * still works on a non-conformant nav that uses `<ul>` instead of the
 * EPUB3-spec-required `<ol>`. An anchor with NO `<li>` ancestor at all
 * (malformed markup) is also not top-level — there is no list structure to
 * be "the top" of.
 */
function isTopLevelNavAnchor(a: XmlElement, tocNav: XmlElement): boolean {
  let seenLi = false;
  let current = a.parentElement;
  while (current !== null && current !== tocNav) {
    if (localName(current.tagName) === "li") {
      if (seenLi) {
        return false;
      }
      seenLi = true;
    }
    current = current.parentElement;
  }
  return seenLi;
}

function parseNavDocument(xml: string, navPath: string): EpubNavigation {
  const doc = parseXmlDocument(xml);
  if (doc.documentElement === null) {
    return { source: "none", entries: [] };
  }
  const navs = elementsByLocalName(doc.documentElement, "nav");
  if (navs.length === 0) {
    return { source: "none", entries: [] };
  }
  const tocNav =
    navs.find((el) =>
      (el.getAttribute("epub:type") ?? el.getAttribute("type") ?? "")
        .split(/\s+/)
        .includes("toc"),
    ) ?? navs[0];
  if (tocNav === undefined) {
    return { source: "none", entries: [] };
  }

  const entries: EpubNavigationEntry[] = [];
  const anchors = elementsByLocalName(tocNav, "a");
  for (const a of anchors) {
    const href = a.getAttribute("href");
    const label = cleanLabel(a.textContent ?? "");
    if (href === null || href.trim().length === 0 || label.length === 0) {
      continue;
    }
    try {
      entries.push({
        label,
        href: resolveHrefWithFragment(navPath, href),
        isTopLevel: isTopLevelNavAnchor(a, tocNav),
      });
    } catch {
      continue; // skip an individual unsafe/unresolvable entry
    }
  }
  return { source: "nav", entries };
}

/**
 * EPUB2 NCX top-level test: true iff NO ancestor of `navPoint` is itself a
 * `navPoint` — i.e. `navPoint` is a direct (or otherwise unnested-through-
 * another-navPoint) child of `<navMap>`, "depth 1" in the NCX's own terms.
 */
function isTopLevelNavPoint(navPoint: XmlElement): boolean {
  let current = navPoint.parentElement;
  while (current !== null) {
    if (localName(current.tagName) === "navpoint") {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}

function parseNcxDocument(xml: string, ncxPath: string): EpubNavigation {
  const doc = parseXmlDocument(xml);
  if (doc.documentElement === null) {
    return { source: "none", entries: [] };
  }
  const navPoints = elementsByLocalName(doc.documentElement, "navpoint");

  const entries: EpubNavigationEntry[] = [];
  for (const navPoint of navPoints) {
    const children = navPoint.querySelectorAll("*") as XmlElement[];
    const labelTextEl = children.find(
      (el) =>
        localName(el.tagName) === "text" &&
        localName(el.parentElement?.tagName ?? "") === "navlabel",
    );
    const contentEl = children.find((el) => localName(el.tagName) === "content");
    const label = cleanLabel(labelTextEl?.textContent ?? "");
    const src = contentEl?.getAttribute("src") ?? null;
    if (label.length === 0 || src === null || src.trim().length === 0) {
      continue;
    }
    try {
      entries.push({
        label,
        href: resolveHrefWithFragment(ncxPath, src),
        isTopLevel: isTopLevelNavPoint(navPoint),
      });
    } catch {
      continue;
    }
  }
  return { source: "ncx", entries };
}

/** Locates the navigation document per spec §8.7: EPUB3's properties="nav" manifest item first, else the EPUB2 NCX (application/x-dtbncx+xml). */
export function locateNavigationDocument(
  pkg: EpubPackageDocument,
): { path: string; kind: "nav" | "ncx" } | undefined {
  for (const item of pkg.manifest.values()) {
    if (item.properties.has("nav")) {
      return { path: item.absolutePath, kind: "nav" };
    }
  }
  for (const item of pkg.manifest.values()) {
    if (item.mediaType === "application/x-dtbncx+xml") {
      return { path: item.absolutePath, kind: "ncx" };
    }
  }
  return undefined;
}

export function parseEpubNavigation(
  entries: Map<string, Uint8Array>,
  pkg: EpubPackageDocument,
): EpubNavigation {
  try {
    const located = locateNavigationDocument(pkg);
    if (located === undefined) {
      return { source: "none", entries: [] };
    }
    const bytes = entries.get(located.path);
    if (bytes === undefined) {
      return { source: "none", entries: [] };
    }
    const xml = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
    assertNoXxeMarkers(xml, "INVALID_PACKAGE");
    return located.kind === "nav"
      ? parseNavDocument(xml, located.path)
      : parseNcxDocument(xml, located.path);
  } catch {
    // Spec §8.7: a broken TOC document never fails the whole conversion.
    return { source: "none", entries: [] };
  }
}
