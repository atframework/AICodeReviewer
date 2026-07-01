import { describe, expect, it } from "vitest";

import { filterFilesByPatterns, filterFilesByWatchPath } from "../src/path-filters.js";

describe("glob contract — pins example/config.yaml §Glob syntax", () => {
	describe("**/*.cpp matches any depth", () => {
		const files = ["foo.cpp", "src/foo.cpp", "a/b/c/foo.cpp", "foo.h", "foo.cc", "Makefile"];

		it("keeps foo.cpp, src/foo.cpp, a/b/c/foo.cpp", () => {
			expect(filterFilesByPatterns(files, ["**/*.cpp"], undefined)).toEqual([
				"foo.cpp",
				"src/foo.cpp",
				"a/b/c/foo.cpp",
			]);
		});

		it("drops non-cpp files and wrong extensions", () => {
			const kept = filterFilesByPatterns(files, ["**/*.cpp"], undefined);
			expect(kept).not.toContain("foo.h");
			expect(kept).not.toContain("foo.cc");
			expect(kept).not.toContain("Makefile");
		});
	});

	describe("*.md matches file basenames at any depth", () => {
		const files = ["readme.md", "docs/readme.md", "a/b/c/notes.md", "readme.txt", "readme.md.bak"];

		it("keeps readme.md and docs/readme.md via basename matching", () => {
			expect(filterFilesByPatterns(files, ["*.md"], undefined)).toEqual([
				"readme.md",
				"docs/readme.md",
				"a/b/c/notes.md",
			]);
		});

		it("does not match unrelated extensions", () => {
			const kept = filterFilesByPatterns(files, ["*.md"], undefined);
			expect(kept).not.toContain("readme.txt");
			expect(kept).not.toContain("readme.md.bak");
		});
	});

	describe("src/** matches everything under src/", () => {
		const files = ["src/a.ts", "src/sub/b.ts", "src/sub/deep/c.ts", "tests/a.ts", "src"];

		it("keeps everything under src/ but not src itself or sibling dirs", () => {
			expect(filterFilesByPatterns(files, ["src/**"], undefined)).toEqual([
				"src/a.ts",
				"src/sub/b.ts",
				"src/sub/deep/c.ts",
			]);
		});
	});

	describe("**/*.pb.* matches protobuf-generated extensions", () => {
		const files = ["foo.pb.h", "foo.pb.cc", "gen/bar.pb.h", "foo.h", "foo.pb", "foo.cpp"];

		it("keeps foo.pb.h, foo.pb.cc, gen/bar.pb.h", () => {
			expect(filterFilesByPatterns(files, ["**/*.pb.*"], undefined)).toEqual([
				"foo.pb.h",
				"foo.pb.cc",
				"gen/bar.pb.h",
			]);
		});
	});

	describe("? matches exactly one path segment character", () => {
		it("matches a single character within a segment", () => {
			const files = ["abc.ts", "ac.ts", "abbc.ts"];
			expect(filterFilesByPatterns(files, ["a?c.ts"], undefined)).toEqual(["abc.ts"]);
		});

		it("does not cross path separators", () => {
			const files = ["a/b.ts", "axb.ts"];
			expect(filterFilesByPatterns(files, ["a?b.ts"], undefined)).toEqual(["axb.ts"]);
		});
	});

	describe("unicode / CJK basenames", () => {
		it("matches a CJK basename pattern", () => {
			const files = ["说明.md", "docs/说明.md", "readme.md"];
			expect(filterFilesByPatterns(files, ["*.md"], undefined)).toEqual([
				"说明.md",
				"docs/说明.md",
				"readme.md",
			]);
		});
	});

	describe("basename-with-extension patterns require the literal middle segment", () => {
		it("**/*.gen.cpp matches main.gen.cpp but not the bare name gen.cpp", () => {
			const files = ["src/main.gen.cpp", "src/gen.cpp", "main.gen.cpp", "gen.cpp"];
			expect(filterFilesByPatterns(files, ["**/*.gen.cpp"], undefined)).toEqual([
				"src/main.gen.cpp",
				"main.gen.cpp",
			]);
		});
	});
});

describe("filterFilesByPatterns — include / exclude precedence", () => {
	const files = ["src/main.cpp", "src/main.gen.cpp", "include/main.h", "src/main.h"];

	it("requires a file to match at least one include pattern", () => {
		expect(filterFilesByPatterns(files, ["**/*.cpp"], undefined)).toEqual([
			"src/main.cpp",
			"src/main.gen.cpp",
		]);
	});

	it("exclude takes priority over include", () => {
		expect(filterFilesByPatterns(files, ["**/*.cpp", "**/*.h"], ["**/*.gen.cpp"])).toEqual([
			"src/main.cpp",
			"include/main.h",
			"src/main.h",
		]);
	});

	it("multiple exclude patterns each remove their matches", () => {
		expect(
			filterFilesByPatterns(files, ["**/*.cpp", "**/*.h"], ["**/*.gen.cpp", "**/main.h"]),
		).toEqual(["src/main.cpp"]);
	});

	it("returns all files when neither include nor exclude is provided", () => {
		expect(filterFilesByPatterns(files, undefined, undefined)).toEqual(files);
	});

	it("returns all files when include/exclude are empty arrays", () => {
		expect(filterFilesByPatterns(files, [], [])).toEqual(files);
	});

	it("preserves original order of the surviving files", () => {
		const ordered = ["z.cpp", "a.cpp", "m.cpp"];
		expect(filterFilesByPatterns(ordered, ["**/*.cpp"], undefined)).toEqual(ordered);
	});
});

describe("filterFilesByWatchPath", () => {
	it("returns all files when watch path is undefined", () => {
		const files = ["src/a.ts", "tests/b.ts"];
		expect(filterFilesByWatchPath(files, undefined)).toEqual(files);
	});

	it("returns all files when watch path is empty", () => {
		const files = ["src/a.ts", "tests/b.ts"];
		expect(filterFilesByWatchPath(files, [])).toEqual(files);
	});

	it("keeps files exactly equal to a watch path and files under it", () => {
		const files = ["src", "src/a.ts", "src/sub/b.ts", "tests/b.ts"];
		expect(filterFilesByWatchPath(files, ["src"])).toEqual(["src", "src/a.ts", "src/sub/b.ts"]);
	});

	it("does not match sibling directories that only share a prefix string", () => {
		const files = ["src/a.ts", "src-other/c.ts", "srcalias/d.ts"];
		expect(filterFilesByWatchPath(files, ["src"])).toEqual(["src/a.ts"]);
	});

	it("supports multiple watch paths", () => {
		const files = ["src/a.ts", "lib/b.ts", "tests/c.ts"];
		expect(filterFilesByWatchPath(files, ["src", "lib"])).toEqual(["src/a.ts", "lib/b.ts"]);
	});
});
