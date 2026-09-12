# Runtime Tool Catalog

Read for less common tool selection or image installation changes. Exact packages,
versions, binaries, architectures and mirrors are defined by `deploy/Dockerfile`;
external verification records live in [shell sources](../../../../docs/ai/sources/shell-and-tooling.md).

## Selection

| Task | Preferred tools |
| --- | --- |
| Text / paths / simple replacement | `rg`, `fd`, `sd`; `ugrep` for compatible flags |
| Read / directory / disk inspection | `bat`, `eza`, `erd`, `tree`, `dust`, `duf` |
| Structured JSON / YAML / tabular data | `jq`, `jaq`, Mike Farah `yq`, `mlr` (miller) |
| Text / structural diffs | `delta`, `difft` |
| Logs / processes / bytes | `lnav -n`, `tspin`, `procs`, `hexyl` |
| HTTP / DNS / downloads | `xh`, `doggo`, `aria2` |
| Archives / compression | `ouch`, `pigz`, `zstd` |
| Benchmarks / filtering / reruns | `hyperfine`, `fzf --filter`, `watchexec` |

Use non-interactive modes, disable paging/color when needed, and bound results.
Read-only review work must not use editing/downloading tools merely because they
exist. Outside the shipped image probe availability; native PowerShell or portable
tools are acceptable fallbacks. Do not install an entire catalog for one task.

## Installation changes

- Prefer the distro package when it supplies the required version; otherwise
  verify official release assets for every supported architecture before changing
  a Dockerfile ARG. Check tag prefixes, archive layout, binary name and glibc/musl
  compatibility. Do not guess a URL from another tool's release pattern.
- Keep Debian command aliases (`fdfind`→`fd`, `batcat`→`bat`) consistent with prompts.
  Debian's Python `yq` and Mike Farah `yq` have different CLIs; this image uses the latter.
- Large optional binaries, absent upstream builds and tools needing a host index
  require an explicit benefit before inclusion. Historical exclusions are tokei,
  qsv and plocate; recheck current size/availability rather than copying old versions.
- Update relevant runtime prompt, user/deployment docs and shell guidance if tool
  guarantees change. Keep freshness and release evidence in the source record,
  not duplicated package-manager tutorials or platform matrices here.
