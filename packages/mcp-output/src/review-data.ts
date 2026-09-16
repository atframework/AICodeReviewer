import { z } from "zod";

export const reviewCommitsShape = {
  detail: z.enum(["ids", "files", "diffs", "summary"]).default("ids"),
  include_authors: z.boolean().default(false),
  include_repositories: z.boolean().default(false),
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  max_bytes: z.number().int().min(1024).max(1_048_576).default(200_000),
};
export const reviewCommitsSchema = z.object(reviewCommitsShape).strict();
export const reviewContextSchema = z.object({}).strict();
export const reviewCommitsInputSchema = {
  type: "object", additionalProperties: false,
  properties: {
    detail: { type: "string", enum: ["ids", "files", "diffs", "summary"], default: "ids" },
    include_authors: { type: "boolean", default: false },
    include_repositories: { type: "boolean", default: false },
    cursor: { type: "string", minLength: 1, maxLength: 4096 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    max_bytes: { type: "integer", minimum: 1024, maximum: 1_048_576, default: 200_000 },
  },
} as const;
export type ReviewCommitsInput = z.infer<typeof reviewCommitsSchema>;
export type ReviewDataRequest =
  | { readonly name: "aicr.get_review_commits"; readonly input: ReviewCommitsInput }
  | { readonly name: "aicr.get_review_context"; readonly input: Record<string, never> };
export type ReviewDataHandler = (request: ReviewDataRequest) => Promise<Readonly<Record<string, unknown>>>;

export const reviewDataDescriptions = {
  "aicr.get_review_commits": "Query the current review's pinned commits/revisions: IDs, per-commit files, full per-commit patches, or a union of changed files. Author and source/target metadata are opt-in. Follow next_cursor; never infer missing metadata.",
  "aicr.get_review_context": "Get the current review's base/head, provider, target kind, source/target repositories and branches, and effective reviewed files. Use this to verify scope after prompt compression or before requesting more context.",
} as const;

export function parseReviewDataRequest(name: ReviewDataRequest["name"], input: unknown): ReviewDataRequest {
  return name === "aicr.get_review_commits"
    ? { name, input: reviewCommitsSchema.parse(input) }
    : { name, input: reviewContextSchema.parse(input) };
}
