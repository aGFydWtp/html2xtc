import { describe, expect, it, vi } from "vitest";
import { ApiError, Errors, apiErrorResponse, errorResponse, toErrorResponse } from "../src/security/errors";

describe("errorResponse / apiErrorResponse", () => {
  it("builds the {error:{code,message}} shape with the given status", async () => {
    const response = errorResponse(404, "NOT_FOUND", "not found");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "not found" } });
  });

  it("apiErrorResponse mirrors an ApiError's status/code/message", async () => {
    const error = new ApiError(409, "CONFLICT", "version mismatch");
    const response = apiErrorResponse(error);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "CONFLICT", message: "version mismatch" },
    });
  });
});

describe("Errors factories", () => {
  it("unauthorized defaults to 401 UNAUTHORIZED", () => {
    const error = Errors.unauthorized();
    expect(error.status).toBe(401);
    expect(error.code).toBe("UNAUTHORIZED");
  });

  it("badRequest/notFound/conflict/forbidden carry the given code and 4xx status", () => {
    expect(Errors.badRequest("X", "m").status).toBe(400);
    expect(Errors.notFound("X", "m").status).toBe(404);
    expect(Errors.conflict("X", "m").status).toBe(409);
    expect(Errors.forbidden("X", "m").status).toBe(403);
  });

  it("internal defaults to a generic message, never echoing caller detail unless explicit", () => {
    expect(Errors.internal().message).toBe("internal error");
    expect(Errors.internal().status).toBe(500);
  });
});

describe("toErrorResponse", () => {
  it("passes an ApiError through as its Response form", async () => {
    const response = toErrorResponse(Errors.notFound("ITEM_NOT_FOUND", "library item not found"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "ITEM_NOT_FOUND", message: "library item not found" },
    });
  });

  it("maps any other thrown value to a generic 500, logging but never leaking the detail", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = toErrorResponse(new Error("SELECT failed: secret_table"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "INTERNAL_ERROR", message: "internal error" } });
    expect(JSON.stringify(body)).not.toContain("secret_table");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
