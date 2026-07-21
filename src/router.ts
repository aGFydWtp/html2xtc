// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { toErrorResponse } from "./security/errors";
import type { Env } from "./types";

/**
 * Minimal method+path router for the new (Phase 0+) endpoints: auth,
 * library, devices, pairings, OPDS. Existing endpoints are NOT moved here —
 * they stay in src/index.ts's hand-written route(); this router only claims
 * new path patterns and returns null when nothing matches, so the caller
 * falls back to the legacy route() completely unchanged (see src/index.ts).
 *
 * Path patterns are static segments plus `:name` params (e.g.
 * "/api/library/items/:itemId"). No wildcards or regex — every new route in
 * the plan has a fixed segment count.
 */

export type RouteHandler = (
  request: Request,
  env: Env,
  params: Record<string, string>,
) => Promise<Response>;

interface RegisteredRoute {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: RegisteredRoute[] = [];

  add(method: string, pattern: string, handler: RouteHandler): void {
    this.routes.push({ method, segments: splitPath(pattern), handler });
  }

  get(pattern: string, handler: RouteHandler): void {
    this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): void {
    this.add("POST", pattern, handler);
  }

  patch(pattern: string, handler: RouteHandler): void {
    this.add("PATCH", pattern, handler);
  }

  put(pattern: string, handler: RouteHandler): void {
    this.add("PUT", pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): void {
    this.add("DELETE", pattern, handler);
  }

  /**
   * Returns null when no registered pattern matches the request path at all
   * — the caller should fall back to the legacy route(). When the path
   * matches one or more patterns but none for this method, returns a 405
   * (new error shape) with an Allow header listing the methods that do
   * match. Errors thrown by a matched handler (ApiError or otherwise) are
   * converted to a Response by toErrorResponse, so individual route modules
   * never need their own top-level try/catch.
   */
  async handle(request: Request, env: Env): Promise<Response | null> {
    const { pathname } = new URL(request.url);
    const requestSegments = splitPath(pathname);

    const methodsForPath = new Set<string>();
    for (const route of this.routes) {
      const params = matchSegments(route.segments, requestSegments);
      if (params === null) {
        continue;
      }
      methodsForPath.add(route.method);
      if (route.method === request.method) {
        try {
          return await route.handler(request, env, params);
        } catch (error) {
          return toErrorResponse(error);
        }
      }
    }

    if (methodsForPath.size === 0) {
      return null;
    }
    return Response.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "method not allowed" } },
      { status: 405, headers: { Allow: [...methodsForPath].sort().join(", ") } },
    );
  }
}

function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * Matches a pattern's segments against the request's segments, extracting
 * `:name` params. Returns null on any mismatch (segment count or a literal
 * segment that doesn't match).
 */
function matchSegments(
  pattern: string[],
  actual: string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const patternSegment = pattern[i] as string;
    const actualSegment = actual[i] as string;
    if (patternSegment.startsWith(":")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(actualSegment);
      } catch {
        return null; // malformed percent-encoding in the param segment
      }
      params[patternSegment.slice(1)] = decoded;
    } else if (patternSegment !== actualSegment) {
      return null;
    }
  }
  return params;
}
