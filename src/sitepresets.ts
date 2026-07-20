// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Site-specific presets: URL predicates that switch a conversion onto a
 * dedicated rendering path. Kept separate from validate.ts on purpose —
 * that module is SSRF protection, this one is layout/typography routing.
 */

/**
 * Aozora Bunko XHTML files: /cards/{6-digit author id}/files/{card}_{file}.html
 * on (www.)aozora.gr.jp. Only the XHTML reader files match — card pages,
 * index pages and the zip/txt downloads do not, so everything else on the
 * site keeps the default pipeline.
 */
const AOZORA_XHTML_PATH = /^\/cards\/\d{6}\/files\/\d+_\d+\.html$/;

export function isAozoraBunkoUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "www.aozora.gr.jp" && host !== "aozora.gr.jp") {
    return false;
  }
  return AOZORA_XHTML_PATH.test(url.pathname);
}
