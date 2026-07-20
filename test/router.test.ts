import { describe, expect, it } from "vitest";
import { Router } from "../src/router";
import { ApiError } from "../src/security/errors";
import type { Env } from "../src/types";

// Router.handle() never touches bindings for these tests — every handler
// below ignores its env argument — so an empty object cast is enough.
const env = {} as Env;

describe("Router", () => {
  it("matches a static path and calls the handler", async () => {
    const router = new Router();
    router.get("/api/library/items", async () => Response.json({ ok: true }));

    const response = await router.handle(
      new Request("https://example.com/api/library/items"),
      env,
    );
    expect(response).not.toBeNull();
    expect(await response!.json()).toEqual({ ok: true });
  });

  it("extracts :param segments, URL-decoded", async () => {
    const router = new Router();
    let captured: Record<string, string> | undefined;
    router.get("/api/library/items/:itemId", async (_req, _env, params) => {
      captured = params;
      return Response.json({ itemId: params.itemId });
    });

    await router.handle(
      new Request("https://example.com/api/library/items/a%20b"),
      env,
    );
    expect(captured).toEqual({ itemId: "a b" });
  });

  it("returns null when no pattern matches the path (fallback to legacy route())", async () => {
    const router = new Router();
    router.get("/api/library/items", async () => Response.json({}));

    const response = await router.handle(new Request("https://example.com/jobs"), env);
    expect(response).toBeNull();
  });

  it("returns 405 with an Allow header listing the matched methods, in the new error shape", async () => {
    const router = new Router();
    router.get("/api/library/items/:itemId", async () => Response.json({}));
    router.delete("/api/library/items/:itemId", async () => Response.json({}));

    const response = await router.handle(
      new Request("https://example.com/api/library/items/x", { method: "PATCH" }),
      env,
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(405);
    expect(response!.headers.get("Allow")).toBe("DELETE, GET");
    expect(await response!.json()).toEqual({
      error: { code: "METHOD_NOT_ALLOWED", message: "method not allowed" },
    });
  });

  it("requires an exact segment count (no partial-prefix matches)", async () => {
    const router = new Router();
    router.get("/api/library/items/:itemId", async () => Response.json({}));

    const shortPath = await router.handle(
      new Request("https://example.com/api/library/items"),
      env,
    );
    const longPath = await router.handle(
      new Request("https://example.com/api/library/items/a/download"),
      env,
    );
    expect(shortPath).toBeNull();
    expect(longPath).toBeNull();
  });

  it("converts a thrown ApiError into its Response form", async () => {
    const router = new Router();
    router.get("/api/library/items", async () => {
      throw new ApiError(404, "ITEM_NOT_FOUND", "library item not found");
    });

    const response = await router.handle(
      new Request("https://example.com/api/library/items"),
      env,
    );
    expect(response!.status).toBe(404);
    expect(await response!.json()).toEqual({
      error: { code: "ITEM_NOT_FOUND", message: "library item not found" },
    });
  });

  it("converts an unexpected thrown error into a generic 500 without leaking its message", async () => {
    const router = new Router();
    router.get("/api/library/items", async () => {
      throw new Error("some internal SQL detail");
    });

    const response = await router.handle(
      new Request("https://example.com/api/library/items"),
      env,
    );
    expect(response!.status).toBe(500);
    expect(await response!.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "internal error" },
    });
  });
});
