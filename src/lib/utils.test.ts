import { describe, expect, test } from "bun:test";
import { expiryValue, sizeLabel } from "./utils";
import { createSHA256 } from "hash-wasm";
describe("file metadata helpers", () => {
  test("expiry absolute timestamps", () => {
    expect(expiryValue("forever", "", 1000000)).toBe(0);
    expect(expiryValue("3600", "", 1000000)).toBe(4600);
    expect(() => expiryValue("custom", "invalid")).toThrow();
    expect(() => expiryValue("custom", "2020-01-01T00:00")).toThrow();
  });
  test("file size display", () => {
    expect(sizeLabel(0)).toBe("0 B");
    expect(sizeLabel(1024)).toBe("1.0 KiB");
  });
  test("incremental SHA-256", async () => {
    const hash = await createSHA256();
    hash.init();
    hash.update("hel");
    hash.update("lo");
    expect(hash.digest("hex")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
