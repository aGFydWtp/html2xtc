import { describe, expect, it } from "vitest";
import { libraryItemKey } from "../src/library/storage";

describe("libraryItemKey", () => {
  it("builds the account-scoped, per-item R2 key", () => {
    expect(libraryItemKey("acct-1", "item-1")).toBe(
      "library/accounts/acct-1/items/item-1/book.xtc",
    );
  });

  it("keeps distinct accounts under distinct prefixes", () => {
    const a = libraryItemKey("acct-a", "item-1");
    const b = libraryItemKey("acct-b", "item-1");
    expect(a).not.toBe(b);
    expect(a.startsWith("library/accounts/acct-a/")).toBe(true);
    expect(b.startsWith("library/accounts/acct-b/")).toBe(true);
  });

  it("lives under library/, distinct from the auto-expiring jobs/ and intermediate/ prefixes", () => {
    const key = libraryItemKey("acct-1", "item-1");
    expect(key.startsWith("library/")).toBe(true);
    expect(key.startsWith("jobs/")).toBe(false);
    expect(key.startsWith("intermediate/")).toBe(false);
  });
});
