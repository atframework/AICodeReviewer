---
name: modern-cli-toolkit
description: "Choose and run shell tools, including PowerShell quoting and structured inspection; skip tasks with no terminal work."
user-invocable: false
---

# Modern CLI Toolkit

- Prefer `rg` for text, `fd` for files, `bat --paging=never --style=plain` for
  reading, `sd` for simple replacements, `jq` for JSON, Mike Farah `yq` for YAML,
  and `mlr` for CSV. Use native PowerShell when it fits; portable tools are
  fallbacks when the preferred tool is absent or exact portability is required.
- Outside the shipped review image, probe with `Get-Command` on Windows or
  `command -v` on POSIX. WSL and developer hosts have their own tool baselines.
- Keep commands non-interactive, output bounded, and formats machine-readable.
  Search filenames/headings before reading large files. `rg` exit 1 means no
  match; inspect other nonzero exits before changing approach.
- On Windows use PowerShell 7+ with no profile. Pass path globs through tool
  flags such as `rg -g`, since PowerShell does not expand native-command globs.
  Read [PowerShell rules](references/powershell-for-agents.md) for scripts,
  quoting, encoding, launcher failures, or SSH commands.
- Read [the tool catalog](references/tool-catalog.md) only for less common tools
  or runtime-image installation work. Check `deploy/Dockerfile` before changing
  any promised tool availability; do not install tools merely to follow a list.
