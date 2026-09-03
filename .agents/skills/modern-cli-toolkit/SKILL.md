---
name: modern-cli-toolkit
description: "Use when: doing shell/terminal work (search, file lookup, text replace, JSON/YAML/CSV parsing, archives, downloads, diffs, logs, benchmarking, Windows PowerShell commands/scripts) or writing/initializing AI agent prompts or skills that recommend shell tools; do not use for pure code edits with no shell work."
user-invocable: false
---

# Modern CLI Toolkit

Use this skill when a task runs shell commands or when writing prompts/skills that recommend shell tools. The goal: prefer modern high-performance CLI tools (mostly Rust/Go, multi-threaded) over traditional Unix tools whenever they exist locally, and fall back to the traditional tool only when the modern one is missing.

## Core rules

1. **Prefer modern, fall back to traditional.** Probe with `command -v <tool>` before relying on a modern tool outside the guaranteed runtime image. Example pairs: `rg` → `grep`, `fd` → `find`, `sd` → `sed`, `bat` → `cat`, `eza` → `ls`, `dust` → `du`, `duf` → `df`, `jq`/`jaq` → ad-hoc JSON parsing, `yq` → ad-hoc YAML parsing, `miller` → `awk` for CSV, `delta`/`difft` → raw `diff`, `xh` → `curl` for API calls, `aria2` → `wget` for large downloads, `pigz`/`zstd` → `gzip`, `hyperfine` → `time`, `procs` → `ps`, `doggo` → `dig`, `ouch` → `tar`/`unzip` guessing, `hexyl` → `xxd`, `lnav -n`/`tspin` → `tail`, `erd` → `tree`.
2. **Prompts and skills must name the modern tools.** When initializing or editing AI agent prompts or skills that involve shell work, instruct agents to prefer these tools explicitly instead of `grep`/`find`/`cat`/`sed`, and state the fallback rule. Only recommend tools the target runtime actually ships (see the guaranteed baseline below).
3. **Guaranteed runtime baseline.** The AICR deployment image (`deploy/Dockerfile`, Debian 13 trixie) ships all of: `rg`, `fd`, `sd`, `bat`, `eza`, `jq`, `yq`, `jaq`, `miller`, `delta`, `difft`, `tree`, `erd`, `dust`, `duf`, `hexyl`, `hyperfine`, `lnav`, `ugrep`, `pigz`, `zstd`, `aria2`, `fzf`, `xh`, `doggo`, `ouch`, `procs`, `watchexec`, `tspin`. Inside that image no `command -v` probe is needed for these; anywhere else, probe first.
4. **Windows hosts use PowerShell 7+.** On Windows, run shell work through `pwsh.exe` (7+), never the legacy Windows PowerShell 5.1 console; spawn fresh processes with `pwsh.exe -NoLogo -NoProfile` and do not nest `cmd.exe`, Git Bash, or WSL unless the task requires it. Prefer modern CLI tools first, native PowerShell syntax (full cmdlet names, no Unix aliases) second. The full Windows rule set lives in `references/powershell-for-agents.md`.

## Agent best practices

- **Keep output clean.** Modern tools auto-disable color and paging when piped. When behavior is inconsistent, force it: `NO_COLOR=1`, `PAGER=cat`, `GIT_PAGER=cat`, or per-command flags (`bat --paging=never --style=plain --color=never`, `eza --color=never --icons=never`, `fd --color=never`, `rg --no-heading --color=never`, `git --no-pager`).
- **Prefer structured output over human layout.** Use machine-readable modes when they exist: `rg --json`, `doggo --json`, `jq -r`, `yq -r`, `mlr --icsv --ojson`, `qsv stats` (if installed). Parse fields, not whitespace-aligned tables.
- **Never block on interaction.** Agent environments have no human at the keyboard: use headless modes (`fzf --filter`, `lnav -n`), cut stdin (`cmd </dev/null`), and pass non-interactive flags (`apt-get install -y`, `git clone --quiet`).
- **Bound output size to protect the context window.** Search/traversal commands can emit hundreds of thousands of lines in large repos: `rg --max-count 50`, `rg --max-filesize 1M`, `rg -g '!node_modules'`, `fd --max-results 100`, `eza --tree --level=2`, `dust -n 20`, and `head -n 200` / `head -c 100000` as the final backstop.
- **Wrap possibly slow commands in `timeout`** (e.g. `timeout 30 rg "pattern" .`) so the agent loop cannot hang.
- **Know exit-code semantics.** `rg`/`grep`/`ugrep` exit `1` on *no match* (not an error) and `2` on real errors; `jq -e` exits `1` when the result is empty/false; `hyperfine` exits non-zero when the benchmarked command fails. Branch on `0|1|2` explicitly instead of treating non-zero as failure.

## Detailed reference

- `references/tool-catalog.md`: full cross-platform modern-tool catalog (distro repositories, GitHub static binaries, no-compile install channels), per-platform install commands, the AICR runtime image tool matrix with verified availability and exclusions, and the traditional→modern cheat sheet.
- `references/powershell-for-agents.md`: PowerShell 7+ rules for Windows hosts — shell selection (never 5.1), edition differences verified empirically, quoting/here-strings, piping statement blocks, native exit codes and argument passing, encoding pitfalls, and failure triage.
