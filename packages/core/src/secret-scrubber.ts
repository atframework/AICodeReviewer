export type RedactedKind =
	| "aws_key"
	| "generic_api_key"
	| "private_key"
	| "jwt"
	| "github_token"
	| "gitlab_token"
	| "connection_string"
	| "oauth_token"
	| "slack_token"
	| "basic_auth"
	| "high_entropy"
	| "key_value_pair";

export interface ScrubMatch {
	readonly line: number;
	readonly column: number;
	readonly kind: RedactedKind;
	readonly matched: string;
	readonly replacement: string;
}

export interface ScrubResult {
	readonly text: string;
	readonly matches: readonly ScrubMatch[];
}

const SECRET_PATTERNS: readonly { readonly kind: RedactedKind; readonly pattern: RegExp; readonly caseInsensitive?: boolean }[] = [
	{
		kind: "aws_key",
		pattern: /\b((?:AKIA|ASIA|AROA|AIPA|ANPA|ANVA|A3T|AGPA|AIDA|ABIA)[A-Z0-9]{16})\b/gu,
	},
	{
		kind: "aws_key",
		pattern: /\b(aws(?:_|-)secret(?:_|-)access(?:_|-)key\s*[:=]\s*['"]?)([A-Za-z0-9/+=]{40})/gu,
	},
	{
		kind: "private_key",
		pattern: /-----BEGIN\s+(?:(?:RSA|DSA|EC|OPENSSH|PGP)\s+)?PRIVATE\s+KEY-----/gu,
	},
	{
		kind: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
	},
	{
		kind: "github_token",
		pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,255}\b/gu,
	},
	{
		kind: "github_token",
		pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/gu,
	},
	{
		kind: "gitlab_token",
		pattern: /\bglpat-[A-Za-z0-9_-]{26,}\b/gu,
	},
	{
		kind: "gitlab_token",
		pattern: /\bgldt-[A-Za-z0-9_-]{26,}\b/gu,
	},
	{
		kind: "slack_token",
		pattern: /\bxox[abopsr]-\d{10,13}-\d{10,13}-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?\b/gu,
	},
	{
		kind: "slack_token",
		pattern: /\btoken\s*=\s*['"]xox[abopsr]-[A-Za-z0-9-]+\b/gu,
	},
	{
		kind: "connection_string",
		pattern: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|rediss|sqlite|jdbc|mssql):\/\/[^\s"'<>`]+/gu,
	},
	{
		kind: "connection_string",
		pattern: /\b(?:Server|Host|Database|Port|UID|PWD|Password)\s*=\s*[^\s;]+?;\s*(?:Server|Host|Database|Port|UID|PWD|Password)/gu,
	},
	{
		kind: "generic_api_key",
		pattern: /\b(?:sk|pk|api[_-]?key|apikey|secret|token|access[_-]?key|auth[_-]?token)\s*[:=]\s*['"]?([A-Za-z0-9+/=_-]{20,})['"]?/giu,
	},
	{
		kind: "oauth_token",
		pattern: /\bya29\.[A-Za-z0-9_-]{50,200}\b/gu,
	},
	{
		kind: "oauth_token",
		pattern: /\btoken\s*=\s*['"]?ya29\.[A-Za-z0-9_-]{50,200}/gu,
	},
	{
		kind: "basic_auth",
		pattern: /\bAuthorization\s*:\s*Basic\s+[A-Za-z0-9+/=]+\b/gu,
	},
	{
		kind: "basic_auth",
		pattern: /\bBasic\s+[A-Za-z0-9+/=]{20,}\b/gu,
	},
];

const HIGH_ENTROPY_PATTERN = /[A-Za-z0-9+/=_-]{40,}/gu;

const ENTROPY_THRESHOLD = 4.5;

const KEY_VALUE_PATTERN = /\b(?:const|let|var|export\s+const|export\s+let)?\s*([A-Za-z_]\w*)\s*[:=]\s*['"]([^'"]{16,})['"]/gu;

const KEY_VALUE_SENSITIVE_NAMES = new Set([
	"password",
	"passwd",
	"secret",
	"token",
	"apiKey",
	"apikey",
	"api_key",
	"apiSecret",
	"api_secret",
	"accessKey",
	"access_key",
	"accessSecret",
	"access_secret",
	"privateKey",
	"private_key",
	"authToken",
	"auth_token",
	"credential",
	"credentials",
	"jwt",
	"key",
]);

function shannonEntropy(text: string): number {
	if (text.length === 0) return 0;
	const frequencies = new Map<string, number>();
	for (const char of text) {
		frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
	}
	let entropy = 0;
	for (const count of frequencies.values()) {
		const probability = count / text.length;
		entropy -= probability * Math.log2(probability);
	}
	return entropy;
}

function redactValue(kind: RedactedKind): string {
	return `<REDACTED:${kind.toUpperCase()}>`;
}

export function scrubText(input: string): ScrubResult {
	const matches: ScrubMatch[] = [];
	let text = input;

	for (const { kind, pattern } of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) !== null) {
			const matched = match[0];
			const lineOffset = text.slice(0, match.index).split("\n").length - 1;
			const columnOffset = match.index - text.lastIndexOf("\n", match.index - 1) - 1;
			const replacement = redactValue(kind);
			matches.push({
				line: lineOffset,
				column: Math.max(0, columnOffset),
				kind,
				matched,
				replacement,
			});
		}
	}

	for (const match of matches) {
		text = text.replace(match.matched, match.replacement);
	}

	const postRegexText = text;
	HIGH_ENTROPY_PATTERN.lastIndex = 0;
	let entropyMatch: RegExpExecArray | null;
	while ((entropyMatch = HIGH_ENTROPY_PATTERN.exec(postRegexText)) !== null) {
		const candidate = entropyMatch[0];

		if (matches.some((entry) => entropyMatch && postRegexText.slice(entropyMatch.index, entropyMatch.index + candidate.length).includes(entry.replacement))) {
			continue;
		}

		const entropy = shannonEntropy(candidate);
		if (entropy >= ENTROPY_THRESHOLD) {
			const lineOffset = postRegexText.slice(0, entropyMatch.index).split("\n").length - 1;
			const columnOffset = entropyMatch.index - postRegexText.lastIndexOf("\n", entropyMatch.index - 1) - 1;
			const replacement = redactValue("high_entropy");
			matches.push({
				line: lineOffset,
				column: Math.max(0, columnOffset),
				kind: "high_entropy",
				matched: candidate,
				replacement,
			});
		}
	}

	for (const match of matches.filter((entry) => entry.kind === "high_entropy")) {
		text = text.replace(match.matched, match.replacement);
	}

	KEY_VALUE_PATTERN.lastIndex = 0;
	let kvMatch: RegExpExecArray | null;
	while ((kvMatch = KEY_VALUE_PATTERN.exec(text)) !== null) {
		const varName = kvMatch[1]!;
		const varValue = kvMatch[2]!;
		const matched = kvMatch[0];

		if (KEY_VALUE_SENSITIVE_NAMES.has(varName) && varValue.length >= 16) {
			const alreadyRedacted = matches.some((entry) => {
				const idx = text.indexOf(entry.replacement);
				return idx >= 0 && idx >= kvMatch!.index && idx < kvMatch!.index + matched.length;
			});
			if (alreadyRedacted) continue;

			const lineOffset = text.slice(0, kvMatch.index).split("\n").length - 1;
			const columnOffset = kvMatch.index - text.lastIndexOf("\n", kvMatch.index - 1) - 1;
			matches.push({
				line: lineOffset,
				column: Math.max(0, columnOffset),
				kind: "key_value_pair",
				matched: varValue,
				replacement: redactValue("key_value_pair"),
			});
			text = text.replace(varValue, redactValue("key_value_pair"));
		}
	}

	return { text, matches };
}

export function scrubDiff(input: string): ScrubResult {
	return scrubText(input);
}

export function scrubPromptMessages(messages: readonly { readonly role: string; readonly content: string }[]): {
	messages: readonly { readonly role: string; readonly content: string }[];
	matches: readonly ScrubMatch[];
} {
	const allMatches: ScrubMatch[] = [];
	const scrubbedMessages = messages.map((msg) => {
		const result = scrubText(msg.content);
		allMatches.push(...result.matches);
		return { role: msg.role, content: result.text };
	});
	return { messages: scrubbedMessages, matches: allMatches };
}
