// SPDX-License-Identifier: AGPL-3.0-or-later
// CrossPoint JP ファームウェア更新機能（実装仕様書 §8〜10）。
// manifest / バイナリは flasher.xtc.hr20k.com から取得する。html2xtc の Worker/R2 は中継しない。

export type FirmwareChannel = "dev" | "stable";

export const FLASHER_BASE_URL = "https://flasher.xtc.hr20k.com";

export const MANIFEST_URLS = {
  dev: `${FLASHER_BASE_URL}/manifest_dev.json`,
  stable: `${FLASHER_BASE_URL}/manifest_stable.json`,
} as const;

// 画面で利用する最小限の型のみを定義する。ESP Web Tools へは取得した JSON を
// 再構築せず manifest URL をそのまま渡す（実装仕様書 §8.2）。
export interface FirmwareManifest {
  name?: string;
  version?: string;
  builds?: Array<{
    chipFamily?: string;
    parts?: Array<{
      path?: string;
      offset?: number;
    }>;
  }>;
}

export type ManifestState =
  | { status: "loading" }
  | {
      status: "available";
      version: string;
      manifestUrl: string;
    }
  | {
      status: "unavailable";
      reason: "not-found" | "network" | "invalid";
    };

const REQUIRED_CHIP_FAMILY = "ESP32-C3";
const REQUIRED_OFFSETS = [0, 32768, 65536];

// バージョン表示と誤 manifest 防止のための最小検証（実装仕様書 §10.2）。
// 実際のインストール可否の最終判定は ESP Web Tools へ委ねる。
export function isFirmwareManifest(value: unknown): value is FirmwareManifest & { version: string } {
  if (typeof value !== "object" || value === null) return false;

  const manifest = value as Record<string, unknown>;

  if (typeof manifest.version !== "string" || manifest.version.length === 0) return false;
  if (!Array.isArray(manifest.builds) || manifest.builds.length === 0) return false;

  const hasValidBuild = manifest.builds.some((build) => {
    if (typeof build !== "object" || build === null) return false;
    const b = build as Record<string, unknown>;
    if (b.chipFamily !== REQUIRED_CHIP_FAMILY) return false;
    if (!Array.isArray(b.parts) || b.parts.length < 3) return false;

    const offsets = new Set(
      b.parts
        .filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
        .map((part) => part.offset),
    );

    return REQUIRED_OFFSETS.every((offset) => offsets.has(offset));
  });

  return hasValidBuild;
}

export async function loadManifestState(manifestUrl: string, signal?: AbortSignal): Promise<ManifestState> {
  try {
    const response = await fetch(manifestUrl, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-cache",
      signal,
    });

    if (response.status === 404) {
      return {
        status: "unavailable",
        reason: "not-found",
      };
    }

    if (!response.ok) {
      return {
        status: "unavailable",
        reason: "network",
      };
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      // JSON parse 失敗は配信側の形式不正であり、通信エラーとは区別する
      // （実装仕様書 §14.1: JSON parse失敗 → invalid）。AbortError はここでは
      // 発生しないが、念のため再 throw して外側の catch に委ねる。
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }

      return {
        status: "unavailable",
        reason: "invalid",
      };
    }

    if (!isFirmwareManifest(value)) {
      return {
        status: "unavailable",
        reason: "invalid",
      };
    }

    return {
      status: "available",
      version: value.version,
      manifestUrl,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    return {
      status: "unavailable",
      reason: "network",
    };
  }
}
