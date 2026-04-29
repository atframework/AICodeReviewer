import { normalizePath } from "@aicr/core";

export type ParsedDiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

export type ParsedDiffLineKind = "context" | "add" | "delete" | "no_newline";

export interface ParsedDiffLine {
  readonly kind: ParsedDiffLineKind;
  readonly content: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface ParsedDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly section?: string;
  readonly lines: readonly ParsedDiffLine[];
}

export interface ParsedDiffFile {
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly status: ParsedDiffFileStatus;
  readonly rawHeaders: readonly string[];
  readonly hunks: readonly ParsedDiffHunk[];
}

export interface ParsedDiff {
  readonly files: readonly ParsedDiffFile[];
}

interface MutableDiffFile {
  oldPath?: string;
  newPath?: string;
  status: ParsedDiffFileStatus;
  rawHeaders: string[];
  hunks: MutableDiffHunk[];
}

interface MutableDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section?: string;
  lines: ParsedDiffLine[];
}

const diffGitPrefix = "diff --git ";
const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s?(.*))?$/u;

function stripQuotedPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  return trimmed;
}

function parsePatchPath(value: string): string | undefined {
  const stripped = stripQuotedPath(value);
  if (stripped === "/dev/null") {
    return undefined;
  }

  return normalizePath(stripped.replace(/^[ab]\//u, ""));
}

function splitDiffGitPaths(line: string): { oldPath?: string; newPath?: string } {
  const body = line.slice(diffGitPrefix.length);
  const separatorIndex = body.indexOf(" b/");
  if (separatorIndex < 0) {
    return {};
  }
  const oldPath = parsePatchPath(body.slice(0, separatorIndex));
  const newPath = parsePatchPath(body.slice(separatorIndex + 1));

  return {
    ...(oldPath ? { oldPath } : {}),
    ...(newPath ? { newPath } : {}),
  };
}

function inferStatus(file: MutableDiffFile): ParsedDiffFileStatus {
  if (file.status !== "modified") {
    return file.status;
  }

  if (!file.oldPath && file.newPath) {
    return "added";
  }

  if (file.oldPath && !file.newPath) {
    return "deleted";
  }

  if (file.oldPath && file.newPath && file.oldPath !== file.newPath) {
    return "renamed";
  }

  return "modified";
}

function freezeFile(file: MutableDiffFile): ParsedDiffFile {
  const result = {
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    ...(file.newPath ? { newPath: file.newPath } : {}),
    status: inferStatus(file),
    rawHeaders: [...file.rawHeaders],
    hunks: file.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      ...(hunk.section ? { section: hunk.section } : {}),
      lines: [...hunk.lines],
    })),
  };

  return result;
}

function startFile(line: string): MutableDiffFile {
  const paths = splitDiffGitPaths(line);
  return {
    ...(paths.oldPath ? { oldPath: paths.oldPath } : {}),
    ...(paths.newPath ? { newPath: paths.newPath } : {}),
    status: "modified",
    rawHeaders: [line],
    hunks: [],
  };
}

function appendHeader(file: MutableDiffFile, line: string): void {
  file.rawHeaders.push(line);

  if (line === "new file mode" || line.startsWith("new file mode ")) {
    file.status = "added";
    return;
  }

  if (line === "deleted file mode" || line.startsWith("deleted file mode ")) {
    file.status = "deleted";
    return;
  }

  if (line.startsWith("rename from ")) {
    file.status = "renamed";
    file.oldPath = normalizePath(line.slice("rename from ".length));
    return;
  }

  if (line.startsWith("rename to ")) {
    file.status = "renamed";
    file.newPath = normalizePath(line.slice("rename to ".length));
    return;
  }

  if (line.startsWith("copy from ")) {
    file.status = "copied";
    file.oldPath = normalizePath(line.slice("copy from ".length));
    return;
  }

  if (line.startsWith("copy to ")) {
    file.status = "copied";
    file.newPath = normalizePath(line.slice("copy to ".length));
    return;
  }

  if (line.startsWith("--- ")) {
    const oldPath = parsePatchPath(line.slice(4));
    if (oldPath) {
      file.oldPath = oldPath;
    } else {
      delete file.oldPath;
    }
    return;
  }

  if (line.startsWith("+++ ")) {
    const newPath = parsePatchPath(line.slice(4));
    if (newPath) {
      file.newPath = newPath;
    } else {
      delete file.newPath;
    }
  }
}

function parseHunkHeader(line: string): MutableDiffHunk | undefined {
  const match = hunkHeaderPattern.exec(line);
  if (!match) {
    return undefined;
  }

  const oldStart = Number.parseInt(match[1]!, 10);
  const oldLines = match[2] ? Number.parseInt(match[2], 10) : 1;
  const newStart = Number.parseInt(match[3]!, 10);
  const newLines = match[4] ? Number.parseInt(match[4], 10) : 1;
  const section = match[5]?.trim();

  return {
    oldStart,
    oldLines,
    newStart,
    newLines,
    ...(section ? { section } : {}),
    lines: [],
  };
}

export function parseUnifiedDiff(patch: string): ParsedDiff {
  const normalizedPatch = patch.replace(/\r\n/gu, "\n");
  const lines = normalizedPatch.endsWith("\n")
    ? normalizedPatch.slice(0, -1).split("\n")
    : normalizedPatch.split("\n");
  const files: ParsedDiffFile[] = [];
  let currentFile: MutableDiffFile | undefined;
  let currentHunk: MutableDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith(diffGitPrefix)) {
      if (currentFile) {
        files.push(freezeFile(currentFile));
      }
      currentFile = startFile(line);
      currentHunk = undefined;
      continue;
    }

    if (!currentFile && line.startsWith("--- ")) {
      const oldPath = parsePatchPath(line.slice(4));
      currentFile = {
        ...(oldPath ? { oldPath } : {}),
        status: "modified",
        rawHeaders: [line],
        hunks: [],
      };
      currentHunk = undefined;
      continue;
    }

    if (!currentFile) {
      continue;
    }

    const parsedHunk = parseHunkHeader(line);
    if (parsedHunk) {
      currentFile.hunks.push(parsedHunk);
      currentHunk = parsedHunk;
      oldLine = parsedHunk.oldStart;
      newLine = parsedHunk.newStart;
      continue;
    }

    if (!currentHunk) {
      appendHeader(currentFile, line);
      continue;
    }

    if (line.startsWith("\\ No newline at end of file")) {
      currentHunk.lines.push({ kind: "no_newline", content: line });
      continue;
    }

    const marker = line[0];
    const content = line.slice(1);
    if (marker === "+") {
      currentHunk.lines.push({ kind: "add", content, newLine });
      newLine += 1;
    } else if (marker === "-") {
      currentHunk.lines.push({ kind: "delete", content, oldLine });
      oldLine += 1;
    } else {
      const contextContent = marker === " " ? content : line;
      currentHunk.lines.push({ kind: "context", content: contextContent, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  if (currentFile) {
    files.push(freezeFile(currentFile));
  }

  return { files };
}

export function changedFilesFromDiff(diff: ParsedDiff): string[] {
  return Array.from(
    new Set(diff.files.flatMap((file) => [file.newPath, file.oldPath].filter((path): path is string => Boolean(path)))),
  );
}
