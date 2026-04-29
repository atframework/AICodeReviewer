export function parseAllowedCommand(
  raw: readonly string[],
  allowed: ReadonlySet<string>,
): { command: string; args: string[] } {
  if (raw.length === 0) {
    throw new TypeError("Spawn command must not be empty.");
  }

  const command = raw[0];
  if (command === undefined || !allowed.has(command)) {
    throw new TypeError(
      `Command "${command ?? "(empty)"}" is not in the allowed list: ${[...allowed].join(", ")}.`,
    );
  }

  return { command, args: raw.slice(1) as string[] };
}