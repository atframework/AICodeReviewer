# Shell and Runtime Tooling Sources

Read only the record for the external contract being changed. Dates describe the
last evidence check, not guaranteed current behavior. Retained records were not
revalidated by the 2026-09-12 layout change unless explicitly marked below.

## Modern CLI tool availability and release artifacts

- Sources:
  - <https://packages.ubuntu.com/> (suite `noble` package searches; pre-trixie baseline)
  - Live `apt-cache policy` / `apt-cache show` inside `debian:trixie-slim` via WSL podman (2026-09-03; default `debian.sources` deb822, `Components: main` only)
  - <https://package.perforce.com/apt/ubuntu/dists/> (directory listing)
  - GitHub Releases API `repos/<owner>/<repo>/releases/latest` for `bootandy/dust`, `XAMPPRocky/tokei`, `ducaale/xh`, `mr-karan/doggo`, `01mf02/jaq`, `Wilfred/difftastic`, `ouch-org/ouch`, `dalance/procs`, `watchexec/watchexec`, `bensadeh/tailspin`, `solidiquis/erdtree`, `dathere/qsv`
- Evidence: The dated Debian/release checks establish image package availability, architecture/asset layouts, Perforce distribution and mirror constraints. Exact installed versions now come from deploy/Dockerfile. Recheck packages and official assets on changes instead of copying a cross-distro tutorial.
- `last_checked`: 2026-09-03
- `next_review`: 2026-12-03
- `update_trigger`: Re-check when bumping the pinned `*_VERSION` args in `deploy/Dockerfile`, when the distro base changes, or when adding/removing a tool in the runtime image baseline.

## PowerShell 7+ behavior for Windows shell work

- Sources:
  - <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh>
  - <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules>
  - <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing>
  - <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables>
  - Empirical probes on 2026-09-03 against PowerShell 7.6.5 and Windows PowerShell 5.1 on the maintainer host.
- Evidence: PowerShell 7 has different encoding/argument semantics from 5.1. Use literal quoting, explicit native exit handling and UTF-8. Keep detailed shell procedures in the PowerShell reference; a past host probe is not a universal environment guarantee.
- `last_checked`: 2026-09-03
- `next_review`: 2026-12-03
- `update_trigger`: Re-check when updating Windows shell guidance in `AGENTS.md` or `.agents/skills/modern-cli-toolkit/references/powershell-for-agents.md`, when the minimum supported PowerShell version changes, or when Microsoft revises `$PSNativeCommandArgumentPassing` defaults.

## PowerShell pipeline chains

- Source: <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pipeline_chain_operators>
- Evidence: PowerShell 7 supports && and ||; the blanket prohibition in older deployment guidance applied to 5.1. Local quoting still precedes remote-shell parsing.
- `last_checked`: 2026-09-12
- `next_review`: 2026-12-12
- `update_trigger`: Windows shell selection or SSH quoting guidance changes.

## Node helpers on Windows

- Sources:
  - <https://nodejs.org/api/esm.html#urls>
  - <https://nodejs.org/api/module.html#modulecreaterequirefilename>
- Evidence: ESM resolves URLs; convert filesystem paths with pathToFileURL. createRequire anchors package lookup to its supplied filename; in this pnpm checkout the owning package's real path resolves its transitive dependencies.
- `last_checked`: 2026-09-12
- `next_review`: 2026-12-12
- `update_trigger`: Windows Node helper imports or pnpm dependency-resolution guidance changes.
