import { mkdtempSync, rmSync, writeFileSync, renameSync, utimesSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemberDirectoryService, type DirectoryWatcherHandle } from "../src/im/member-directory-service.js";

/**
 * IM-07 acceptance D05–D10: baseDir/allowed_root resolution, parent-directory
 * watch with debounce and max-wait, periodic content digests that survive
 * missed events and identical mtimes, single-flight reloads, watcher failure
 * fallback, lifecycle refcounting without leaks, and last-good semantics that
 * never serve stale identities.
 */

const directoryYaml = (id: string, members: readonly string[]) => `version: 1
directories:
  ${id}:
    platform: wecom
    identity_scope: { kind: wecom_corp, id: ww_example }
    members: ${members.length === 0 ? "[]" : ""}
${members.map(member => `      - { key: ${member}, mention: { type: wecom_userid, id: ${member} } }`).join("\n")}
`;

class ManualClock {
	public now = 0;
	private nextId = 0;
	private tasks: { at: number; fn: () => void; id: number }[] = [];
	public readonly scheduler = {
		set: (fn: () => void, ms: number): unknown => {
			const id = this.nextId++;
			this.tasks.push({ at: this.now + ms, fn, id });
			return id;
		},
		clear: (handle: unknown): void => {
			this.tasks = this.tasks.filter(task => task.id !== handle);
		},
	};

	public pending(): number {
		return this.tasks.length;
	}

	public advance(ms: number): void {
		const target = this.now + ms;
		for (;;) {
			const due = this.tasks.filter(task => task.at <= target).sort((left, right) => left.at - right.at)[0];
			if (due === undefined) break;
			this.now = due.at;
			this.tasks = this.tasks.filter(task => task.id !== due.id);
			due.fn();
		}
		this.now = target;
	}
}

class FakeFs {
	public files = new Map<string, { content: Buffer; mtimeMs: number; size: number }>();
	public realpaths = new Map<string, string>();
	private clock = 1;

	public write(path: string, content: string, options: { keepStamp?: boolean } = {}): void {
		const existing = this.files.get(path);
		const stamp = options.keepStamp && existing ? existing.mtimeMs : this.clock++;
		this.files.set(path, { content: Buffer.from(content, "utf8"), mtimeMs: stamp, size: Buffer.byteLength(content, "utf8") });
	}

	public remove(path: string): void {
		this.files.delete(path);
	}

	public readonly readFile = async (path: string): Promise<Buffer> => {
		const entry = this.files.get(path);
		if (entry === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
		// Simulate mid-write truncation once when requested.
		if (this.truncateNextRead) {
			this.truncateNextRead = false;
			// A mid-write reader observes truncated bytes AND a moved mtime.
			entry.mtimeMs += 1;
			return entry.content.subarray(0, Math.floor(entry.content.length / 2));
		}
		return entry.content;
	};
	public truncateNextRead = false;

	public readonly stat = async (path: string) => {
		const entry = this.files.get(path);
		if (entry === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
		return { size: entry.content.byteLength, mtimeMs: entry.mtimeMs };
	};

	public readonly realpath = async (path: string): Promise<string> => this.realpaths.get(path) ?? path;
}

class FakeWatcherHub {
	public watchers: { dir: string; onEvent: (filename: string | null) => void; onError: () => void; closed: boolean }[] = [];
	public readonly factory = (dir: string, onEvent: (filename: string | null) => void, onError: () => void): DirectoryWatcherHandle => {
		const watcher = { dir, onEvent, onError, closed: false, close: () => {
			watcher.closed = true;
		} };
		this.watchers.push(watcher);
		return watcher;
	};

	public emit(dir: string, filename: string | null): void {
		for (const watcher of this.watchers) {
			if (!watcher.closed && watcher.dir === dir.replace(/\/$/u, "")) watcher.onEvent(filename);
		}
	}

	public fail(dir: string): void {
		for (const watcher of [...this.watchers]) {
			if (!watcher.closed && watcher.dir === dir.replace(/\/$/u, "")) watcher.onError();
		}
	}

	public openCount(): number {
		return this.watchers.filter(watcher => !watcher.closed).length;
	}
}

interface Harness {
	service: MemberDirectoryService;
	fs: FakeFs;
	hub: FakeWatcherHub;
	clock: ManualClock;
	baseDir: string;
}

function harness(fileContent?: string): Harness {
	const fs = new FakeFs();
	const hub = new FakeWatcherHub();
	const clock = new ManualClock();
	const baseDir = resolve("/srv/aicr");
	if (fileContent !== undefined) fs.write(join(baseDir, "private", "members.yaml"), fileContent);
	const service = new MemberDirectoryService({
		readFile: fs.readFile,
		stat: fs.stat,
		realpath: fs.realpath,
		watchFactory: hub.factory,
		scheduler: clock.scheduler,
		now: () => clock.now,
	});
	return { service, fs, hub, clock, baseDir };
}

const acquireDefaults = {
	path: "private/members.yaml",
	directoryId: "engineering-wecom",
	identityScope: { kind: "wecom_corp", id: "ww_example" },
	debounceMs: 300,
	pollIntervalSeconds: 30,
};

const filePath = (h: Harness) => join(h.baseDir, "private", "members.yaml");
const parentDir = (h: Harness) => join(h.baseDir, "private");

afterEach(() => {
	// harnesses hold no real handles
});

describe("D05: baseDir resolution and allowed_root boundary", () => {
	it("rejects direct absolute and parent-relative paths outside allowed_root", async () => {
		const h = harness();
		const outside = resolve(h.baseDir, "../outside/members.yaml");
		h.fs.write(outside, directoryYaml("engineering-wecom", ["alice"]));
		for (const path of [outside, "../outside/members.yaml"]) {
			const view = await h.service.acquire({ ...acquireDefaults, baseDir: h.baseDir, path });
			expect(view.getSnapshot()).toMatchObject({ status: "unavailable", errorCode: "path_outside_allowed_root" });
			await view.release();
		}
	});

	it("keeps readers with different allowed roots separate", async () => {
		const h = harness(directoryYaml("engineering-wecom", ["alice"]));
		const broad = await h.service.acquire({ ...acquireDefaults, baseDir: h.baseDir });
		const restricted = await h.service.acquire({
			...acquireDefaults, baseDir: h.baseDir, allowedRoot: "private/allowed",
		});
		expect(broad.getSnapshot()).toMatchObject({ status: "ready", members: [{ key: "alice" }] });
		expect(restricted.getSnapshot()).toMatchObject({ status: "unavailable", errorCode: "path_outside_allowed_root" });
		await restricted.release();
		await broad.release();
	});

	it("resolves relative paths against baseDir and honors symlink boundaries per read", async () => {
		const h = harness(directoryYaml("engineering-wecom", ["alice"]));
		const view = await h.service.acquire({ ...acquireDefaults, baseDir: h.baseDir });
		expect(view.getSnapshot()).toMatchObject({ status: "ready", members: [{ key: "alice" }] });

		// Redirect the file outside the trusted root: the next reload degrades.
		h.fs.realpaths.set(filePath(h), resolve("/elsewhere/members.yaml"));
		h.hub.emit(parentDir(h), "members.yaml");
		h.clock.advance(300);
		await new Promise(resolve => setImmediate(resolve));
		expect(view.getSnapshot()).toMatchObject({ status: "unavailable", errorCode: "path_outside_allowed_root" });

		// Restoring the target inside an explicit allowed_root recovers.
		const linked = join(h.baseDir, "linked", "members.yaml");
		h.fs.write(linked, directoryYaml("engineering-wecom", ["alice"]));
		h.fs.realpaths.set(filePath(h), linked);
		h.hub.emit(parentDir(h), "members.yaml");
		h.clock.advance(300);
		await new Promise(resolve => setImmediate(resolve));
		expect(view.getSnapshot().status).toBe("ready");
		await view.release();
	});
});

describe("D06: watch events, debounce and bounded rereads", () => {
	it("installs a new immutable snapshot after the debounce window", async () => {
		const h = harness(directoryYaml("engineering-wecom", ["alice"]));
		const view = await h.service.acquire({ ...acquireDefaults, baseDir: h.baseDir });
		expect(view.getSnapshot().generation).toBe(1);

		h.fs.write(filePath(h), directoryYaml("engineering-wecom", ["alice", "bob"]));
		h.hub.emit(parentDir(h), "members.yaml");
		// During the debounce the file is dirty: no stale identity served.
		expect(view.getSnapshot().status).toBe("dirty");
		h.clock.advance(299);
		expect(view.getSnapshot().status).toBe("dirty");
		h.clock.advance(1);
		await new Promise(resolve => setImmediate(resolve));
		expect(view.getSnapshot()).toMatchObject({ status: "ready", generation: 2, members: [{ key: "alice" }, { key: "bob" }] });
		await view.release();
	});

	it("retries mid-write truncation with bounded attempts", async () => {
		const h = harness(directoryYaml("engineering-wecom", ["alice"]));
		const view = await h.service.acquire({ ...acquireDefaults, baseDir: h.baseDir });
		h.fs.truncateNextRead = true;
		h.fs.write(filePath(h), directoryYaml("engineering-wecom", ["bob"]));
		h.hub.emit(parentDir(h), "members.yaml");
		h.clock.advance(300);
		await new Promise(resolve => setImmediate(resolve));
		// The truncated read failed validation; the retry read the full file.
		expect(view.getSnapshot()).toMatchObject({ status: "ready", members: [{ key: "bob" }] });
		await view.release();
	});
});

describe("D07: missed events, absent filenames and digest-only changes", () => {
	it("discovers content changes through the periodic digest without any watch event", async () => {
		const h = harness(directoryYaml("engineering-wecom", ["alice"]));
		const view = await h.service.acquire({ ...acquireDefaults, baseDir: h.baseDir });
		h.fs.write(filePath(h), directoryYaml("engineering-wecom", ["carol"]));
		h.clock.advance(30_300);
		await new Promise(resolve => setImmediate(resolve));
		expect(view.getSnapshot()).toMatchObject({ status: "ready", members: [{ key: "carol" }] });
		await view.release();
	});

	it("handles events without filenames and ignores sibling files", async () => {
		const h = harness(directoryYaml("engineering-wecom", ["alice"]));
		const view = await h.service.acquire({ ...acquireDefaults, baseDir: h.baseDir });
		h.hub.emit(parentDir(h), null);
		h.clock.advance(300);
		await new Promise(resolve => setImmediate(resolve));
		expect(view.getSnapshot().generation).toBe(1); // same digest, no bump

		h.fs.write(filePath(h), directoryYaml("engineering-wecom", ["dave"]));
		h.hub.emit(parentDir(h), "unrelated.txt");
		h.clock.advance(30_300);
		await new Promise(resolve => setImmediate(resolve));
		// Poll found the change even though only the sibling event arrived.
		expect(view.getSnapshot()).toMatchObject({ members: [{ key: "dave" }] });
		await view.release();
	});

	it("catches same mtime and size replacements through content digests", async () => {
		const h = harness(directoryYaml("engineering-wecom", ["alice"]));
		const view = await h.service.acquire({ ...acquireDefaults, baseDir: h.baseDir });
		// Same byte length and identical timestamp, different person.
		h.fs.write(filePath(h), directoryYaml("engineering-wecom", ["bob1"]), { keepStamp: false });
		const before = h.fs.files.get(filePath(h))!;
		h.fs.write(filePath(h), directoryYaml("engineering-wecom", ["bob2"]), { keepStamp: true });
		expect(h.fs.files.get(filePath(h))!.mtimeMs).toBe(before.mtimeMs);
		h.clock.advance(30_300);
		await new Promise(resolve => setImmediate(resolve));
		expect(view.getSnapshot()).toMatchObject({ members: [{ key: "bob2" }] });
		await view.release();
	});
});

describe("D08: watcher failures keep polling with bounded reattach", () => {
	it("degrades to polling and reattaches the watcher with backoff", async () => {
		const h = harness(directoryYaml("engineering-wecom", ["alice"]));
		const view = await h.service.acquire({ ...acquireDefaults, baseDir: h.baseDir });
		expect(view.health().watchAttached).toBe(true);

		h.hub.fail(parentDir(h));
		expect(view.health().watchAttached).toBe(false);

		// Polling still reloads while the watcher is down.
		h.fs.write(filePath(h), directoryYaml("engineering-wecom", ["erin"]));
		h.clock.advance(30_300);
		await new Promise(resolve => setImmediate(resolve));
		expect(view.getSnapshot()).toMatchObject({ members: [{ key: "erin" }] });

		// Backoff reattaches exactly one fresh watcher.
		h.clock.advance(1000);
		expect(view.health().watchAttached).toBe(true);
		expect(h.hub.openCount()).toBe(1);
		await view.release();
	});

	it("watch:false still reloads through polling without any watcher", async () => {
		const h = harness(directoryYaml("engineering-wecom", ["alice"]));
		const view = await h.service.acquire({ ...acquireDefaults, baseDir: h.baseDir, watch: false });
		expect(view.health().watchAttached).toBe(false);
		expect(h.hub.watchers).toHaveLength(0);
		h.fs.write(filePath(h), directoryYaml("engineering-wecom", ["frank"]));
		h.clock.advance(30_300);
		await new Promise(resolve => setImmediate(resolve));
		expect(view.getSnapshot()).toMatchObject({ members: [{ key: "frank" }] });
		await view.release();
	});
});

describe("D09: single-flight, refcounting and dispose discipline", () => {
	it("coalesces dirty events arriving during a slow read into one queued follow-up", async () => {
		const h = harness(directoryYaml("engineering-wecom", ["alice"]));
		const gate = { blocked: false, release: (): void => {
			gate.blocked = false;
			gate.pending?.();
			gate.pending = undefined;
		}, pending: undefined as (() => void) | undefined };
		let activeReads = 0;
		let peakReads = 0;
		const service = new MemberDirectoryService({
			readFile: async path => {
				activeReads += 1;
				peakReads = Math.max(peakReads, activeReads);
				try {
					if (gate.blocked) await new Promise<void>(resolve => {
						gate.pending = resolve;
					});
					return await h.fs.readFile(path);
				} finally {
					activeReads -= 1;
				}
			},
			stat: h.fs.stat,
			realpath: h.fs.realpath,
			watchFactory: h.hub.factory,
			scheduler: h.clock.scheduler,
			now: () => h.clock.now,
		});
		const view = await service.acquire({ ...acquireDefaults, baseDir: h.baseDir });
		expect(view.getSnapshot()).toMatchObject({ members: [{ key: "alice" }] });

		// Block the next read, trigger a reload, then pile more events on it.
		gate.blocked = true;
		h.fs.write(filePath(h), directoryYaml("engineering-wecom", ["grace"]));
		h.hub.emit(parentDir(h), "members.yaml");
		h.clock.advance(300);
		await new Promise(resolve => setImmediate(resolve)); // the reload entered readFile
		expect(peakReads).toBe(1);

		h.fs.write(filePath(h), directoryYaml("engineering-wecom", ["heidi"]));
		h.hub.emit(parentDir(h), "members.yaml");
		h.clock.advance(300);
		h.hub.emit(parentDir(h), "members.yaml");
		h.clock.advance(2000);
		expect(peakReads).toBe(1); // single-flight: no parallel reload

		gate.release();
		// The queued follow-up re-reads once and installs the newest content.
		await new Promise(resolve => setImmediate(resolve));
		await new Promise(resolve => setImmediate(resolve));
		await new Promise(resolve => setImmediate(resolve));
		expect(view.getSnapshot()).toMatchObject({ status: "ready", members: [{ key: "heidi" }] });
		await view.release();
	});

	it("shares one reader per path across scopes and closes it with the last release", async () => {
		const h = harness(directoryYaml("engineering-wecom", ["alice"]));
		const base = { ...acquireDefaults, baseDir: h.baseDir };
		const first = await h.service.acquire(base);
		const second = await h.service.acquire(base);
		expect(h.hub.openCount()).toBe(1);
		expect(first.getSnapshot().generation).toBe(second.getSnapshot().generation);

		await first.release();
		expect(h.hub.openCount()).toBe(1);
		expect(h.clock.pending()).toBeGreaterThan(0);
		await second.release();
		expect(h.hub.openCount()).toBe(0);
		expect(h.clock.pending()).toBe(0);
	});

	it("waits for the in-flight read on release and installs nothing afterwards", async () => {
		const h = harness(directoryYaml("engineering-wecom", ["alice"]));
		const view = await h.service.acquire({ ...acquireDefaults, baseDir: h.baseDir });
		h.fs.write(filePath(h), directoryYaml("engineering-wecom", ["zoe"]));
		h.hub.emit(parentDir(h), "members.yaml");
		h.clock.advance(300);
		// The reload is in flight (microtask); release then settle.
		await view.release();
		await new Promise(resolve => setImmediate(resolve));
		// No late install: the generation never advanced past the disposed read.
		expect(view.getSnapshot().generation).toBe(1);
	});
});

describe("D10: missing, invalid and recovered files", () => {
	it("starts unavailable on a missing file, recovers when it appears, and degrades on invalid content", async () => {
		const h = harness();
		const view = await h.service.acquire({ ...acquireDefaults, baseDir: h.baseDir });
		await view.whenSettled();
		expect(view.getSnapshot()).toMatchObject({ status: "unavailable", errorCode: "file_missing" });

		h.fs.write(filePath(h), directoryYaml("engineering-wecom", ["alice"]));
		h.clock.advance(30_300);
		await new Promise(resolve => setImmediate(resolve));
		expect(view.getSnapshot()).toMatchObject({ status: "ready", members: [{ key: "alice" }] });

		h.fs.write(filePath(h), "version: 1\ndirectories: {");
		h.hub.emit(parentDir(h), "members.yaml");
		h.clock.advance(300);
		await new Promise(resolve => setImmediate(resolve));
		const degraded = view.getSnapshot();
		expect(degraded.status).toBe("unavailable");
		expect(String(degraded.errorCode)).toMatch(/^parse_/u);
		expect(degraded.members).toBeUndefined();

		h.fs.write(filePath(h), directoryYaml("engineering-wecom", []));
		h.hub.emit(parentDir(h), "members.yaml");
		h.clock.advance(300);
		await new Promise(resolve => setImmediate(resolve));
		expect(view.getSnapshot()).toMatchObject({ status: "ready", members: [] });
		await view.release();
	});

	it("reports an explicit empty member list as ready (clear semantics)", async () => {
		const h = harness(directoryYaml("engineering-wecom", []));
		const view = await h.service.acquire({ ...acquireDefaults, baseDir: h.baseDir });
		expect(view.getSnapshot()).toMatchObject({ status: "ready", members: [] });
		expect(view.health()).toMatchObject({ memberCount: 0 });
		await view.release();
	});
});

describe("D06/D07 (real fs): atomic replace, delete+recreate, same-mtime swap", () => {
	it("recovers through poll even when watch events are lost", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aicr-member-dir-"));
		try {
			const path = join(dir, "members.yaml");
			writeFileSync(path, directoryYaml("engineering-wecom", ["alice"]));
			const service = new MemberDirectoryService();
			const view = await service.acquire({ ...acquireDefaults, path, baseDir: dir, debounceMs: 50, pollIntervalSeconds: 1 });
			expect(view.getSnapshot()).toMatchObject({ status: "ready" });

			const temporary = join(dir, ".members.tmp");
			writeFileSync(temporary, directoryYaml("engineering-wecom", ["bob"]));
			renameSync(temporary, path);
			await expect.poll(() => view.getSnapshot().members?.[0]?.key, { timeout: 5000 }).toBe("bob");

			unlinkSync(path);
			await expect.poll(() => view.getSnapshot().status, { timeout: 5000 }).toBe("unavailable");

			writeFileSync(path, directoryYaml("engineering-wecom", ["carol"]));
			await expect.poll(() => view.getSnapshot().members?.[0]?.key, { timeout: 5000 }).toBe("carol");

			const stamp = new Date();
			writeFileSync(path, directoryYaml("engineering-wecom", ["dave"]));
			utimesSync(path, stamp, stamp);
			await expect.poll(() => view.getSnapshot().members?.[0]?.key, { timeout: 5000 }).toBe("dave");
			await view.release();
			await service.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20_000);
});

