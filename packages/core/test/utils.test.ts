import { describe, expect, it } from "vitest";

import { isPlainObject, normalizeChangedPath, normalizePath } from "../src/utils.js";

describe("normalizePath", () => {
  it("replaces backslashes with forward slashes", () => {
    expect(normalizePath("src\\auth\\login.ts")).toBe("src/auth/login.ts");
  });

  it("strips leading ./" , () => {
    expect(normalizePath("./src/a.ts")).toBe("src/a.ts");
  });

  it("strips leading and trailing slashes", () => {
    expect(normalizePath("/src/a.ts/")).toBe("src/a.ts");
  });

  it("handles empty string", () => {
    expect(normalizePath("")).toBe("");
  });

  it("handles dot-relative paths with backslashes", () => {
    expect(normalizePath(".\\src\\a.ts")).toBe("src/a.ts");
  });

  it("preserves internal path segments", () => {
    expect(normalizePath("src/auth/deep/login.ts")).toBe("src/auth/deep/login.ts");
  });
});

describe("isPlainObject", () => {
  it("returns true for plain objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("returns false for null", () => {
    expect(isPlainObject(null)).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject([1, 2, 3])).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isPlainObject("string")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject(true)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe("normalizeChangedPath", () => {
  it("normalizes a simple relative path", () => {
    expect(normalizeChangedPath("/repo", "src/a.ts")).toBe("src/a.ts");
  });

  it("normalizes dot-relative paths", () => {
    expect(normalizeChangedPath("/repo", "./src/a.ts")).toBe("src/a.ts");
  });

  it("throws when path escapes the source root", () => {
    expect(() => normalizeChangedPath("/repo", "../escape.ts")).toThrow(/must stay within/u);
  });

  it("throws for absolute paths outside root", () => {
    expect(() => normalizeChangedPath("/repo", "/etc/passwd")).toThrow(/must stay within/u);
  });

  it("normalizes parent directory references that stay within root", () => {
    expect(normalizeChangedPath("/repo", "src/../src/a.ts")).toBe("src/a.ts");
  });

  it("throws for paths that resolve to the parent of source root via multiple segments", () => {
    expect(() => normalizeChangedPath("/repo", "a/../../escape.ts")).toThrow(/must stay within/u);
  });
});

describe("normalizePath edge cases", () => {
  it("preserves a lone dot segment", () => {
    expect(normalizePath(".")).toBe(".");
  });

  it("handles path with multiple consecutive slashes", () => {
    expect(normalizePath("src//auth///login.ts")).toBe("src/auth/login.ts");
  });
});

describe("isPlainObject edge cases", () => {
  it("returns false for Date instances", () => {
    expect(isPlainObject(new Date())).toBe(false);
  });

  it("returns false for RegExp instances", () => {
    expect(isPlainObject(/test/)).toBe(false);
  });

  it("returns false for null prototype objects created with Object.create(null)", () => {
    expect(isPlainObject(Object.create(null))).toBe(true);
  });
});
