// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { outputXtcKey } from "../src/jobs";
import { storeXtcOutput } from "../src/pipeline";

const JOB_ID = "0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f";

class FakeR2Bucket {
  puts: Array<{ key: string; options?: R2PutOptions }> = [];
  async put(key: string, _value: unknown, options?: R2PutOptions): Promise<void> {
    this.puts.push({ key, options });
  }
}

function fakeConverterResponse(bytes: number[], title?: string): Response {
  return new Response(new Uint8Array(bytes).buffer, {
    status: 200,
    headers: title !== undefined ? { "X-Xtc-Title": encodeURIComponent(title) } : {},
  });
}

describe("storeXtcOutput — device/width/height metadata", () => {
  it("writes device=x3, width=528, height=792 for an X3 conversion", async () => {
    const bucket = new FakeR2Bucket();
    await storeXtcOutput({ XTC_BUCKET: bucket as unknown as R2Bucket }, JOB_ID, fakeConverterResponse([1, 2, 3]), "x3");

    const put = bucket.puts.find((p) => p.key === outputXtcKey(JOB_ID));
    expect(put?.options?.customMetadata).toMatchObject({ device: "x3", width: "528", height: "792" });
  });

  it("writes device=x4, width=480, height=800 for an X4 conversion", async () => {
    const bucket = new FakeR2Bucket();
    await storeXtcOutput({ XTC_BUCKET: bucket as unknown as R2Bucket }, JOB_ID, fakeConverterResponse([1, 2, 3]), "x4");

    const put = bucket.puts.find((p) => p.key === outputXtcKey(JOB_ID));
    expect(put?.options?.customMetadata).toMatchObject({ device: "x4", width: "480", height: "800" });
  });

  it("keeps writing the title alongside device metadata when present", async () => {
    const bucket = new FakeR2Bucket();
    await storeXtcOutput(
      { XTC_BUCKET: bucket as unknown as R2Bucket },
      JOB_ID,
      fakeConverterResponse([1, 2, 3], "My Book"),
      "x4",
    );

    const put = bucket.puts.find((p) => p.key === outputXtcKey(JOB_ID));
    expect(put?.options?.customMetadata).toMatchObject({
      title: "My Book",
      device: "x4",
      width: "480",
      height: "800",
    });
  });
});
