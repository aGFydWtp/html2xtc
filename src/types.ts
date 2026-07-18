// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { XtcConverterContainer } from "./container";
import type { RateLimiter } from "./ratelimiter";

/** Params handed to ConvertWorkflow via CONVERT_WORKFLOW.create(). */
export interface ConvertJobParams {
  url: string;
}

export interface Env {
  BROWSER: BrowserRun;
  XTC_BUCKET: R2Bucket;
  XTC_CONVERTER: DurableObjectNamespace<XtcConverterContainer>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  CONVERT_WORKFLOW: Workflow<ConvertJobParams>;
  /**
   * Optional bearer token (set via `wrangler secret put AUTH_TOKEN`).
   * When unset (local dev), authentication is skipped.
   */
  AUTH_TOKEN?: string;
  /** Max rendered-PDF size in bytes. Default 20 MiB. */
  MAX_PDF_BYTES?: string;
  /**
   * Per-IP request limit for POST /convert and POST /jobs (fixed 1-hour
   * window). Default 50.
   */
  RATE_LIMIT_PER_HOUR?: string;
  /**
   * Cloudflare Access JWT verification (both required to activate it).
   * ACCESS_TEAM_DOMAIN is the full origin, e.g. "https://<team>.cloudflareaccess.com";
   * ACCESS_POLICY_AUD is the Access app's Application Audience (AUD) tag.
   */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_POLICY_AUD?: string;
}
