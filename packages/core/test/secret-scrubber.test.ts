import { describe, expect, it } from "vitest";

import { scrubDiff, scrubPromptMessages, scrubText } from "../src/secret-scrubber.js";

describe("secret-scrubber", () => {
	describe("scrubText", () => {
		it("redacts AWS access key IDs", () => {
			const result = scrubText('env AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"');
			expect(result.text).toContain("<REDACTED:AWS_KEY>");
			expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
			expect(result.findings.some((f) => f.kind === "aws_key")).toBe(true);
		});

		it("redacts AWS secret access keys", () => {
			const result = scrubText(
				'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
			);
			expect(result.text).toContain("<REDACTED:AWS_KEY>");
			expect(result.findings.some((f) => f.kind === "aws_key")).toBe(true);
		});

		it("redacts private key PEM headers", () => {
			const result = scrubText("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...");
			expect(result.text).toContain("<REDACTED:PRIVATE_KEY>");
			expect(result.findings.some((f) => f.kind === "private_key")).toBe(true);
		});

		it("redacts JWT tokens", () => {
			const result = scrubText(
				'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
			);
			expect(result.text).toContain("<REDACTED:JWT>");
			expect(result.text).not.toContain("eyJhbGciOi");
			expect(result.findings.some((f) => f.kind === "jwt")).toBe(true);
		});

		it("redacts GitHub personal access tokens (ghp_)", () => {
			const result = scrubText(
				'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz01234567890123',
			);
			expect(result.text).toContain("<REDACTED:GITHUB_TOKEN>");
			expect(result.text).not.toContain("ghp_");
			expect(result.findings.some((f) => f.kind === "github_token")).toBe(true);
		});

		it("redacts GitHub fine-grained tokens (github_pat_)", () => {
			const result = scrubText(
				'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz',
			);
			expect(result.text).toContain("<REDACTED:GITHUB_TOKEN>");
			expect(result.text).not.toContain("github_pat_");
		});

		it("redacts GitLab tokens", () => {
			const result = scrubText(
				"GITLAB_TOKEN=glpat-abcdefghijklmnopqrstuvwxyz12",
			);
			expect(result.text).toContain("<REDACTED:GITLAB_TOKEN>");
			expect(result.text).not.toContain("glpat-");
		});

		it("redacts Slack bot tokens", () => {
			const result = scrubText(
				"xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx",
			);
			expect(result.text).toContain("<REDACTED:SLACK_TOKEN>");
			expect(result.text).not.toContain("xoxb-");
		});

		it("redacts connection strings", () => {
			const result = scrubText(
				'db = "mongodb://admin:secret@localhost:27017/mydb"',
			);
			expect(result.text).toContain("<REDACTED:CONNECTION_STRING>");
			expect(result.text).not.toContain("mongodb://");
			expect(result.findings.some((f) => f.kind === "connection_string")).toBe(true);
		});

		it("redacts postgres connection strings", () => {
			const result = scrubText(
				"postgresql://user:pass@host:5432/db",
			);
			expect(result.text).toContain("<REDACTED:CONNECTION_STRING>");
			expect(result.text).not.toContain("postgresql://");
		});

		it("redacts generic API keys", () => {
			const result = scrubText(
				'api_key = "sk-abcdefghijklmnopqrstuvwxyz0123456789"',
			);
			expect(result.text).toContain("<REDACTED:GENERIC_API_KEY>");
			expect(result.text).not.toContain("sk-abcdefghij");
			expect(result.findings.some((f) => f.kind === "generic_api_key")).toBe(true);
		});

		it("redacts OAuth tokens", () => {
			const result = scrubText(
				"ya29.a0AfH6SMAbcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456",
			);
			expect(result.text).toContain("<REDACTED:OAUTH_TOKEN>");
			expect(result.text).not.toContain("ya29.");
		});

		it("redacts Basic auth headers", () => {
			const result = scrubText(
				"Authorization: Basic dXNlcjpwYXNzd29yZA==",
			);
			expect(result.text).toContain("<REDACTED:BASIC_AUTH>");
			expect(result.text).not.toContain("Basic dXNlcjpwYXNzd29yZA==");
		});

		it("detects high-entropy base64-like strings", () => {
			const result = scrubText(
				'dGVzdHNlY3JldGtleWZvcmVudHJvcHlzY2FubmluZ3Rlc3RzZWNyZXRrZXk=',
			);
			expect(result.text).toContain("<REDACTED:HIGH_ENTROPY>");
			expect(result.findings.some((f) => f.kind === "high_entropy")).toBe(true);
		});

		it("does not flag low-entropy long strings", () => {
			const result = scrubText(
				"The quick brown fox jumps over the lazy dog. This is a normal sentence without any secrets.",
			);
			expect(result.findings.filter((f) => f.kind === "high_entropy")).toHaveLength(0);
		});

		it("redacts sensitive key-value pairs", () => {
			const result = scrubText(
				'const password = "mySuperSecretValue123456"',
			);
			expect(result.text).toContain("<REDACTED:KEY_VALUE_PAIR>");
			expect(result.findings.some((f) => f.kind === "key_value_pair")).toBe(true);
		});

		it("redacts apiKey key-value pairs", () => {
			const result = scrubText(
				'const apiKey = "abcdefghijklmnopqrstuvwxyz"',
			);
			expect(result.text).toContain("<REDACTED:GENERIC_API_KEY>");
		});

		it("redacts secret key-value pairs", () => {
			const result = scrubText(
				'secret = "abcdefghijklmnopqrstuvwxyz"',
			);
			expect(result.text).toContain("<REDACTED:GENERIC_API_KEY>");
		});

		it("does not redact non-sensitive key-value pairs", () => {
			const result = scrubText(
				'const message = "Hello World! This is a normal message"',
			);
			expect(result.findings.filter((f) => f.kind === "key_value_pair")).toHaveLength(0);
		});

		it("reports correct line numbers in findings", () => {
			const result = scrubText(
				"line one\nline two\nAPI_KEY=sk-abcdefghijklmnopqrstuvwxyz\nline four",
			);
			const apiFinding = result.findings.find((f) => f.kind === "generic_api_key");
			expect(apiFinding).toBeDefined();
			expect(apiFinding!.line).toBe(2);
		});

		it("returns empty findings for clean text", () => {
			const result = scrubText(
				"function hello() {\n  return 'world';\n}\n",
			);
			expect(result.findings).toHaveLength(0);
			expect(result.text).toBe(
				"function hello() {\n  return 'world';\n}\n",
			);
		});

		it("handles empty input", () => {
			const result = scrubText("");
			expect(result.text).toBe("");
			expect(result.findings).toHaveLength(0);
		});
	});

	describe("scrubDiff", () => {
		it("scrubs secrets in diff content", () => {
			const diffContent =
				'+ const password = "secret_value_1234567890"\n+ AKIAIOSFODNN7EXAMPLE\n';
			const result = scrubDiff(diffContent);
			expect(result.text).toContain("<REDACTED:KEY_VALUE_PAIR>");
			expect(result.text).toContain("<REDACTED:AWS_KEY>");
		});
	});

	describe("scrubPromptMessages", () => {
		it("scrubs all messages in a conversation", () => {
			const messages = [
				{ role: "system", content: "You are a code reviewer." },
				{
					role: "user",
					content: "Review this code: AKIAIOSFODNN7EXAMPLE",
				},
			];
			const result = scrubPromptMessages(messages);
			expect(result.messages[0]!.content).toBe("You are a code reviewer.");
			expect(result.messages[1]!.content).toContain("<REDACTED:AWS_KEY>");
			expect(result.messages[1]!.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
			expect(result.findings.length).toBeGreaterThan(0);
		});

		it("returns all findings across messages", () => {
			const messages = [
				{ role: "user", content: "AKIAIOSFODNN7EXAMPLE" },
				{ role: "user", content: "ghp_abcdefghijklmnopqrstuvwxyz01234567890123" },
			];
			const result = scrubPromptMessages(messages);
			expect(result.findings.some((f) => f.kind === "aws_key")).toBe(true);
			expect(result.findings.some((f) => f.kind === "github_token")).toBe(true);
		});
	});
});
