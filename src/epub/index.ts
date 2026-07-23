// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * EPUB → XTC parser (Phase 2: EPUB_TO_XTC_IMPLEMENTATION_SPEC.md §8).
 * Re-exports the public surface of every src/epub/* module for downstream
 * (Phase 3 HTML generation, Phase 4 Workflow) consumers.
 */

export * from "./archive";
export * from "./assets";
export * from "./container";
export * from "./css";
export * from "./errors";
export * from "./html";
export * from "./navigation";
export * from "./opf";
export * from "./sanitize";
export * from "./types";
