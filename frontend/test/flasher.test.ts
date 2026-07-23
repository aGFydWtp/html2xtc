// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadManifestState, MANIFEST_URLS } from "../src/lib/flasher";

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200;
  return {
    status,
    ok: init.ok ?? (status >= 200 && status < 300),
    json: async () => body,
  } as unknown as Response;
}

const VALID_MANIFEST = {
  name: "CrossPoint JP",
  version: "dev-20260723",
  builds: [
    {
      chipFamily: "ESP32-C3",
      parts: [
        { path: "dev/bootloader.bin", offset: 0 },
        { path: "dev/partitions.bin", offset: 32768 },
        { path: "dev/firmware.bin", offset: 65536 },
      ],
    },
  ],
};

describe("flasher.ts", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // H2X-FL-01: Dev URL — 正しい manifest URL
  it("H2X-FL-01: MANIFEST_URLS.dev points to the dev manifest", () => {
    expect(MANIFEST_URLS.dev).toBe("https://flasher.xtc.hr20k.com/manifest_dev.json");
  });

  // H2X-FL-02: Stable URL — 正しい manifest URL
  it("H2X-FL-02: MANIFEST_URLS.stable points to the stable manifest", () => {
    expect(MANIFEST_URLS.stable).toBe("https://flasher.xtc.hr20k.com/manifest_stable.json");
  });

  // H2X-FL-03: 正常 manifest — available
  it("H2X-FL-03: resolves to available for a well-formed manifest", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_MANIFEST));
    const result = await loadManifestState(MANIFEST_URLS.dev);
    expect(result).toEqual({
      status: "available",
      version: "dev-20260723",
      manifestUrl: MANIFEST_URLS.dev,
    });
  });

  // H2X-FL-04: version 欠落 — invalid
  it("H2X-FL-04: resolves to invalid when version is missing", async () => {
    const { version: _version, ...withoutVersion } = VALID_MANIFEST;
    fetchMock.mockResolvedValue(jsonResponse(withoutVersion));
    const result = await loadManifestState(MANIFEST_URLS.dev);
    expect(result).toEqual({ status: "unavailable", reason: "invalid" });
  });

  // H2X-FL-05: builds 欠落 — invalid
  it("H2X-FL-05: resolves to invalid when builds is missing", async () => {
    const { builds: _builds, ...withoutBuilds } = VALID_MANIFEST;
    fetchMock.mockResolvedValue(jsonResponse(withoutBuilds));
    const result = await loadManifestState(MANIFEST_URLS.dev);
    expect(result).toEqual({ status: "unavailable", reason: "invalid" });
  });

  // H2X-FL-06: chipFamily 不正 — invalid
  it("H2X-FL-06: resolves to invalid when chipFamily is not ESP32-C3", async () => {
    const manifest = {
      ...VALID_MANIFEST,
      builds: [{ ...VALID_MANIFEST.builds[0], chipFamily: "ESP32" }],
    };
    fetchMock.mockResolvedValue(jsonResponse(manifest));
    const result = await loadManifestState(MANIFEST_URLS.dev);
    expect(result).toEqual({ status: "unavailable", reason: "invalid" });
  });

  // H2X-FL-07: オフセット不足 — invalid
  it("H2X-FL-07: resolves to invalid when a required offset is missing", async () => {
    const manifest = {
      ...VALID_MANIFEST,
      builds: [
        {
          chipFamily: "ESP32-C3",
          parts: [
            { path: "dev/bootloader.bin", offset: 0 },
            { path: "dev/firmware.bin", offset: 65536 },
          ],
        },
      ],
    };
    fetchMock.mockResolvedValue(jsonResponse(manifest));
    const result = await loadManifestState(MANIFEST_URLS.dev);
    expect(result).toEqual({ status: "unavailable", reason: "invalid" });
  });

  // H2X-FL-08: 404 — not-found
  it("H2X-FL-08: resolves to not-found on HTTP 404", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 404 }));
    const result = await loadManifestState(MANIFEST_URLS.stable);
    expect(result).toEqual({ status: "unavailable", reason: "not-found" });
  });

  // H2X-FL-09: 500 — network
  it("H2X-FL-09: resolves to network on HTTP 500", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 500, ok: false }));
    const result = await loadManifestState(MANIFEST_URLS.stable);
    expect(result).toEqual({ status: "unavailable", reason: "network" });
  });

  // H2X-FL-14: 200 OK かつ本文が不正 JSON — invalid
  it("H2X-FL-14: resolves to invalid when the response body is not valid JSON", async () => {
    const malformedJsonResponse = {
      status: 200,
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token in JSON");
      },
    } as unknown as Response;
    fetchMock.mockResolvedValue(malformedJsonResponse);
    const result = await loadManifestState(MANIFEST_URLS.dev);
    expect(result).toEqual({ status: "unavailable", reason: "invalid" });
  });

  // H2X-FL-10: fetch reject — network
  it("H2X-FL-10: resolves to network when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await loadManifestState(MANIFEST_URLS.dev);
    expect(result).toEqual({ status: "unavailable", reason: "network" });
  });

  // H2X-FL-11: AbortError — 再 throw
  it("H2X-FL-11: rethrows AbortError instead of returning a state", async () => {
    const abortError = new DOMException("Aborted", "AbortError");
    fetchMock.mockRejectedValue(abortError);
    await expect(loadManifestState(MANIFEST_URLS.dev)).rejects.toBe(abortError);
  });

  // H2X-FL-12: credentials — omit で fetch
  it("H2X-FL-12: fetches with credentials: omit", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_MANIFEST));
    await loadManifestState(MANIFEST_URLS.dev);
    expect(fetchMock).toHaveBeenCalledWith(
      MANIFEST_URLS.dev,
      expect.objectContaining({ credentials: "omit" }),
    );
  });

  // H2X-FL-13: cache — no-cache で fetch
  it("H2X-FL-13: fetches with cache: no-cache", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_MANIFEST));
    await loadManifestState(MANIFEST_URLS.dev);
    expect(fetchMock).toHaveBeenCalledWith(
      MANIFEST_URLS.dev,
      expect.objectContaining({ cache: "no-cache" }),
    );
  });
});
