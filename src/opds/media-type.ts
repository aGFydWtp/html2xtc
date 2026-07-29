// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Vendor media type for XTC files, shared by the OPDS acquisition link
 * (src/opds/feed.ts) and the download route's Content-Type response header
 * (src/opds/routes.ts) so the two never drift apart. Replaces the previous
 * generic `application/octet-stream`, which the reference CrossPoint OPDS
 * client cannot reliably identify as an XTC file without a `.xtc` URL
 * extension to fall back on — see docs/opds-xtc-media-type-adr.md.
 */
export const XTC_MEDIA_TYPE = "application/vnd.xteink.xtc";
