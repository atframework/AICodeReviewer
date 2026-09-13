import { describe, expect, it, vi } from "vitest";
import { createReviewContextFetcher } from "../src/review-policy.js";

describe("review context budget", () => {
  it("checks allow paths and traversal before VCS reads", async () => {
    const read = vi.fn(async () => "code");
    const fetch = createReviewContextFetcher({ allow_paths: ["src/**"] }, read);
    for (const path of ["../src/a", "src/../../secret", "src\\..\\secret", "/src/a", "C:\\src\\a", "private/a"]) {
      await expect(fetch(path)).rejects.toThrow();
    }
    expect(read).not.toHaveBeenCalled();
    expect(await fetch("src\\a.ts", 2, 3)).toBe("code");
    expect(read).toHaveBeenCalledWith("src/a.ts", 2, 3);
  });
  it("counts distinct files and total UTF-8 bytes across repeated reads", async () => {
    const fetch = createReviewContextFetcher({ max_files: 1, max_bytes: 6 }, async () => "中");
    expect(await fetch("a.ts")).toBe("中");
    await expect(fetch("b.ts")).rejects.toThrow("max_files");
    expect(await fetch("a.ts", 2, 2)).toBe("中");
    await expect(fetch("a.ts")).rejects.toThrow("max_bytes");
  });
  it("does not leak an oversized response or let concurrent calls overspend", async () => {
    const read = vi.fn(async () => "中文");
    const fetch = createReviewContextFetcher({ max_bytes: 5 }, read);
    const result = await Promise.allSettled([fetch("a"), fetch("b")]);
    expect(result.map(r => r.status)).toEqual(["rejected", "rejected"]);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("keeps independent task budgets and recovers the serial queue after a failed read", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("missing")).mockResolvedValue("ok");
    const fetch = createReviewContextFetcher({ max_files: 1 }, read);
    await expect(fetch("a")).rejects.toThrow("missing");
    expect(await fetch("a")).toBe("ok");
    await expect(fetch("b")).rejects.toThrow("max_files");
    expect(await createReviewContextFetcher({ max_files: 1 }, read)("b")).toBe("ok");
  });
});
