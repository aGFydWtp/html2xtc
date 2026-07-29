// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { normalizeDeclaredDevice } from "../src/devices/declared-device";

/**
 * Pure normalization of the deviceModel/width/height a Xteink device
 * self-reports on POST /api/device-pairings (migrations/app/0006_pairing_
 * declared_device.sql). Every case here must degrade to null rather than
 * throw — this feeds an unauthenticated, fail-soft pairing-start path.
 */

describe("normalizeDeclaredDevice", () => {
  it("accepts a well-formed x3 declaration", () => {
    expect(normalizeDeclaredDevice({ deviceModel: "x3", width: 528, height: 792 })).toEqual({
      device: "x3",
      width: 528,
      height: 792,
    });
  });

  it("accepts a well-formed x4 declaration", () => {
    expect(normalizeDeclaredDevice({ deviceModel: "x4", width: 480, height: 800 })).toEqual({
      device: "x4",
      width: 480,
      height: 800,
    });
  });

  it("legacy firmware sending nothing normalizes to all-null (non-regression)", () => {
    expect(normalizeDeclaredDevice({})).toEqual({ device: null, width: null, height: null });
  });

  it("an unknown/future deviceModel nulls the device but keeps a valid resolution", () => {
    expect(normalizeDeclaredDevice({ deviceModel: "x9", width: 600, height: 900 })).toEqual({
      device: null,
      width: 600,
      height: 900,
    });
  });

  it("a wrong-typed deviceModel (number) nulls the device", () => {
    expect(normalizeDeclaredDevice({ deviceModel: 3 })).toEqual({ device: null, width: null, height: null });
  });

  it("width without height nulls both (a lone dimension can't be compared)", () => {
    expect(normalizeDeclaredDevice({ deviceModel: "x3", width: 528 })).toEqual({
      device: "x3",
      width: null,
      height: null,
    });
  });

  it("height without width nulls both", () => {
    expect(normalizeDeclaredDevice({ deviceModel: "x3", height: 792 })).toEqual({
      device: "x3",
      width: null,
      height: null,
    });
  });

  it("a negative dimension nulls both", () => {
    expect(normalizeDeclaredDevice({ width: -528, height: 792 })).toEqual({
      device: null,
      width: null,
      height: null,
    });
  });

  it("a non-integer dimension nulls both", () => {
    expect(normalizeDeclaredDevice({ width: 528.5, height: 792 })).toEqual({
      device: null,
      width: null,
      height: null,
    });
  });

  it("a zero dimension nulls both", () => {
    expect(normalizeDeclaredDevice({ width: 0, height: 792 })).toEqual({
      device: null,
      width: null,
      height: null,
    });
  });

  it("an implausibly large dimension nulls both", () => {
    expect(normalizeDeclaredDevice({ width: 528, height: 1_000_000 })).toEqual({
      device: null,
      width: null,
      height: null,
    });
  });

  it("a wrong-typed dimension (string) nulls both", () => {
    expect(normalizeDeclaredDevice({ width: "528", height: 792 })).toEqual({
      device: null,
      width: null,
      height: null,
    });
  });

  it("NaN dimensions null both", () => {
    expect(normalizeDeclaredDevice({ width: Number.NaN, height: 792 })).toEqual({
      device: null,
      width: null,
      height: null,
    });
  });

  it("Infinity / -Infinity dimensions null both", () => {
    expect(normalizeDeclaredDevice({ width: Number.POSITIVE_INFINITY, height: 792 })).toEqual({
      device: null,
      width: null,
      height: null,
    });
    expect(normalizeDeclaredDevice({ width: 528, height: Number.NEGATIVE_INFINITY })).toEqual({
      device: null,
      width: null,
      height: null,
    });
  });

  it("an uppercase deviceModel (\"X3\"/\"X4\") is not a case-insensitive match — nulls the device", () => {
    expect(normalizeDeclaredDevice({ deviceModel: "X3", width: 528, height: 792 })).toEqual({
      device: null,
      width: 528,
      height: 792,
    });
    expect(normalizeDeclaredDevice({ deviceModel: "X4", width: 480, height: 800 })).toEqual({
      device: null,
      width: 480,
      height: 800,
    });
  });

  it("a deviceModel with surrounding whitespace is not trimmed — nulls the device", () => {
    expect(normalizeDeclaredDevice({ deviceModel: " x3 ", width: 528, height: 792 })).toEqual({
      device: null,
      width: 528,
      height: 792,
    });
  });

  it("a prototype-pollution-shaped payload doesn't leak an inherited deviceModel — JSON.parse never sets the real prototype, so the parsed object has no own deviceModel and normalizes to all-null", () => {
    const polluted = JSON.parse('{"__proto__":{"deviceModel":"x3"}}');
    expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);
    expect(normalizeDeclaredDevice(polluted)).toEqual({ device: null, width: null, height: null });
  });
});
