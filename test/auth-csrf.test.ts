import { describe, expect, it } from "vitest";
import { checkCsrf, verifyCsrf } from "../src/auth/csrf";

const EXPECTED_ORIGIN = "https://xtc.hr20k.com";

describe("checkCsrf", () => {
  it("accepts a same-origin JSON request", () => {
    expect(
      checkCsrf(
        { origin: EXPECTED_ORIGIN, secFetchSite: "same-origin", contentType: "application/json" },
        EXPECTED_ORIGIN,
      ),
    ).toEqual({ ok: true });
  });

  it("accepts a JSON content-type with a charset suffix", () => {
    expect(
      checkCsrf(
        {
          origin: EXPECTED_ORIGIN,
          secFetchSite: "same-origin",
          contentType: "application/json; charset=utf-8",
        },
        EXPECTED_ORIGIN,
      ).ok,
    ).toBe(true);
  });

  it("accepts a missing Sec-Fetch-Site (older clients that don't send it)", () => {
    expect(
      checkCsrf(
        { origin: EXPECTED_ORIGIN, secFetchSite: null, contentType: "application/json" },
        EXPECTED_ORIGIN,
      ).ok,
    ).toBe(true);
  });

  it("rejects a cross-site Sec-Fetch-Site", () => {
    const result = checkCsrf(
      { origin: EXPECTED_ORIGIN, secFetchSite: "cross-site", contentType: "application/json" },
      EXPECTED_ORIGIN,
    );
    expect(result).toEqual({ ok: false, reason: "unexpected Sec-Fetch-Site" });
  });

  it("rejects a same-site (but not same-origin) Sec-Fetch-Site", () => {
    expect(
      checkCsrf(
        { origin: EXPECTED_ORIGIN, secFetchSite: "same-site", contentType: "application/json" },
        EXPECTED_ORIGIN,
      ).ok,
    ).toBe(false);
  });

  it("rejects a missing Origin header", () => {
    expect(
      checkCsrf(
        { origin: null, secFetchSite: "same-origin", contentType: "application/json" },
        EXPECTED_ORIGIN,
      ),
    ).toEqual({ ok: false, reason: "missing Origin header" });
  });

  it("rejects an Origin that doesn't match WEBAUTHN_ORIGIN", () => {
    expect(
      checkCsrf(
        {
          origin: "https://evil.example.com",
          secFetchSite: "same-origin",
          contentType: "application/json",
        },
        EXPECTED_ORIGIN,
      ),
    ).toEqual({ ok: false, reason: "Origin mismatch" });
  });

  it("rejects a non-JSON Content-Type", () => {
    expect(
      checkCsrf(
        {
          origin: EXPECTED_ORIGIN,
          secFetchSite: "same-origin",
          contentType: "text/plain",
        },
        EXPECTED_ORIGIN,
      ),
    ).toEqual({ ok: false, reason: "Content-Type must be application/json" });
  });

  it("rejects a missing Content-Type", () => {
    expect(
      checkCsrf(
        { origin: EXPECTED_ORIGIN, secFetchSite: "same-origin", contentType: null },
        EXPECTED_ORIGIN,
      ).ok,
    ).toBe(false);
  });
});

describe("verifyCsrf", () => {
  it("passes a well-formed same-origin JSON request", () => {
    const request = new Request("https://xtc.hr20k.com/api/library/items/from-job", {
      method: "POST",
      headers: {
        Origin: EXPECTED_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
    });
    expect(verifyCsrf(request, { WEBAUTHN_ORIGIN: EXPECTED_ORIGIN })).toEqual({ ok: true });
  });

  it("fails closed when WEBAUTHN_ORIGIN is not configured", () => {
    const request = new Request("https://xtc.hr20k.com/api/library/items/from-job", {
      method: "POST",
      headers: { Origin: EXPECTED_ORIGIN, "Content-Type": "application/json" },
    });
    expect(verifyCsrf(request, {}).ok).toBe(false);
  });

  it("rejects a forged cross-origin request", () => {
    const request = new Request("https://xtc.hr20k.com/api/library/items/from-job", {
      method: "POST",
      headers: {
        Origin: "https://evil.example.com",
        "Sec-Fetch-Site": "cross-site",
        "Content-Type": "application/json",
      },
    });
    expect(verifyCsrf(request, { WEBAUTHN_ORIGIN: EXPECTED_ORIGIN }).ok).toBe(false);
  });
});
