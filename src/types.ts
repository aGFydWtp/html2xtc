// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { XtcConverterContainer } from "./container";
import type { RateLimiter } from "./ratelimiter";

/**
 * Conversion mode: "full" renders the page as-is (the original behavior);
 * "extract" pulls the main article content out first (src/extract.ts) and
 * renders that instead.
 */
export type ConvertMode = "full" | "extract";

/** Page-flow direction of the rendered PDF. */
export type ConvertLayout = "horizontal" | "vertical";

/**
 * Resolved rendering options, produced by resolveRenderOptions()
 * (src/sitepresets.ts) from the request's optional layout/font fields plus
 * the per-site defaults (Aozora Bunko → vertical + BIZ UDMincho).
 *
 * INVARIANT: `font` is a sanitized Google Fonts family name — safe to embed
 * in a quoted CSS font-family declaration and in the css2 URL. ALWAYS build
 * this type via resolveRenderOptions() (or pass the value through
 * sanitizeFontFamily, src/fonts.ts); never place raw request input here.
 * (A branded type could enforce this at compile time; deliberately not
 * introduced yet — reviewed and deferred.)
 */
export interface RenderOptions {
  layout: ConvertLayout;
  font: string;
}

/** Params handed to ConvertWorkflow via CONVERT_WORKFLOW.create(). */
export interface ConvertJobParams {
  url: string;
  /** Absent on jobs created before extract mode existed; treated as "full". */
  mode?: ConvertMode;
  /**
   * Raw optional render options as submitted (loosely typed on purpose:
   * params persist across deploys, so the Workflow re-validates them via
   * resolveRenderOptions instead of trusting the stored shape).
   */
  layout?: string;
  font?: string;
}

/**
 * Params handed to AozoraCatalogSyncWorkflow via AOZORA_SYNC_WORKFLOW.create()
 * from scheduled(). Carries only the Cron controller fields — the instance ID
 * (derived from scheduledTime) is what dedupes a doubled Cron delivery.
 */
export interface AozoraCatalogSyncParams {
  scheduledTime: number;
  cron: string;
}

export interface Env {
  BROWSER: BrowserRun;
  XTC_BUCKET: R2Bucket;
  XTC_CONVERTER: DurableObjectNamespace<XtcConverterContainer>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  CONVERT_WORKFLOW: Workflow<ConvertJobParams>;
  /** D1 holding the Aozora Bunko catalog (generation-versioned). */
  AOZORA_DB: D1Database;
  /** Daily catalog sync, kicked off by scheduled() (src/catalog-workflow.ts). */
  AOZORA_SYNC_WORKFLOW: Workflow<AozoraCatalogSyncParams>;
  /** Max rendered-PDF size in bytes. Default 20 MiB. */
  MAX_PDF_BYTES?: string;
  /**
   * Minimum extracted body length (characters after whitespace removal) for
   * extract mode to accept a Readability result. Default 300.
   */
  EXTRACT_MIN_CHARS?: string;
  /**
   * Per-IP request limit for POST /convert and POST /jobs (fixed 1-hour
   * window). Default 50.
   */
  RATE_LIMIT_PER_HOUR?: string;
}
