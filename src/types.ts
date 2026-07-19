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

/** Params handed to ConvertWorkflow via CONVERT_WORKFLOW.create(). */
export interface ConvertJobParams {
  url: string;
  /** Absent on jobs created before extract mode existed; treated as "full". */
  mode?: ConvertMode;
}

export interface Env {
  BROWSER: BrowserRun;
  XTC_BUCKET: R2Bucket;
  XTC_CONVERTER: DurableObjectNamespace<XtcConverterContainer>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  CONVERT_WORKFLOW: Workflow<ConvertJobParams>;
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
