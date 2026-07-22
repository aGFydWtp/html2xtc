// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { XtcConverterContainer } from "./container";
import type { RateLimiter } from "./ratelimiter";
import type { TextConvertOptions } from "./text-options";

/**
 * Conversion mode: "full" renders the page as-is (the original behavior);
 * "extract" pulls the main article content out first (src/extract.ts) and
 * renders that instead.
 */
export type ConvertMode = "full" | "extract";

/** Page-flow direction of the rendered PDF. */
export type ConvertLayout = "horizontal" | "vertical";

/**
 * Conversion input (spec §9.1). "url" is the original URL-render pipeline
 * (Browser Run → render-pdf → convert-xtc). "pdf" is the uploaded-PDF
 * pipeline (POST /jobs/pdf, src/pdf-upload.ts): key is the R2 object holding
 * the uploaded PDF (input/{jobId}/source.pdf, src/jobs.ts#inputPdfKey),
 * filename is the sanitized display name from X-File-Name (never a path),
 * size is the declared Content-Length the Worker verified against the
 * stored R2 object. "text" is the uploaded-TXT pipeline (POST /jobs/text,
 * src/text-upload.ts): same key/filename/size shape as "pdf", but the R2
 * object lives at input/{jobId}/source.txt (src/jobs.ts#inputTextKey) and is
 * plain-text bytes, never HTML/Markdown-interpreted (text-upload spec §4.1).
 */
export type ConvertSource =
  | { kind: "url"; url: string }
  | { kind: "pdf"; key: string; filename: string; size: number }
  | { kind: "text"; key: string; filename: string; size: number };

/**
 * PDF conversion settings (spec §5.1), applied in the fixed order from spec
 * §6: page selection → rotation → crop → contain/cover → margin →
 * grayscale → 528×792 resample → invert → threshold/dither → XTC.
 * Validated strictly by validatePdfConvertOptions (src/pdf-upload.ts) — no
 * implicit correction of out-of-range values (spec §5.3).
 */
export interface PdfConvertOptions {
  /** Page selection string; syntax per spec §5.4 (see src/pdf-page-range.ts). */
  pages: string;
  /** Rotation applied to every selected page. */
  rotation: 0 | 90 | 180 | 270;
  /**
   * Crop fraction removed from each edge of the rotated page. Each side is
   * in [0.0, 0.4]; left+right and top+bottom must each stay below 0.8.
   */
  crop: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  /** How the cropped page fills the X3 inner display area. */
  fit: "contain" | "cover";
  /** Uniform output margin in X3 pixels (0-64). */
  marginPx: number;
  /** 1-bit threshold (0-255). */
  threshold: number;
  /** Floyd–Steinberg dithering on/off. */
  dither: boolean;
  /** Dithering strength (0.0-1.0). */
  ditherStrength: number;
  /** Invert black/white. */
  invert: boolean;
}

/**
 * Resolved rendering options, produced by resolveRenderOptions()
 * (src/sitepresets.ts) from the request's optional layout/font fields plus
 * the per-site defaults (Aozora Bunko → vertical + BIZ UDPMincho).
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
  /**
   * Legacy field, kept for jobs created before `source` existed. Optional
   * now (was required) — a purely static relaxation: Workflow instance
   * params already persisted with a string `url` are unaffected, since this
   * type only shapes new create() calls and event.payload reads. New PDF
   * jobs never set this; new URL jobs may set either this or
   * `source: {kind:"url",...}` (resolveSource in src/workflow.ts prefers
   * `source` when both are present).
   */
  url?: string;
  /** Conversion input; see ConvertSource. Preferred over the legacy `url`. */
  source?: ConvertSource;
  /** Absent on jobs created before extract mode existed; treated as "full". */
  mode?: ConvertMode;
  /**
   * Raw optional render options as submitted (loosely typed on purpose:
   * params persist across deploys, so the Workflow re-validates them via
   * resolveRenderOptions instead of trusting the stored shape). Unused for
   * PDF sources.
   */
  layout?: string;
  font?: string;
  /** PDF conversion settings; only meaningful when source.kind === "pdf". */
  pdfOptions?: PdfConvertOptions;
  /** Text conversion settings; only meaningful when source.kind === "text". */
  textOptions?: TextConvertOptions;
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
  /**
   * D1 holding application data: accounts, WebAuthn credentials, sessions,
   * devices, pairings, and the persistent library (migrations/app).
   * Deliberately separate from AOZORA_DB so catalog re-syncs never touch
   * user data (see implementation plan §7).
   */
  APP_DB: D1Database;
  /** Max rendered-PDF size in bytes. Default 20 MiB. */
  MAX_PDF_BYTES?: string;
  /**
   * Max size in bytes accepted by POST /jobs/pdf (spec §11.4). Deliberately
   * a separate var from MAX_PDF_BYTES, even though both default to the same
   * 48 MiB (50331648) value today — one bounds a Browser-Run-rendered PDF,
   * the other a user-uploaded PDF; they should stay independently tunable.
   * Also forwarded to the Container as X-Max-Pdf-Bytes so both sides agree.
   */
  MAX_UPLOAD_PDF_BYTES?: string;
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
  /**
   * Per-IP request limit for POST /preview/text (fixed 1-hour window,
   * namespaced separately from RATE_LIMIT_PER_HOUR via
   * enforcePurposeRateLimit). Default 20 (preview spec §8).
   */
  TEXT_PREVIEW_RATE_LIMIT_PER_HOUR?: string;
  /**
   * WebAuthn relying party ID (e.g. "xtc.hr20k.com"). Required once the
   * passkey routes (a later phase) are wired up; unset in this phase.
   */
  WEBAUTHN_RP_ID?: string;
  /**
   * Expected Origin for WebAuthn ceremonies and the CSRF Origin check
   * (src/auth/csrf.ts), e.g. "https://xtc.hr20k.com".
   */
  WEBAUTHN_ORIGIN?: string;
  /** Session cookie lifetime in days. Default 30 (src/auth/sessions.ts). */
  SESSION_TTL_DAYS?: string;
  /**
   * Secret mixed into the session token hash before it is persisted to D1
   * (src/auth/sessions.ts). A Wrangler secret, never a var.
   */
  SESSION_PEPPER?: string;
  /**
   * AES-GCM key used to encrypt a device token in transit during pairing
   * (device_pairings.encrypted_device_token). Consumed by the pairing
   * module added in a later phase.
   */
  PAIRING_ENCRYPTION_KEY?: string;
  /**
   * Secret used to validate one-time registration invite tokens. Consumed by
   * the passkey registration routes added in a later phase.
   */
  REGISTRATION_INVITE_SECRET?: string;
}
