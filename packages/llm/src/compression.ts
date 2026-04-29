import { estimatePromptTokens } from "@aicr/core";
import type {
	ParsedDiff,
	ParsedDiffFile,
	ParsedDiffHunk,
} from "@aicr/vcs";

import type { ChatCompletionClient, ModelSpec } from "./index.js";

export interface CompressionConfig {
	readonly triggerTokens?: number;
	readonly maxInputRatio?: number;
	readonly keepHunksTopK?: number;
	readonly contextLines?: number;
	readonly summarizeModelRole?: string;
	readonly perModelOverrides?: Readonly<Record<string, { readonly triggerTokens?: number }>>;
}

export interface CompressionInput {
	readonly diff: ParsedDiff;
	readonly promptText: string;
	readonly model: ModelSpec;
	readonly config: CompressionConfig;
}

export interface ScoredHunk {
	readonly fileIndex: number;
	readonly hunkIndex: number;
	readonly score: number;
}

export interface CompressionResult {
	readonly compressed: boolean;
	readonly compactDiff: string;
	readonly selectedHunks: readonly ScoredHunk[];
	readonly originalTokenEstimate: number;
	readonly compressedTokenEstimate: number;
}

interface PerFileSummary {
	readonly fileIndex: number;
	readonly filePath: string;
	readonly summary: string;
	readonly highRisk: boolean;
	readonly totalHunks: number;
}

const SECURITY_KEYWORDS = [
	"auth",
	"token",
	"secret",
	"password",
	"credential",
	"permission",
	"role",
	"access",
	"authorize",
	"authenticate",
	"crypto",
	"encrypt",
	"decrypt",
	"hash",
	"sign",
	"verify",
	"salt",
	"csrf",
	"xss",
	"injection",
	"sanitize",
	"escape",
	"validate",
	"sandbox",
];

const HIGH_RISK_EXTENSIONS = new Set([
	".sql",
	".sh",
	".bash",
	".ps1",
	".tf",
	".hcl",
	".yaml",
	".yml",
	".toml",
]);

function getFilePath(file: ParsedDiffFile): string {
	return file.newPath ?? file.oldPath ?? "(unknown)";
}

function getFileExtension(file: ParsedDiffFile): string {
	const path = getFilePath(file);
	const dotIndex = path.lastIndexOf(".");
	return dotIndex >= 0 ? path.slice(dotIndex).toLowerCase() : "";
}

function scoreSecurityKeywords(text: string): number {
	const lower = text.toLowerCase();
	let count = 0;
	for (const keyword of SECURITY_KEYWORDS) {
		const regex = new RegExp(`\\b${keyword}\\b`, "giu");
		const matches = lower.match(regex);
		if (matches) {
			count += matches.length;
		}
	}
	return count;
}

function scoreHunk(
	file: ParsedDiffFile,
	hunk: ParsedDiffHunk,
	_fileIndex: number,
	_hunkIndex: number,
): number {
	let score = 0;

	const addCount = hunk.lines.filter((l) => l.kind === "add").length;
	const deleteCount = hunk.lines.filter((l) => l.kind === "delete").length;
	score += (addCount + deleteCount) * 0.05;

	const addedLines = hunk.lines.filter((l) => l.kind === "add").map((l) => l.content).join("\n");
	const deletedLines = hunk.lines.filter((l) => l.kind === "delete").map((l) => l.content).join("\n");
	const contextLines = hunk.lines.filter((l) => l.kind === "context").map((l) => l.content).join("\n");

	const securityScore = scoreSecurityKeywords(addedLines + "\n" + deletedLines + "\n" + contextLines);
	score += securityScore * 2;

	const commentPattern = /^\s*\/\/|^\s*#|^\s*--|^\s*\/\*|^\s*\*|^\s*<!--/u;
	const nonCommentLines = hunk.lines.filter(
		(l) => !commentPattern.test(l.content) && l.kind !== "no_newline",
	);
	const nonCommentRatio = hunk.lines.length > 0 ? nonCommentLines.length / hunk.lines.length : 0;
	score += nonCommentRatio * 0.5;

	if (HIGH_RISK_EXTENSIONS.has(getFileExtension(file))) {
		score += 1;
	}

	return score;
}

function formatHunkCompact(hunk: ParsedDiffHunk, _contextLines: number): string {
	const section = hunk.section ? ` ${hunk.section}` : "";
	let result = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${section}\n`;

	let lineCount = 0;
	for (const line of hunk.lines) {
		if (line.kind === "context" && lineCount >= 3) {
			if (result.endsWith("...\n")) continue;
			result += "...\n";
			continue;
		}

		const prefix =
			line.kind === "add"
				? "+"
				: line.kind === "delete"
					? "-"
					: " ";
		result += `${prefix}${line.content}\n`;

		if (line.kind !== "context") {
			lineCount = 0;
		} else {
			lineCount += 1;
		}
	}

	return result;
}

export function estimatePromptTokenCount(text: string): number {
	return estimatePromptTokens(text);
}

export function shouldTriggerCompression(
	tokenEstimate: number,
	model: ModelSpec,
	config: CompressionConfig,
): boolean {
	const modelOverride = config.perModelOverrides?.[`${model.providerKind}:${model.modelId}`];
	const triggerTokens = modelOverride?.triggerTokens ?? config.triggerTokens ?? 131072;

	return tokenEstimate > triggerTokens;
}

export function scoreAndSelectHunks(
	diff: ParsedDiff,
	keepTopK: number,
): ScoredHunk[] {
	const allHunks: ScoredHunk[] = [];

	for (let fi = 0; fi < diff.files.length; fi++) {
		const file = diff.files[fi]!;
		for (let hi = 0; hi < file.hunks.length; hi++) {
			const hunk = file.hunks[hi]!;
			allHunks.push({
				fileIndex: fi,
				hunkIndex: hi,
				score: scoreHunk(file, hunk, fi, hi),
			});
		}
	}

	allHunks.sort((a, b) => b.score - a.score);

	return allHunks.slice(0, keepTopK);
}

export async function generatePerFileSummaries(
	diff: ParsedDiff,
	summarizeModel: ModelSpec,
	summarizeClient: ChatCompletionClient,
	budgetTokenLimit?: number,
): Promise<PerFileSummary[]> {
	const summaries: PerFileSummary[] = [];

	for (let fi = 0; fi < diff.files.length; fi++) {
		const file = diff.files[fi]!;
		const filePath = getFilePath(file);

		const fileDiffText = file.hunks.map((h) => formatHunkCompact(h, 3)).join("");

		if (fileDiffText.trim().length === 0) {
			summaries.push({
				fileIndex: fi,
				filePath,
				summary: `[${file.status}] ${filePath}: empty or binary change.`,
				highRisk: false,
				totalHunks: file.hunks.length,
			});
			continue;
		}

		const prompt = [
			"Analyze this code change and produce a structured summary in JSON format:",
			`File: ${filePath}`,
			`Status: ${file.status}`,
			"",
			"```diff",
			fileDiffText.slice(0, budgetTokenLimit ? budgetTokenLimit * 4 : 8000),
			"```",
			"",
			"Return JSON:",
			'{"impact":"(high|medium|low)","dangers":["(specific risk)","..."],"keyHunks":[0,3,...],"desc":"(one-line summary)","highRisk":(true|false)}',
		].join("\n");

		try {
			const result = await summarizeClient.complete({
				model: summarizeModel,
				messages: [{ role: "user", content: prompt }],
			});

			let parsed: Record<string, unknown> | undefined;
			try {
				const jsonMatch = /\{[\s\S]*\}/u.exec(result.content);
				if (jsonMatch) {
					parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
				}
			} catch {
				parsed = undefined;
			}

			const impact = typeof parsed?.impact === "string" ? parsed.impact : "low";
			const dangers = Array.isArray(parsed?.dangers) ? parsed.dangers.map(String) : [];
			const desc = typeof parsed?.desc === "string" ? parsed.desc : `Changes in ${filePath}`;
			const highRisk = parsed?.highRisk === true || impact === "high";

			summaries.push({
				fileIndex: fi,
				filePath,
				summary: `[${impact.toUpperCase()}] ${desc}${dangers.length > 0 ? ` | Risks: ${dangers.join("; ")}` : ""}`,
				highRisk,
				totalHunks: file.hunks.length,
			});
		} catch {
			summaries.push({
				fileIndex: fi,
				filePath,
				summary: `[${file.status}] ${filePath}: (summary unavailable)`,
				highRisk: false,
				totalHunks: file.hunks.length,
			});
		}
	}

	return summaries;
}

export function buildCompactedDiff(
	diff: ParsedDiff,
	summaries: readonly PerFileSummary[],
	selectedHunks: readonly ScoredHunk[],
	contextLines: number,
): string {
	const selectedSet = new Set(selectedHunks.map((h) => `${h.fileIndex}:${h.hunkIndex}`));
	const lines: string[] = [];

	lines.push("Compressed diff (summaries + selected hunks):\n");

	for (let fi = 0; fi < summaries.length; fi++) {
		const summary = summaries[fi];
		const file = diff.files[fi];
		if (!summary || !file) continue;

		lines.push(`## ${summary.filePath} [${file.status}]`);
		lines.push(`> ${summary.summary}`);
		lines.push("");

		let hunkSelected = false;
		for (let hi = 0; hi < file.hunks.length; hi++) {
			if (selectedSet.has(`${fi}:${hi}`)) {
				const hunk = file.hunks[hi]!;
				lines.push(formatHunkCompact(hunk, contextLines));
				hunkSelected = true;
			}
		}

		if (!hunkSelected && file.hunks.length > 0) {
			lines.push("(no hunks selected for this file)\n");
		}
	}

	return lines.join("\n");
}

export interface CompressDiffOptions {
	readonly diff: ParsedDiff;
	readonly promptText: string;
	readonly model: ModelSpec;
	readonly config: CompressionConfig;
	readonly summarizeModel: ModelSpec;
	readonly summarizeClient: ChatCompletionClient;
}

export async function compressDiff(options: CompressDiffOptions): Promise<CompressionResult> {
	const { diff, promptText, model, config, summarizeModel, summarizeClient } = options;
	const originalTokenEstimate = estimatePromptTokenCount(promptText);

	if (!shouldTriggerCompression(originalTokenEstimate, model, config)) {
		return {
			compressed: false,
			compactDiff: promptText,
			selectedHunks: [],
			originalTokenEstimate,
			compressedTokenEstimate: originalTokenEstimate,
		};
	}

	const keepTopK = config.keepHunksTopK ?? 30;
	const contextLines = config.contextLines ?? 5;
	const maxInputRatio = config.maxInputRatio ?? 0.6;
	const budgetTokenLimit = model.contextWindow
		? Math.floor(model.contextWindow * maxInputRatio * 0.3)
		: undefined;

	const selectedHunks = scoreAndSelectHunks(diff, keepTopK);

	const summaries = await generatePerFileSummaries(
		diff,
		summarizeModel,
		summarizeClient,
		budgetTokenLimit,
	);

	const compactDiff = buildCompactedDiff(diff, summaries, selectedHunks, contextLines);
	const compressedTokenEstimate = estimatePromptTokenCount(compactDiff);

	return {
		compressed: true,
		compactDiff,
		selectedHunks,
		originalTokenEstimate,
		compressedTokenEstimate,
	};
}
