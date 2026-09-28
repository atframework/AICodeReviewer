import { watch as fsWatchCallback } from "node:fs";
import { realpath as fsRealpath, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { parseMemberDirectorySource, MEMBER_DIRECTORY_LIMITS, type MemberDirectoryData, type MemberDirectoryMember } from "@aicr/core";

/**
 * Host-side member-directory service (member-directory design §4–§5,
 * acceptance D05–D10). One file reader per resolved path (shared across
 * scopes); every acquire returns a scope-isolated view with reference
 * counting. Watching the PARENT directory plus a periodic content digest
 * covers editor atomic-rename saves, missed events and platform watcher
 * gaps; a dirty-but-unverified file never serves stale identities to new
 * matches. The last release stops timers, closes the watcher and waits for
 * the in-flight read; nothing installs after dispose.
 */

export interface MemberDirectoryAcquireOptions {
	/** Absolute or baseDir-relative member file path. */
	readonly path: string;
	/** Base directory for relative paths and the default allowed root. */
	readonly baseDir: string;
	readonly directoryId: string;
	readonly identityScope: { readonly kind: string; readonly id: string };
	/** Trusted root for real-path boundary checks; defaults to baseDir. */
	readonly allowedRoot?: string | undefined;
	readonly watch?: boolean | undefined;
	readonly debounceMs?: number | undefined;
	readonly pollIntervalSeconds?: number | undefined;
}

export type MemberDirectoryStatus = "ready" | "unavailable" | "dirty";

export interface MemberDirectorySnapshot {
	readonly status: MemberDirectoryStatus;
	readonly generation: number;
	readonly digest: string | undefined;
	readonly members: readonly MemberDirectoryMember[] | undefined;
	readonly errorCode: string | undefined;
}

export interface MemberDirectoryHealth extends MemberDirectorySnapshot {
	readonly path: string;
	readonly directoryId: string;
	readonly memberCount: number | undefined;
	readonly watchAttached: boolean;
	readonly lastChangeAt: number | undefined;
}

export interface MemberDirectoryView {
	getSnapshot(): MemberDirectorySnapshot;
	/** Resolves after at least one load attempt has settled. */
	whenSettled(): Promise<void>;
	health(): MemberDirectoryHealth;
	release(): Promise<void>;
}

export interface DirectoryWatcherHandle {
	close(): Promise<void> | void;
}

export interface MemberDirectoryServiceOptions {
	readonly readFile?: (path: string) => Promise<Buffer>;
	readonly stat?: (path: string) => Promise<{ size: number; mtimeMs: number }>;
	readonly realpath?: (path: string) => Promise<string>;
	readonly watchFactory?: (directory: string, onEvent: (filename: string | null) => void, onError: (error: Error) => void) => DirectoryWatcherHandle;
	readonly scheduler?: {
		set: (callback: () => void, ms: number, unref: boolean) => unknown;
		clear: (handle: unknown) => void;
	};
	readonly now?: () => number;
}

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_POLL_SECONDS = 30;
/** Bounded wait so sustained churn still gets a read attempt (design §4). */
const MAX_WAIT_MS = 2000;
const MAX_READ_ATTEMPTS = 3;
const WATCHER_BACKOFF_MS = 1000;
const WATCHER_BACKOFF_MAX_MS = 30_000;

interface ReaderState {
	data: MemberDirectoryData | undefined;
	errorCode: string | undefined;
	dirty: boolean;
	generation: number;
	lastChangeAt: number | undefined;
	watchAttached: boolean;
	settled: boolean;
}

interface DirectoryIO {
	readFile(path: string): Promise<Buffer>;
	stat(path: string): Promise<{ size: number; mtimeMs: number }>;
	realpath(path: string): Promise<string>;
	watchFactory(directory: string, onEvent: (filename: string | null) => void, onError: (error: Error) => void): DirectoryWatcherHandle;
	scheduler: NonNullable<MemberDirectoryServiceOptions["scheduler"]>;
	now(): number;
	basenameOf(path: string): string;
	dirnameOf(path: string): string;
	normalizePath(path: string): string;
	pathWithin(root: string, target: string): boolean;
}

class FileReader {
	private readonly state: ReaderState = { data: undefined, errorCode: undefined, dirty: true, generation: 0, lastChangeAt: undefined, watchAttached: false, settled: false };
	private references = 0;
	private disposed = false;
	private watcher: DirectoryWatcherHandle | undefined;
	private watcherBackoff = WATCHER_BACKOFF_MS;
	private debounceTimer: unknown;
	private maxWaitTimer: unknown;
	private pollTimer: unknown;
	private reattachTimer: unknown;
	private reloadPending: Promise<void> | undefined;
	private reloadQueued = false;
	private settledWaiters: (() => void)[] = [];
	private readonly absolutePath: string;
	private readonly parentDirectory: string;
	private readonly fileBasename: string;
	private readonly normalizedTarget: string;

	constructor(
		absolutePath: string,
		private readonly allowedRoot: string,
		private readonly watch: boolean,
		private readonly debounceMs: number,
		private readonly pollIntervalMs: number,
		private readonly io: DirectoryIO,
	) {
		this.absolutePath = absolutePath;
		this.parentDirectory = io.dirnameOf(absolutePath);
		this.fileBasename = io.basenameOf(absolutePath);
		this.normalizedTarget = io.normalizePath(absolutePath);
	}

	async acquire(): Promise<void> {
		this.references += 1;
		if (this.references > 1 && this.state.settled) return;
		await this.reload().catch(() => undefined);
		if (this.disposed) return;
		if (this.watch && this.references === 1) this.attachWatcher();
		if (this.references === 1) this.schedulePoll();
	}

	getState(): ReaderState {
		return this.state;
	}

	whenSettled(): Promise<void> {
		if (this.state.settled) return Promise.resolve();
		return new Promise(resolve => {
			this.settledWaiters.push(resolve);
		});
	}

	private markSettled(): void {
		this.state.settled = true;
		const waiters = this.settledWaiters;
		this.settledWaiters = [];
		for (const waiter of waiters) waiter();
	}

	private attachWatcher(): void {
		if (this.disposed || this.watcher !== undefined) return;
		try {
			this.watcher = this.io.watchFactory(
				this.parentDirectory,
				filename => this.onWatchEvent(filename),
				() => this.onWatcherFailure(),
			);
			this.watcherBackoff = WATCHER_BACKOFF_MS;
			this.state.watchAttached = true;
		} catch {
			this.state.watchAttached = false;
			this.scheduleReattach();
		}
	}

	private onWatcherFailure(): void {
		const failed = this.watcher;
		this.watcher = undefined;
		void failed?.close();
		this.state.watchAttached = false;
		if (!this.disposed) this.scheduleReattach();
	}

	private scheduleReattach(): void {
		if (this.disposed || this.reattachTimer !== undefined) return;
		this.reattachTimer = this.io.scheduler.set(() => {
			this.reattachTimer = undefined;
			this.attachWatcher();
		}, this.watcherBackoff, true);
		this.watcherBackoff = Math.min(this.watcherBackoff * 2, WATCHER_BACKOFF_MAX_MS);
	}

	private onWatchEvent(filename: string | null): void {
		// Missing filenames are platform-normal: treat them as this file and
		// let the digest comparison decide (D07).
		if (filename !== null && filename !== this.fileBasename) return;
		this.markDirty();
	}

	private markDirty(): void {
		if (this.disposed) return;
		this.state.dirty = true;
		if (this.debounceTimer === undefined && this.reloadPending === undefined) {
			this.debounceTimer = this.io.scheduler.set(() => {
				this.debounceTimer = undefined;
				void this.reload();
			}, this.debounceMs, true);
		}
		if (this.maxWaitTimer === undefined && this.reloadPending === undefined) {
			this.maxWaitTimer = this.io.scheduler.set(() => {
				this.maxWaitTimer = undefined;
				if (this.debounceTimer !== undefined) {
					this.io.scheduler.clear(this.debounceTimer);
					this.debounceTimer = undefined;
				}
				void this.reload();
			}, MAX_WAIT_MS, true);
		}
	}

	private schedulePoll(): void {
		if (this.disposed) return;
		this.pollTimer = this.io.scheduler.set(() => {
			this.pollTimer = undefined;
			this.markDirty();
			this.schedulePoll();
		}, this.pollIntervalMs, true);
	}

	private reload(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (this.reloadPending !== undefined) {
			this.reloadQueued = true;
			return this.reloadPending;
		}
		this.reloadPending = this.performReload().catch(() => undefined).finally(() => {
			this.reloadPending = undefined;
			if (!this.disposed && this.reloadQueued) {
				this.reloadQueued = false;
				void this.reload();
			}
		});
		return this.reloadPending;
	}

	private async performReload(): Promise<void> {
		for (const handle of [this.debounceTimer, this.maxWaitTimer]) {
			if (handle !== undefined) this.io.scheduler.clear(handle);
		}
		this.debounceTimer = this.maxWaitTimer = undefined;
		for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt += 1) {
			if (this.disposed) return;
			try {
				const normalized = this.io.normalizePath(await this.io.realpath(this.absolutePath));
				if (normalized !== this.normalizedTarget && !this.io.pathWithin(this.allowedRoot, normalized)) {
					this.install(undefined, "path_outside_allowed_root");
					return;
				}
				const before = await this.io.stat(this.absolutePath);
				if (before.size > MEMBER_DIRECTORY_LIMITS.maxFileBytes) {
					this.install(undefined, "directory_too_large");
					return;
				}
				const bytes = await this.io.readFile(this.absolutePath);
				const after = await this.io.stat(this.absolutePath);
				// Mid-write files retry with bounded attempts, then degrade.
				if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) continue;
				const parsed = parseMemberDirectorySource(bytes, { fileName: this.absolutePath });
				if (!parsed.ok) {
					this.install(undefined, `parse_${parsed.issue.code}`);
					return;
				}
				if (this.state.data?.digest === parsed.data.digest) {
					// Same digest: keep the snapshot, no generation bump — but a
					// recovered file clears any earlier failure state.
					this.state.errorCode = undefined;
					this.state.dirty = false;
					this.markSettled();
					return;
				}
				this.install(parsed.data, undefined);
				return;
			} catch (error) {
				if (attempt === MAX_READ_ATTEMPTS) {
					const code = (error as NodeJS.ErrnoException).code;
					this.install(undefined, code === "ENOENT" ? "file_missing" : code === "EACCES" || code === "EPERM" ? "file_unreadable" : "read_failed");
					return;
				}
			}
		}
	}

	private install(data: MemberDirectoryData | undefined, errorCode: string | undefined): void {
		if (this.disposed) return;
		if (data !== undefined) {
			this.state.data = data;
			this.state.errorCode = undefined;
			this.state.generation += 1;
			this.state.lastChangeAt = this.io.now();
		} else {
			// Invalid content keeps the last-good snapshot for diagnostics
			// only; new matches must not use it.
			this.state.errorCode = errorCode;
		}
		this.state.dirty = false;
		this.markSettled();
	}

	async release(): Promise<void> {
		this.references -= 1;
		if (this.references > 0) return;
		this.disposed = true;
		for (const handle of [this.debounceTimer, this.maxWaitTimer, this.pollTimer, this.reattachTimer]) {
			if (handle !== undefined) this.io.scheduler.clear(handle);
		}
		this.debounceTimer = this.maxWaitTimer = this.pollTimer = this.reattachTimer = undefined;
		const watcher = this.watcher;
		this.watcher = undefined;
		this.state.watchAttached = false;
		if (this.reloadPending !== undefined) await this.reloadPending;
		if (watcher !== undefined) await watcher.close();
	}
}

export class MemberDirectoryService {
	private readonly readers = new Map<string, { reader: FileReader; views: number }>();
	private readonly io: DirectoryIO;

	constructor(options: MemberDirectoryServiceOptions = {}) {
		this.io = {
			readFile: options.readFile ?? ((path) => fsReadFile(path)),
			stat: options.stat ?? (async path => {
				const stats = await fsStat(path);
				return { size: stats.size, mtimeMs: stats.mtimeMs };
			}),
			realpath: options.realpath ?? ((path) => fsRealpath(path)),
			watchFactory: options.watchFactory ?? ((directory, onEvent, onError) => {
				const watcher = fsWatchCallback(directory, { persistent: false });
				watcher.on("change", (_type: string, filename: string | Buffer | null) => onEvent(filename === null ? null : String(filename)));
				watcher.on("error", (error: Error) => onError(error));
				return { close: () => watcher.close() };
			}),
			scheduler: options.scheduler ?? {
				set: (callback, ms, unref) => {
					const handle = setTimeout(callback, ms);
					if (unref && typeof handle.unref === "function") handle.unref();
					return handle;
				},
				clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
			},
			now: options.now ?? (() => Date.now()),
			basenameOf: path => basename(path),
			dirnameOf: path => dirname(path),
			normalizePath: path => path.replaceAll("\\", "/").toLowerCase(),
			pathWithin: (root, target) => {
				const rel = relative(resolve(root), resolve(target));
				return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
			},
		};
	}

	async acquire(options: MemberDirectoryAcquireOptions): Promise<MemberDirectoryView> {
		const absolutePath = resolve(options.baseDir, options.path);
		const allowedRoot = resolve(options.baseDir, options.allowedRoot ?? "");
		const watch = options.watch ?? true;
		const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		const pollIntervalMs = (options.pollIntervalSeconds ?? DEFAULT_POLL_SECONDS) * 1000;
		const key = this.io.normalizePath(absolutePath);
		let entry = this.readers.get(key);
		if (entry === undefined) {
			entry = { reader: new FileReader(absolutePath, allowedRoot, watch, debounceMs, pollIntervalMs, this.io), views: 0 };
			this.readers.set(key, entry);
		}
		entry.views += 1;
		const reader = entry.reader;
		await reader.acquire();
		const view: MemberDirectoryView = {
			getSnapshot: () => snapshotOf(reader, options.directoryId, options.identityScope),
			whenSettled: () => reader.whenSettled(),
			health: () => {
				const snapshot = snapshotOf(reader, options.directoryId, options.identityScope);
				const state = reader.getState();
				return {
					...snapshot,
					path: absolutePath,
					directoryId: options.directoryId,
					memberCount: snapshot.members?.length,
					watchAttached: state.watchAttached,
					lastChangeAt: state.lastChangeAt,
				};
			},
			release: async () => {
				const current = this.readers.get(key);
				if (current === undefined) return;
				current.views -= 1;
				if (current.views <= 0) this.readers.delete(key);
				await reader.release();
			},
		};
		return view;
	}

	/** Closes every view; generation dispose (IM-17) wires this. */
	async dispose(): Promise<void> {
		const entries = [...this.readers.values()];
		this.readers.clear();
		await Promise.all(entries.map(entry => entry.reader.release()));
	}
}

function snapshotOf(
	reader: FileReader,
	directoryId: string,
	identityScope: { readonly kind: string; readonly id: string },
): MemberDirectorySnapshot {
	const state = reader.getState();
	const directory = state.data?.directories.get(directoryId);
	if (state.dirty) {
		return { status: "dirty", generation: state.generation, digest: state.data?.digest, members: undefined, errorCode: state.errorCode };
	}
	// A file-level failure (missing, unparsable, outside the trusted root)
	// never serves the last-good snapshot to new matches; diagnostics only.
	if (state.errorCode !== undefined) {
		return { status: "unavailable", generation: state.generation, digest: state.data?.digest, members: undefined, errorCode: state.errorCode };
	}
	if (directory === undefined) {
		return {
			status: "unavailable",
			generation: state.generation,
			digest: state.data?.digest,
			members: undefined,
			errorCode: state.errorCode ?? (state.data === undefined ? "not_loaded" : "directory_not_found"),
		};
	}
	if (directory.identityScope.kind !== identityScope.kind || directory.identityScope.id !== identityScope.id) {
		return { status: "unavailable", generation: state.generation, digest: state.data?.digest, members: undefined, errorCode: "identity_scope_mismatch" };
	}
	return { status: "ready", generation: state.generation, digest: state.data?.digest, members: directory.members, errorCode: undefined };
}
