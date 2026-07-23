// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { resolveEpubRelativePath } from "./archive";
import { assertNoXxeMarkers, EpubError } from "./errors";
import { elementsByLocalName, parseXmlDocument } from "./xml";

/**
 * Parses META-INF/container.xml (EPUB spec §8.3) and locates the package
 * document (OPF) path. See xml.ts's doc comment for why this uses
 * parseXmlDocument rather than the parseHTML-based pattern elsewhere in the
 * codebase (src/printhtml.ts).
 */

const CONTAINER_XML_PATH = "META-INF/container.xml";

/**
 * Decodes entries.get(CONTAINER_XML_PATH), parses it, and returns the
 * archive-root-relative POSIX path of the package document to use (spec
 * §8.3's rootfile selection: prefer media-type="application/oebps-package
 * +xml", else the first rootfile whose full-path safely resolves inside the
 * archive; MISSING_CONTAINER when the file itself is absent, INVALID_CONTAINER
 * for every other failure).
 */
export function locatePackageDocument(entries: Map<string, Uint8Array>): string {
  const bytes = entries.get(CONTAINER_XML_PATH);
  if (bytes === undefined) {
    throw new EpubError("MISSING_CONTAINER");
  }

  const xml = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  assertNoXxeMarkers(xml, "INVALID_CONTAINER");

  const doc = parseXmlDocument(xml);
  if (doc.documentElement === null) {
    throw new EpubError("INVALID_CONTAINER", "unparseable XML");
  }

  const rootfiles = elementsByLocalName(doc.documentElement, "rootfile");
  if (rootfiles.length === 0) {
    throw new EpubError("INVALID_CONTAINER", "no rootfile elements");
  }

  const byPreferredMediaType = rootfiles.filter(
    (el) => el.getAttribute("media-type") === "application/oebps-package+xml",
  );
  const candidates = byPreferredMediaType.length > 0 ? byPreferredMediaType : rootfiles;

  for (const el of candidates) {
    const fullPath = el.getAttribute("full-path");
    if (fullPath === null || fullPath.trim().length === 0) {
      continue;
    }
    try {
      // full-path is relative to the archive root (OCF spec), NOT relative
      // to META-INF/ — resolve against the empty base "" (root), unlike an
      // OPF manifest href, which is relative to the OPF's own directory.
      return resolveEpubRelativePath("", fullPath);
    } catch {
      continue; // unsafe/unresolvable full-path on this candidate; try the next
    }
  }

  throw new EpubError("INVALID_CONTAINER", "no rootfile with a valid full-path");
}
