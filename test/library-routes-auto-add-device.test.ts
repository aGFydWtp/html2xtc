// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spec item 3: "冪等復帰パス（既にライブラリに同じ source_job_id の項目が
 * あって既存行を返す場合）では端末追加を行わない" — this is the wiring in
 * src/library/routes.ts's from-job handler (`if (result.created) { ... }`),
 * so it's tested here at the route level with saveJobToLibrary and
 * autoAddItemToSoleActiveDevice mocked out, rather than in
 * test/devices-service-auto-add.test.ts (which tests
 * autoAddItemToSoleActiveDevice's own device-count/dedup logic in
 * isolation) or test/library-service-idempotent-save.test.ts (which tests
 * that saveJobToLibrary's `created` flag itself is false on the raced-
 * recovery path).
 */

vi.mock("../src/auth/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/sessions")>();
  return { ...actual, requireSession: vi.fn(async () => ({ id: "acct-1", displayName: "Haruki" })) };
});

vi.mock("../src/auth/csrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/csrf")>();
  return { ...actual, verifyCsrf: vi.fn(() => ({ ok: true as const })) };
});

vi.mock("../src/library/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/library/service")>();
  return { ...actual, saveJobToLibrary: vi.fn() };
});

vi.mock("../src/devices/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/devices/service")>();
  return { ...actual, autoAddItemToSoleActiveDevice: vi.fn() };
});

const { registerLibraryRoutes } = await import("../src/library/routes");
const { Router } = await import("../src/router");
const { saveJobToLibrary } = await import("../src/library/service");
const { autoAddItemToSoleActiveDevice } = await import("../src/devices/service");
type Env = import("../src/types").Env;

const JOB_ID = "0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f";
const ITEM_ID = "11111111-1111-4111-8111-111111111111";

function itemDto(): {
  id: string;
  title: string;
  author: string | null;
  sizeBytes: number;
  sha256: string | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: ITEM_ID,
    title: "Book",
    author: null,
    sizeBytes: 1,
    sha256: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function postFromJob(): Promise<Response> {
  const router = new Router();
  registerLibraryRoutes(router);
  const response = await router.handle(
    new Request("https://example.com/api/library/items/from-job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: JOB_ID }),
    }),
    {} as unknown as Env,
  );
  expect(response).not.toBeNull();
  return response as Response;
}

describe("POST /api/library/items/from-job — auto-add-to-sole-device wiring", () => {
  beforeEach(() => {
    vi.mocked(saveJobToLibrary).mockReset();
    vi.mocked(autoAddItemToSoleActiveDevice).mockReset().mockResolvedValue(undefined);
  });

  it("calls autoAddItemToSoleActiveDevice with the new item's id when saveJobToLibrary reports created: true", async () => {
    vi.mocked(saveJobToLibrary).mockResolvedValue({ item: itemDto(), created: true });

    const response = await postFromJob();

    expect(response.status).toBe(200);
    const body = (await response.json()) as { item: { id: string } };
    expect(body.item.id).toBe(ITEM_ID);
    expect(autoAddItemToSoleActiveDevice).toHaveBeenCalledTimes(1);
    expect(vi.mocked(autoAddItemToSoleActiveDevice).mock.calls[0]?.[2]).toBe(ITEM_ID);
  });

  it("does NOT call autoAddItemToSoleActiveDevice on the idempotent-replay path (created: false)", async () => {
    vi.mocked(saveJobToLibrary).mockResolvedValue({ item: itemDto(), created: false });

    const response = await postFromJob();

    expect(response.status).toBe(200);
    const body = (await response.json()) as { item: { id: string } };
    expect(body.item.id).toBe(ITEM_ID);
    expect(autoAddItemToSoleActiveDevice).not.toHaveBeenCalled();
  });
});
