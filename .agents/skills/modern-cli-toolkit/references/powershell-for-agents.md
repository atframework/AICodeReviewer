# PowerShell for Agents

Read for Windows scripts, native arguments, encoding, or launcher/SSH failures.
Use PowerShell 7+ (`pwsh.exe -NoLogo -NoProfile`), not Windows PowerShell 5.1.

## Commands and text

- Probe with `Get-Command`; use full cmdlet names instead of ambiguous Unix aliases.
  Search with `rg -g '<pattern>' <expression> <directory>`: PowerShell does not
  expand native-command path globs. Use `-LiteralPath` for filesystem paths.
- Single quotes are literal; double quotes expand `$` and backticks. Prefer a
  script under `build/tmp/` for multiline Node/SSH/PowerShell operations. Use
  literal here-strings for generated text and argument arrays for native commands;
  never `Invoke-Expression`. Do not nest shells merely to work around quoting.
- PowerShell 7 supports `&&`/`||`; 5.1 rejects them. Commands inside SSH strings
  follow the remote shell's syntax, after local quoting. Avoid accidental local
  expansion of remote `$()`/variables; transfer a script when necessary.
- Pipelines carry objects. `Select-String` exposes `.Line`; wrap statement blocks
  as `& { ... } | ...`. Pass an explicit depth to `ConvertTo-Json`.
- Write UTF-8 without BOM (`Set-Content -Encoding utf8` in 7+). Do not round-trip
  source or remote env files through 5.1's ANSI reads/UTF-16 redirects.
- Node helpers: resolve transitive packages from the owning package's real path
  under pnpm. Pass filesystem paths to dynamic `import()` through `pathToFileURL`;
  a Windows drive-letter path is not an ESM URL.

## Exit status and failure boundaries

- Check `$LASTEXITCODE` after native tools; append `exit $LASTEXITCODE` when a
  wrapper must preserve it. `$ErrorActionPreference` alone does not turn all
  native failures into exceptions. Capture bounded output under `build/logs/`.
- Inspect command, resolved path, quoting and error code before retrying. A
  `CreateProcessAsUserW` access-denied error can occur before PowerShell starts,
  particularly through a WindowsApps alias. Keep PowerShell 7 and use the
  supported permission escalation for the exact check; changing product code or
  reverting to 5.1 does not fix that launcher boundary.
- A Vite/esbuild `spawn EPERM` before collection needs permitted child spawning.
  Fixture-path `EPERM` needs access to the actual fixture location. Preserve logs
  and rerun the exact gate; neither case proves test failure or a passing suite.
- If `.ps1` shims are blocked, use the Node CLI entrypoints in
  [the baseline](../../../../docs/ai/AGENTS.repository-baseline.md). Build's explicit
  `cmd /c` wrapper is a documented exception. Do not claim a diagnostic direct
  equivalent passed the package-script gate unless the whole gate executed.

For changes to these rules, refresh the Microsoft references in
[shell sources](../../../../docs/ai/sources/shell-and-tooling.md).
