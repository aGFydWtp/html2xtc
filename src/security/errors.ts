// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Common error shape for the new (Phase 0+) routes:
 *   {"error": {"code": "...", "message": "..."}}
 *
 * Deliberately different from the legacy {"error": "<string>"} shape used by
 * the original /convert, /jobs, /download, /api/books endpoints
 * (src/index.ts) — those are left byte-for-byte unchanged for response
 * compatibility; only routes registered on the new Router (src/router.ts)
 * use this shape.
 *
 * `message` must never leak internals (SQL, R2 keys, stack traces, secret
 * values) — detail goes to console.error only, matching the existing
 * convention in src/index.ts (e.g. handleCreateJob's workflow-create catch).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Builds the {"error":{code,message}} Response for a given status/code/message. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  init?: ResponseInit,
): Response {
  return Response.json(
    { error: { code, message } },
    { ...init, status },
  );
}

/** Converts an ApiError into its Response form. */
export function apiErrorResponse(error: ApiError): Response {
  return errorResponse(error.status, error.code, error.message);
}

/**
 * Converts any thrown value into a Response: ApiErrors keep their
 * status/code/message, anything else is logged (never shown to the client)
 * and reported as a generic 500. Used by Router.handle so every new-route
 * handler gets consistent error handling without repeating try/catch.
 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return apiErrorResponse(error);
  }
  console.error("unhandled route error", error);
  return errorResponse(500, "INTERNAL_ERROR", "internal error");
}

/** Factory helpers for the ApiError shapes routes throw most often. */
export const Errors = {
  unauthorized(message = "authentication required"): ApiError {
    return new ApiError(401, "UNAUTHORIZED", message);
  },
  forbidden(code: string, message: string): ApiError {
    return new ApiError(403, code, message);
  },
  badRequest(code: string, message: string): ApiError {
    return new ApiError(400, code, message);
  },
  notFound(code: string, message: string): ApiError {
    return new ApiError(404, code, message);
  },
  conflict(code: string, message: string): ApiError {
    return new ApiError(409, code, message);
  },
  payloadTooLarge(code: string, message: string): ApiError {
    return new ApiError(413, code, message);
  },
  serviceUnavailable(code: string, message: string): ApiError {
    return new ApiError(503, code, message);
  },
  internal(message = "internal error"): ApiError {
    return new ApiError(500, "INTERNAL_ERROR", message);
  },
};
