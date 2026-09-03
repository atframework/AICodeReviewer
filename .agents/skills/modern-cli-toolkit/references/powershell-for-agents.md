# PowerShell for AI Agents

Rules for shell work on Windows hosts. Behaviors below were verified
empirically on 2026-09-03 against PowerShell 7.6.5 (`pwsh.exe`) and Windows
PowerShell 5.1 (`powershell.exe`) on the repository maintainer host, and
against the Microsoft Learn `about_*` topics listed in
`docs/ai/source-index.md` (record "PowerShell 7+ behavior for Windows shell
work").

## Shell selection

- Use the latest PowerShell 7+ (`pwsh.exe`) for every shell task. Never target
  the legacy Windows PowerShell 5.1 console (`powershell.exe`):
  - 5.1 rejects `&&`/`||` at parse time — the whole script fails, not just the
    line.
  - 5.1 aliases `curl`/`wget` to `Invoke-WebRequest`; 7+ resolves `curl` to
    `curl.exe` and has no `wget` alias.
  - 5.1 `>`/`Out-File` output is UTF-16LE; 7+ writes UTF-8 without BOM.
  - 5.1 always uses Legacy native-argument passing, which mangles embedded
    quotes and empty strings; 7+ defaults
    `$PSNativeCommandArgumentPassing` to `Windows`.
  - On hosts where 5.1 blocks scripts by execution policy, `pwsh.exe` 7.x can
    still run them; the `node`-direct CLI workaround in `AGENTS.md` is
    edition-independent and stays valid either way.
- The harness shell may still be 5.1 even when 7+ is installed; prefix
  non-trivial commands with `pwsh.exe` explicitly instead of relying on the
  default shell.
- Spawn fresh processes with `pwsh.exe -NoLogo -NoProfile` so user profiles
  cannot inject commands, redefine aliases, or slow startup.
- Use `-File <script.ps1>` for multi-step work (write the script under
  `build/tmp/`) and `-Command` for one-liners.
- `pwsh -Command` collapses a native command's non-zero exit code to `1`
  unless the command text ends with `exit $LASTEXITCODE`. Append it whenever
  the caller branches on the native exit code.
- Do not nest `cmd.exe`, Git Bash, or WSL shells unless the task explicitly
  requires them; each extra layer re-interprets quoting, backslashes, and
  `$` variables.

## Modern tools first, PowerShell second

- Prefer modern CLI tools (`rg`, `fd`, `bat`, `jq`, ...) per
  `references/tool-catalog.md`; probe with
  `Get-Command <name> -ErrorAction SilentlyContinue` (the `command -v`
  equivalent) when the host is not the guaranteed runtime image.
- When no modern tool fits, use native PowerShell syntax with full cmdlet
  names. Do not use Unix aliases or ambiguous short names; several resolve to
  different things across editions or clash with Windows programs:

  | Name | Likely intent | What it can resolve to |
  | ---- | ------------- | ---------------------- |
  | `cat` | file contents | `Get-Content` alias (streams lines; ANSI decode in 5.1) |
  | `curl` | HTTP client | 5.1: `Invoke-WebRequest` alias; 7+: `curl.exe` |
  | `wget` | download | 5.1: `Invoke-WebRequest` alias; 7+: absent |
  | `find` | locate files | `find.exe` (line filter, not a file finder) |
  | `where` | filter objects | `Where-Object` alias, or `where.exe` |
  | `ps` | process list | `Get-Process` alias (shadows the real `procs` binary) |
  | `sort` | sort lines | `Sort-Object` alias / `sort.exe` |
  | `diff` | file diff | `Compare-Object` alias |
  | `ls` / `dir` | list files | `Get-ChildItem` alias (objects, not text) |
  | `rm` / `cp` / `mv` | file ops | `Remove-Item` / `Copy-Item` / `Move-Item` aliases |

## Quoting and strings

- Single quotes are literal; double quotes expand `$var` and backtick escapes.
  Default to single quotes.
- Use `${name}` when adjacent characters make the variable boundary ambiguous
  (`"${name}_suffix"`).
- The escape character is the backtick (`` `n `t `" `$ ``), and only inside
  double quotes; a backslash is always literal.
- Multiline text: here-strings (`@" ... "@` expanding, `@' ... '@` literal)
  with the closing marker at the start of its line. PowerShell has no Bash
  heredoc (`<<`).
- Avoid backtick line continuation: one trailing space after the backtick
  silently turns it into a string escape. Break lines after `|`, `(`, or `,`
  instead.
- For native commands with many arguments, splat an array:
  `$argv = @('clone', '--depth', '1', $url); & git @argv`.
- The outer shell expands `$` inside double-quoted inline commands before the
  inner shell sees them. For anything past a trivial one-liner, write a script
  file under `build/tmp/` instead of stacking quote layers.

## Pipelines and statements

- The pipeline carries objects, not text. `Select-String` returns
  `MatchInfo` objects — read `.Line` (and `.Matches`) instead of treating the
  output as plain strings.
- To pipe the output of statement blocks (`foreach`, `if`, `try`), wrap them:
  `& { foreach ($i in 1..3) { $i } } | ForEach-Object { ... }`. `$(...)`
  captures the same output as a value; `@(...)` forces an array.
- `ForEach-Object -Parallel` (7+) parallelizes pipeline work; guard shared
  state and throttle with `-ThrottleLimit`.
- `Tee-Object` writes a copy to a file without breaking the pipeline.

## Native commands and exit codes

- Check `$LASTEXITCODE` for native commands. `$?` only reports the last
  operation's success, and `$ErrorActionPreference` never applies to native
  commands; on 7.3+ `$PSNativeCommandUseErrorActionPreference = $true` makes
  non-zero exits raise pipeline errors.
- `$PSNativeCommandArgumentPassing` is `Windows` by default on 7.x and absent
  on 5.1 (always Legacy). In `Windows` mode, `cmd.exe` and `.bat`/`.cmd`
  still get Legacy passing; set it to `Standard` when a non-cmd native call
  mangles quoting, and verify against the actual edition and target program.
- `2>&1` on a native command wraps stderr lines in `ErrorRecord` objects,
  which breaks string parsing and can throw under
  `$ErrorActionPreference = 'Stop'`. Redirect to a file (`*> out.log`) or cast
  explicitly when you must merge streams.
- Probe tool availability with
  `Get-Command rg -ErrorAction SilentlyContinue`; never parse `--help` text
  to detect features.

## Files, JSON, and encoding

- Build paths with `Join-Path`, test with `Test-Path`, and anchor scripts
  with `$PSScriptRoot`; use `-LiteralPath` whenever a path may contain `[` or
  `]` (the `-Path` parameter treats them as wildcards).
- `Get-Content -Raw` reads a whole file; `Get-Content -TotalCount 200` is the
  `head` equivalent. Create directories idempotently with
  `New-Item -ItemType Directory -Force`.
- Parse JSON with `ConvertFrom-Json` and emit it with `ConvertTo-Json`; never
  regex-parse JSON. `ConvertTo-Json` truncates nesting past depth 2 with only
  a warning — pass `-Depth` explicitly.
- Encoding differs by edition: 5.1 `>`/`Out-File` produce UTF-16LE, 7+
  produces UTF-8 without BOM. Pass `-Encoding utf8` explicitly when the file
  crosses tool boundaries (see `docs/ai/AGENTS.known-pitfalls.md` entry 39).
- Environment variables: `$env:NAME`;
  `[Environment]::GetEnvironmentVariable('<name>', 'User'|'Machine')` for the
  other scopes.

## Error handling and failure triage

- Set `$ErrorActionPreference = 'Stop'` at the top of scripts so cmdlet
  failures throw; catch with `try`/`catch` and read `$_` / `$Error[0]`.
- Never use `Invoke-Expression` on composed or untrusted strings.
- When a command fails, check in order: command existence (`Get-Command`),
  path, quoting, and `$LASTEXITCODE` / `$Error[0]`. Do not switch shells or
  rewrite the approach before identifying which of these failed.
