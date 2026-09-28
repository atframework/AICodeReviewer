import { createHash } from "node:crypto";

import { isAlias, isMap, isSeq, isScalar, parseDocument } from "yaml";
import { z } from "zod";

/**
 * Strict external member-directory parser (member-directory design §1–§2,
 * acceptance D01–D04). Pure: no filesystem, watcher, clock, or network access.
 * The whole file parses and validates, or nothing is returned — broken members
 * are never filtered out to serve an incomplete directory. An explicit empty
 * `members: []` is a successful clear.
 */

// ---------------------------------------------------------------------------
// Limits and vocabularies (member-directory design §2; local host budgets)
// ---------------------------------------------------------------------------

export const MEMBER_DIRECTORY_LIMITS = Object.freeze({
	/** Whole-file UTF-8 byte cap. */
	maxFileBytes: 4 * 1024 * 1024,
	/** Distinct directories per file. */
	maxDirectories: 64,
	/** Members summed across every directory in the file. */
	maxTotalMembers: 10_000,
	/** Per-member alias/email/vcs_account list lengths. */
	maxListEntries: 20,
	/** Plain matching strings (names, aliases, emails, usernames). */
	maxStringLength: 256,
	/** Member keys and platform mention ids. */
	maxIdLength: 128,
});

export type MemberDirectoryPlatform = "wecom" | "feishu";

export const MEMBER_DIRECTORY_IDENTITY_SCOPES = ["wecom_corp", "feishu_app", "feishu_tenant"] as const;
export type MemberDirectoryIdentityScopeKind = (typeof MEMBER_DIRECTORY_IDENTITY_SCOPES)[number];

export const MEMBER_MENTION_TYPES = ["wecom_userid", "wecom_mobile", "feishu_open_id", "feishu_user_id"] as const;
export type MemberMentionType = (typeof MEMBER_MENTION_TYPES)[number];

/** Mention types each identity scope may carry (member-directory design §2). */
const MENTION_TYPES_BY_SCOPE: Readonly<Record<MemberDirectoryIdentityScopeKind, readonly MemberMentionType[]>> = {
	wecom_corp: ["wecom_userid", "wecom_mobile"],
	feishu_app: ["feishu_open_id"],
	feishu_tenant: ["feishu_user_id"],
};

const PLATFORM_SCOPES: Readonly<Record<MemberDirectoryPlatform, readonly MemberDirectoryIdentityScopeKind[]>> = {
	wecom: ["wecom_corp"],
	feishu: ["feishu_app", "feishu_tenant"],
};

// ---------------------------------------------------------------------------
// Output model (immutable)
// ---------------------------------------------------------------------------

export interface MemberDirectoryVcsAccount {
	readonly provider: string;
	readonly sourceTrigger: string;
	readonly username: string;
}

export interface MemberDirectoryMember {
	readonly key: string;
	readonly displayName?: string | undefined;
	readonly aliases: readonly string[];
	readonly emails: readonly string[];
	readonly vcsAccounts: readonly MemberDirectoryVcsAccount[];
	readonly mention: { readonly type: MemberMentionType; readonly id: string };
}

export interface MemberDirectoryEntry {
	readonly platform: MemberDirectoryPlatform;
	readonly identityScope: { readonly kind: MemberDirectoryIdentityScopeKind; readonly id: string };
	readonly members: readonly MemberDirectoryMember[];
}

export interface MemberDirectoryData {
	readonly version: 1;
	readonly directories: ReadonlyMap<string, MemberDirectoryEntry>;
	/** SHA-256 of the exact input bytes. */
	readonly digest: string;
}

export type MemberDirectoryIssueCode =
	| "directory_too_large"
	| "invalid_encoding"
	| "malformed_yaml"
	| "malformed_json"
	| "yaml_alias"
	| "yaml_tag"
	| "duplicate_key"
	| "invalid_shape"
	| "limit_exceeded"
	| "duplicate_member_key"
	| "duplicate_mention_id"
	| "identity_scope_mismatch"
	| "invalid_mention";

export interface MemberDirectoryIssue {
	readonly code: MemberDirectoryIssueCode;
	readonly message: string;
	readonly path: readonly string[];
}

export type MemberDirectoryParseResult =
	| { readonly ok: true; readonly data: MemberDirectoryData }
	| { readonly ok: false; readonly issue: MemberDirectoryIssue };

// ---------------------------------------------------------------------------
// Strict JSON (design §1: JSON rejects YAML-only syntax; duplicate keys are
// detected during parsing, never after JSON.parse already dropped them)
// ---------------------------------------------------------------------------

class JsonSyntaxError extends Error {}

class StrictJsonParser {
	private index = 0;

	constructor(private readonly text: string) {}

	parse(): unknown {
		this.skipWhitespace();
		const value = this.parseValue();
		this.skipWhitespace();
		if (this.index !== this.text.length) throw new JsonSyntaxError("trailing content after the JSON value");
		return value;
	}

	private skipWhitespace(): void {
		while (this.index < this.text.length && /[\t\n\r ]/u.test(this.text[this.index]!)) this.index += 1;
	}

	private parseValue(): unknown {
		const char = this.text[this.index];
		if (char === "{") return this.parseObject();
		if (char === "[") return this.parseArray();
		if (char === '"') return this.parseString();
		if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return this.parseNumber();
		for (const literal of ["true", "false", "null"] as const) {
			if (this.text.startsWith(literal, this.index)) {
				this.index += literal.length;
				return literal === "true" ? true : literal === "false" ? false : null;
			}
		}
		throw new JsonSyntaxError(`unexpected character "${String(char)}" at offset ${this.index}`);
	}

	private parseObject(): Record<string, unknown> {
		this.index += 1; // {
		const result: Record<string, unknown> = {};
		this.skipWhitespace();
		if (this.text[this.index] === "}") {
			this.index += 1;
			return result;
		}
		for (;;) {
			this.skipWhitespace();
			if (this.text[this.index] !== '"') throw new JsonSyntaxError("object keys must be double-quoted strings");
			const key = this.parseString();
			this.skipWhitespace();
			if (this.text[this.index] !== ":") throw new JsonSyntaxError("expected ':' after object key");
			this.index += 1;
			this.skipWhitespace();
			if (Object.hasOwn(result, key)) throw new JsonSyntaxError(`duplicate object key "${key}"`);
			result[key] = this.parseValue();
			this.skipWhitespace();
			const next = this.text[this.index];
			if (next === ",") {
				this.index += 1;
				continue;
			}
			if (next === "}") {
				this.index += 1;
				return result;
			}
			throw new JsonSyntaxError("expected ',' or '}' in object");
		}
	}

	private parseArray(): unknown[] {
		this.index += 1; // [
		const result: unknown[] = [];
		this.skipWhitespace();
		if (this.text[this.index] === "]") {
			this.index += 1;
			return result;
		}
		for (;;) {
			this.skipWhitespace();
			result.push(this.parseValue());
			this.skipWhitespace();
			const next = this.text[this.index];
			if (next === ",") {
				this.index += 1;
				continue;
			}
			if (next === "]") {
				this.index += 1;
				return result;
			}
			throw new JsonSyntaxError("expected ',' or ']' in array");
		}
	}

	private parseString(): string {
		this.index += 1; // opening quote
		let out = "";
		for (;;) {
			if (this.index >= this.text.length) throw new JsonSyntaxError("unterminated string");
			const char = this.text[this.index]!;
			if (char === '"') {
				this.index += 1;
				return out;
			}
			if (char === "\\") {
				const escape = this.text[this.index + 1];
				const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
				if (escape !== undefined && simple[escape] !== undefined) {
					out += simple[escape]!;
					this.index += 2;
					continue;
				}
				if (escape === "u") {
					const hex = this.text.slice(this.index + 2, this.index + 6);
					if (!/^[0-9a-fA-F]{4}$/u.test(hex)) throw new JsonSyntaxError("invalid \\u escape");
					out += String.fromCharCode(Number.parseInt(hex, 16));
					this.index += 6;
					continue;
				}
				throw new JsonSyntaxError(`invalid escape "\\${String(escape)}"`);
			}
			if (char < " ") throw new JsonSyntaxError("raw control character in string");
			out += char;
			this.index += 1;
		}
	}

	private parseNumber(): number {
		const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.text.slice(this.index));
		if (match === null) throw new JsonSyntaxError("invalid number");
		this.index += match[0].length;
		const value = Number(match[0]);
		// Syntactically valid exponents can overflow to Infinity; directories
		// have no legitimate non-finite value.
		if (!Number.isFinite(value)) throw new JsonSyntaxError("number magnitude is out of range");
		return value;
	}
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const memberKeySchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u, "member keys must be stable identifiers")
	.refine((value) => !["__proto__", "prototype", "constructor"].includes(value), "member keys must not be prototype keys");

const plainString = (field: string): z.ZodString =>
	z.string().min(1).max(MEMBER_DIRECTORY_LIMITS.maxStringLength, `${field} exceeds ${MEMBER_DIRECTORY_LIMITS.maxStringLength} characters`);

// Matching entries may be blank or whitespace; normalization drops them.
const matchableString = (field: string): z.ZodString =>
	z.string().max(MEMBER_DIRECTORY_LIMITS.maxStringLength, `${field} exceeds ${MEMBER_DIRECTORY_LIMITS.maxStringLength} characters`);

const boundedList = (field: string): z.ZodArray<z.ZodString> =>
	z.array(matchableString(field)).max(MEMBER_DIRECTORY_LIMITS.maxListEntries, `${field} exceeds ${MEMBER_DIRECTORY_LIMITS.maxListEntries} entries`);

const mentionIdSchema = z
	.string()
	.min(1)
	.max(MEMBER_DIRECTORY_LIMITS.maxIdLength)
	.refine((value) => ![...value].some(char => {
		const code = char.codePointAt(0)!;
		return code < 0x20 || code === 0x7f;
	}), "mention ids must not contain control characters")
	.refine((value) => !/[<>"'`\\]/u.test(value), "mention ids must not contain markup or quote characters");

const vcsAccountSchema = z
	.object({
		provider: plainString("vcs_accounts.provider"),
		source_trigger: plainString("vcs_accounts.source_trigger"),
		username: plainString("vcs_accounts.username"),
	})
	.strict();

const memberSchema = z
	.object({
		key: memberKeySchema,
		display_name: plainString("display_name").optional(),
		aliases: boundedList("aliases").optional(),
		emails: boundedList("emails").optional(),
		vcs_accounts: z.array(vcsAccountSchema).max(MEMBER_DIRECTORY_LIMITS.maxListEntries).optional(),
		mention: z
			.object({
				type: z.enum(MEMBER_MENTION_TYPES),
				id: mentionIdSchema,
			})
			.strict(),
	})
	.strict();

const identityScopeSchema = z
	.object({
		kind: z.enum(MEMBER_DIRECTORY_IDENTITY_SCOPES),
		id: z.string().min(1).max(MEMBER_DIRECTORY_LIMITS.maxIdLength),
	})
	.strict();

const directorySchema = z
	.object({
		platform: z.enum(["wecom", "feishu"]),
		identity_scope: identityScopeSchema,
		members: z.array(memberSchema),
	})
	.strict();

const fileSchema = z
	.object({
		version: z.literal(1),
		directories: z.record(memberKeySchema, directorySchema),
	})
	.strict();

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function fail(code: MemberDirectoryIssueCode, message: string, path: readonly string[] = []): MemberDirectoryParseResult {
	return { ok: false, issue: { code, message, path } };
}

function collectAliasNodes(node: unknown, seen: { alias: boolean }): void {
	if (isAlias(node)) {
		seen.alias = true;
		return;
	}
	if (isMap(node)) {
		for (const item of node.items) {
			collectAliasNodes(item.key, seen);
			collectAliasNodes(item.value, seen);
		}
		return;
	}
	if (isSeq(node)) {
		for (const item of node.items) collectAliasNodes(item, seen);
	}
}

function hasCustomTag(node: unknown): boolean {
	if (isScalar(node) && node.tag !== undefined && !node.tag.startsWith("tag:yaml.org,2002:") && !["?", "!"].includes(node.tag)) {
		return true;
	}
	if (isMap(node)) return node.items.some(item => hasCustomTag(item.key) || hasCustomTag(item.value));
	if (isSeq(node)) return node.items.some(item => hasCustomTag(item));
	return false;
}

function toPlain(node: unknown): unknown {
	if (isMap(node) || isSeq(node) || isScalar(node)) return node.toJSON();
	return undefined;
}

export function parseMemberDirectorySource(
	source: string | Uint8Array,
	options: { readonly fileName?: string | undefined; readonly format?: "yaml" | "json" | undefined } = {},
): MemberDirectoryParseResult {
	const bytes = typeof source === "string" ? Buffer.from(source, "utf8") : Buffer.from(source);
	if (bytes.byteLength > MEMBER_DIRECTORY_LIMITS.maxFileBytes) {
		return fail("directory_too_large", `member directory exceeds ${MEMBER_DIRECTORY_LIMITS.maxFileBytes} bytes`);
	}
	const text = bytes.toString("utf8");
	if (text.includes("�")) {
		return fail("invalid_encoding", "member directory must be valid UTF-8");
	}
	const extension = options.fileName !== undefined && options.fileName.toLowerCase().endsWith(".json") ? "json" : "yaml";
	const format = options.format ?? extension;

	let tree: unknown;
	if (format === "json") {
		try {
			tree = new StrictJsonParser(text).parse();
		} catch (error) {
			return fail("malformed_json", `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		const doc = parseDocument(text, { uniqueKeys: true, stringKeys: true, merge: false });
		if (doc.errors.length > 0) {
			return fail("malformed_yaml", `invalid YAML: ${doc.errors[0]!.message.split("\n")[0]!}`);
		}
		const aliases: { alias: boolean } = { alias: false };
		collectAliasNodes(doc.contents, aliases);
		if (aliases.alias) return fail("yaml_alias", "YAML aliases are not accepted in member directories");
		if (hasCustomTag(doc.contents)) return fail("yaml_tag", "custom YAML tags are not accepted in member directories");
		tree = toPlain(doc.contents);
	}

	const parsed = fileSchema.safeParse(tree);
	if (!parsed.success) {
		const first = parsed.error.issues[0]!;
		return fail("invalid_shape", first.message, first.path.map(String));
	}
	const file = parsed.data;
	const directoryNames = Object.keys(file.directories);
	if (directoryNames.length === 0) {
		return fail("invalid_shape", "directories must name at least one directory", ["directories"]);
	}
	if (directoryNames.length > MEMBER_DIRECTORY_LIMITS.maxDirectories) {
		return fail("limit_exceeded", `member directory files carry at most ${MEMBER_DIRECTORY_LIMITS.maxDirectories} directories`);
	}
	let totalMembers = 0;
	const directories = new Map<string, MemberDirectoryEntry>();
	for (const [name, raw] of Object.entries(file.directories)) {
		const built = buildEntry(name, raw);
		if (!built.ok) return { ok: false, issue: built.issue };
		totalMembers += built.entry.members.length;
		if (totalMembers > MEMBER_DIRECTORY_LIMITS.maxTotalMembers) {
			return fail("limit_exceeded", `member directory files carry at most ${MEMBER_DIRECTORY_LIMITS.maxTotalMembers} members`, ["directories", name]);
		}
		directories.set(name, built.entry);
	}

	const data: MemberDirectoryData = Object.freeze({
		version: 1,
		directories,
		digest: createHash("sha256").update(bytes).digest("hex"),
	});
	return { ok: true, data };
}

type EntryBuild =
	| { readonly ok: true; readonly entry: MemberDirectoryEntry }
	| { readonly ok: false; readonly issue: MemberDirectoryIssue };

function buildEntry(name: string, raw: z.infer<typeof directorySchema>): EntryBuild {
	const scopeKind = raw.identity_scope.kind;
	if (!PLATFORM_SCOPES[raw.platform].includes(scopeKind)) {
		return { ok: false, issue: { code: "identity_scope_mismatch", message: `platform "${raw.platform}" cannot use identity scope "${scopeKind}"`, path: ["directories", name, "identity_scope", "kind"] } };
	}
	const members: MemberDirectoryMember[] = [];
	const memberKeys = new Set<string>();
	const mentionIds = new Set<string>();
	for (const [index, member] of raw.members.entries()) {
		if (memberKeys.has(member.key)) {
			return { ok: false, issue: { code: "duplicate_member_key", message: `duplicate member key "${member.key}"`, path: ["directories", name, "members", String(index), "key"] } };
		}
		memberKeys.add(member.key);
		if (!MENTION_TYPES_BY_SCOPE[scopeKind].includes(member.mention.type)) {
			return { ok: false, issue: { code: "identity_scope_mismatch", message: `mention type "${member.mention.type}" is not valid inside scope "${scopeKind}"`, path: ["directories", name, "members", String(index), "mention", "type"] } };
		}
		if (member.mention.id === "all" || member.mention.id === "@all") {
			return { ok: false, issue: { code: "invalid_mention", message: "all/@all pseudo identities are not valid mention ids", path: ["directories", name, "members", String(index), "mention", "id"] } };
		}
		const mentionKey = `${member.mention.type}:${member.mention.id}`;
		if (mentionIds.has(mentionKey)) {
			return { ok: false, issue: { code: "duplicate_mention_id", message: `mention ${mentionKey} belongs to more than one member`, path: ["directories", name, "members", String(index), "mention", "id"] } };
		}
		mentionIds.add(mentionKey);
		members.push(Object.freeze({
			key: member.key,
			...(member.display_name !== undefined ? { displayName: member.display_name } : {}),
			aliases: Object.freeze([...new Set((member.aliases ?? []).map(alias => alias.trim()).filter(alias => alias.length > 0))]),
			emails: Object.freeze([...new Set((member.emails ?? []).map(email => email.trim().toLowerCase()).filter(email => email.length > 0))]),
			vcsAccounts: Object.freeze((member.vcs_accounts ?? []).map(account => Object.freeze({
				provider: account.provider, sourceTrigger: account.source_trigger, username: account.username,
			}))),
			mention: Object.freeze({ type: member.mention.type, id: member.mention.id }),
		}));
	}
	return {
		ok: true,
		entry: Object.freeze({
			platform: raw.platform,
			identityScope: Object.freeze({ kind: scopeKind, id: raw.identity_scope.id }),
			members: Object.freeze(members),
		}),
	};
}
