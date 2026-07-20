// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { DEFAULT_FONT_FAMILY, sanitizeFontFamily } from "./fonts";
import type { RenderOptions } from "./types";

/**
 * Site-specific presets: URL predicates that pick per-site DEFAULTS for the
 * rendering options. Kept separate from validate.ts on purpose — that module
 * is SSRF protection, this one is layout/typography routing.
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

/** Default body family for Aozora Bunko documents (literary serif, UD). */
const AOZORA_DEFAULT_FONT_FAMILY = "BIZ UDMincho";

/**
 * Resolves the request's optional layout/font fields into concrete render
 * options. Explicit values win; anything absent OR invalid falls back
 * fail-soft (never a 4xx) to the per-site default — vertical + BIZ UDMincho
 * for Aozora Bunko XHTML, horizontal + BIZ UDPGothic everywhere else. So an
 * Aozora page CAN be forced horizontal and any site CAN be rendered
 * vertical/mincho; the URL check only fills the blanks.
 *
 * Inputs are deliberately loose (unknown/string): this also re-validates
 * Workflow params persisted by older deploys, making it the single choke
 * point where `font` passes sanitizeFontFamily before reaching CSS or URLs.
 */
export function resolveRenderOptions(
  target: URL,
  layout?: unknown,
  font?: unknown,
): RenderOptions {
  const aozora = isAozoraBunkoUrl(target);
  return {
    layout:
      layout === "horizontal" || layout === "vertical"
        ? layout
        : aozora
          ? "vertical"
          : "horizontal",
    font:
      sanitizeFontFamily(font) ??
      (aozora ? AOZORA_DEFAULT_FONT_FAMILY : DEFAULT_FONT_FAMILY),
  };
}
