# Modern CLI Tool Catalog

Selection criteria for this catalog:

1. **Pure CLI, non-interactive**: output can be captured and parsed through pipes; no TUI/terminal-emulator tools.
2. **No local compilation**: installable from mainstream package managers (Linux apt/dnf/pacman incl. EPEL, macOS Homebrew, Windows winget/Scoop) or as official single-file static binaries from GitHub Releases (Linux/macOS/Windows).
3. **Performance**: mostly Rust/Go implementations, multi-threaded, low latency; typically an order of magnitude faster than the traditional equivalent on large repos/files.

## 1. Distro repository installs (first choice)

These tools are in mainstream distro repositories; one `apt` / `dnf` / `pacman` command installs them.

| Tool | Replaces | Debian/Ubuntu | Fedora | Arch | Notes |
| --- | --- | --- | --- | --- | --- |
| **ripgrep (rg)** | grep | `ripgrep` | `ripgrep` | `ripgrep` | Multi-threaded search; skips .gitignore/hidden/binary files |
| **fd** | find | `fd-find` (cmd `fdfind`) | `fd-find` | `fd` | Simple syntax, multi-threaded, respects .gitignore |
| **bat** | cat | `bat` (cmd `batcat`) | `bat` | `bat` | Syntax highlighting; `--paging=never` for pure output |
| **dust** | du | `du-dust` (Debian trixie+; not Ubuntu 24.04) | `dust` | `dust` | Multi-threaded disk usage, sorted by size |
| **duf** | df | `duf` | `duf` | `duf` | Tabular disk-free report |
| **hyperfine** | time | `hyperfine` | `hyperfine` | `hyperfine` | Benchmarking with variance statistics |
| **tokei** | cloc | `tokei` (Debian trixie+; not Ubuntu 24.04) | `tokei` | `tokei` | Fast code line counter |
| **hexyl** | xxd/hexdump | `hexyl` | `hexyl` | `hexyl` | Colored hex viewer |
| **jq** | python -m json.tool | `jq` | `jq` | `jq` | JSON processing standard |
| **miller (mlr)** | awk (CSV) | `miller` | `miller` | `miller` | CSV/TSV/JSON column slicing, filtering, stats |
| **git-delta** | diff pager | `git-delta` | `git-delta` | `git-delta` | Prettier git diff; activated via gitconfig |
| **lnav** | tail/less (logs) | `lnav` | `lnav` | `lnav` | Log analysis; `lnav -n` headless mode supports SQL |
| **ugrep** | grep (compatible) | `ugrep` | `ugrep` | `ugrep` | grep-compatible flags; drop-in for existing scripts |
| **plocate** | locate/mlocate | `plocate` | `plocate` | `plocate` | Smaller index, faster queries; needs an `updatedb` index, so it is useless in containers that never build one |
| **pigz** | gzip | `pigz` | `pigz` | `pigz` | Multi-core parallel gzip, flag-compatible |
| **zstd** | gzip/bzip2 | `zstd` | `zstd` | `zstd` | Faster modern compression with better ratio |
| **aria2** | wget | `aria2` | `aria2` | `aria2` | Multi-threaded download, resume, BT/magnet |
| **fzf** | — | `fzf` | `fzf` | `fzf` | Fuzzy finder; `--filter` works non-interactively |
| **sd** | sed | `sd` (Ubuntu 24.04+/Debian trixie+; not in older releases) | `sd` | `sd` | Intuitive JS-like regex syntax, faster on big files |
| **eza** | ls/tree | `eza` (Ubuntu 24.04+/Debian trixie+; not in older releases) | `eza` | `eza` | Icons, Git status, tree view |
| **xh** | curl (API calls) | — (static binary) | `xh` | `xh` | Rust HTTPie; single file, instant startup |

Debian/Ubuntu command-name normalization (`fdfind`→`fd`, `batcat`→`bat`):

```bash
mkdir -p ~/.local/bin
ln -sf "$(command -v fdfind)" ~/.local/bin/fd
ln -sf "$(command -v batcat)" ~/.local/bin/bat
```

### Per-platform install commands

Debian / Ubuntu (24.04+):

```bash
sudo apt install ripgrep fd-find bat sd eza duf hyperfine hexyl \
  jq miller git-delta lnav ugrep plocate pigz zstd aria2 fzf
```

Fedora:

```bash
sudo dnf install ripgrep fd-find bat sd eza dust duf hyperfine tokei hexyl \
  jq miller git-delta lnav ugrep plocate pigz zstd aria2 fzf xh
```

RHEL / CentOS / Rocky / AlmaLinux (dnf): enable EPEL (plus CRB on RHEL/Rocky/Alma 9), then `sudo dnf install ripgrep fd-find bat pigz zstd jq aria2 fzf`. EPEL coverage varies by version and lags upstream; whatever is missing goes through section 2 static binaries. CentOS 7 / RHEL 7 are EOL and their glibc 2.17 cannot run glibc-linked prebuilt binaries — pick `*-unknown-linux-musl` static artifacts there.

Arch Linux:

```bash
sudo pacman -S ripgrep fd bat eza sd dust duf hyperfine tokei hexyl \
  jq miller git-delta lnav ugrep plocate pigz zstd aria2 fzf \
  xh watchexec difftastic ouch procs
```

macOS (Homebrew) — the most complete coverage:

```bash
brew install ripgrep fd bat sd eza dust duf hyperfine tokei hexyl \
  jq yq miller git-delta lnav ugrep pigz zstd aria2 fzf \
  xh doggo jaq qsv ouch difftastic procs watchexec tailspin erdtree
```

Notes: `plocate` is Linux-only; on macOS the system-level equivalent is Spotlight's `mdfind` (built in, e.g. `mdfind -name keyword`). Without Homebrew use MacPorts or static binaries (`*-apple-darwin`; Apple Silicon is `aarch64`, Intel is `x86_64`).

Windows (winget or Scoop):

```powershell
$pkgs = @(
  "BurntSushi.ripgrep.MSVC", "sharkdp.fd", "sharkdp.bat", "chmln.sd",
  "eza-community.eza", "bootandy.dust", "muesli.duf", "sharkdp.hyperfine",
  "XAMPPRocky.tokei", "sharkdp.hexyl", "jqlang.jq", "MikeFarah.yq",
  "dandavison.delta", "junegunn.fzf", "aria2.aria2"
)
$pkgs | ForEach-Object {
  winget install -e --id $_ --accept-source-agreements --accept-package-agreements
}
```

```powershell
scoop bucket add extras
scoop install ripgrep fd bat sd eza dust duf hyperfine tokei hexyl `
  jq yq miller delta fzf aria2 zstd pigz xh doggo ouch difftastic procs watchexec erdtree
```

Notes: winget IDs are community-maintained — verify with `winget search <name>` when install fails; Chocolatey also works (`choco install ripgrep fd bat ...`). Unix-only tools have no native Windows build: `plocate` (use Everything's `es.exe` CLI instead), `lnav` (use WSL). For static binaries pick `*-pc-windows-msvc.zip` and add the extracted directory to `PATH`. An agent running inside WSL2 follows the Debian/Ubuntu path above.

## 2. Official static binaries (cross-distro)

These tools publish single-file static binaries on GitHub Releases: download, unpack, drop into `~/.local/bin` (or any `PATH` directory on Windows). Use them when the distro repo does not carry the tool (old Debian/Ubuntu LTS, RHEL family) or a newer version is needed.

Artifact naming per platform:

| Platform | Typical suffix | Notes |
| --- | --- | --- |
| Linux (recent distros) | `*-x86_64-unknown-linux-gnu.tar.gz` | Dynamically linked glibc; avoid on old systems |
| Linux (old systems / CentOS 7 / Alpine) | `*-x86_64-unknown-linux-musl.tar.gz` | Fully static; best compatibility, preferred for agent images |
| macOS (Apple Silicon) | `*-aarch64-apple-darwin.tar.gz` | M-series |
| macOS (Intel) | `*-x86_64-apple-darwin.tar.gz` | |
| Windows | `*-x86_64-pc-windows-msvc.zip` | Add the extracted `.exe` directory to PATH |

| Tool | Replaces | GitHub repo | Notes |
| --- | --- | --- | --- |
| **sd** | sed | `chmln/sd` | Also in newer distro repos (see section 1) |
| **eza** | ls/tree | `eza-community/eza` | Community-maintained exa fork |
| **xh** | curl (API calls) | `ducaale/xh` | Rust HTTPie |
| **doggo** | dig/nslookup | `mr-karan/doggo` | Structured DNS; `--json` is agent-friendly |
| **yq** | — (YAML) | `mikefarah/yq` | YAML jq; the `yq` in apt is a different tool — do not mix them up |
| **jaq** | jq | `01mf02/jaq` | Rust jq rewrite; faster, syntax-compatible |
| **qsv** | — (CSV) | `dathere/qsv` | Maintained xsv fork; huge-CSV slicing/stats; the musl binary is ~100 MB — prefer `miller` in size-constrained images |
| **ouch** | tar/unzip/unrar | `ouch-org/ouch` | One command decompresses tar/zip/7z/rar/zst etc. |
| **difftastic (difft)** | diff | `Wilfred/difftastic` | Structural syntax-tree diff; binary is large (~120 MB uncompressed) because it bundles tree-sitter grammars |
| **procs** | ps | `dalance/procs` | Colored tree process view; `--no-header` is scriptable |
| **watchexec** | entr/inotifywait | `watchexec/watchexec` | Run commands on file changes; stable, filter rules |
| **tailspin (tspin)** | tail -f | `bensadeh/tailspin` | Zero-config log highlighting; binary name is `tspin`; pipe-friendly |
| **erdtree (erd)** | tree | `solidiquis/erdtree` | tree + du combined; `--layout flat` reads well for agents |
| **dust** | du | `bootandy/dust` | Static musl builds for x86_64/aarch64 |
| **tokei** | cloc | `XAMPPRocky/tokei` | Upstream stopped publishing binaries after v12.1.2 (v13/v14 releases have no assets); use distro repos, brew, or cargo-binstall instead |

Generic install template (sd example; others are analogous):

```bash
curl -sL https://github.com/chmln/sd/releases/latest/download/sd-v1.0.0-x86_64-unknown-linux-gnu.tar.gz \
  | tar xz
install sd-v1.0.0-x86_64-unknown-linux-gnu/sd ~/.local/bin/
```

## 3. No-compile fallback channels

When neither the distro repo nor GitHub binaries are convenient, these channels only fetch prebuilt artifacts and never compile locally:

| Channel | Usage | Notes |
| --- | --- | --- |
| **cargo-binstall** | `cargo binstall ripgrep` | Pulls the crate's official prebuilt binary |
| **mise** | `mise use -g ripgrep` | Declarative version manager; good for pinning tool versions in agent images |
| **aqua** | `aqua g -i cli/cli` | Declarative CLI version manager with a reproducible lockfile |
| **Linuxbrew** | `brew install eza` | Homebrew on Linux; installs prebuilt bottles |

## 4. Agent best practices (detail)

### 4.1 Clean output (color and pager off)

Modern CLIs detect TTYs and automatically disable color and paging when piped, so usually nothing is needed. When an agent allocates a pseudo-TTY or a tool behaves inconsistently, force clean output:

```bash
# Environment level (set once at agent shell init)
export NO_COLOR=1        # widely supported color-off convention
export CLICOLOR=0        # BSD-style color switch
export PAGER=cat         # no pagers at all
export GIT_PAGER=cat     # git never pages
export BAT_PAGER=cat
export BAT_STYLE=plain   # bat without line numbers/decorations
export DEBIAN_FRONTEND=noninteractive   # apt stays non-interactive
```

```bash
# Command level (more reliable per invocation)
bat --paging=never --style=plain --color=never file.py
eza --color=never --icons=never
fd --color=never -e py
rg --no-heading --line-number --color=never "pattern"
git --no-pager log --oneline -20
```

### 4.2 Prefer structured output

```bash
rg --json "TODO"                  # one JSON event per line
doggo --json example.com          # DNS results as JSON
jq -r '.items[].name' api.json    # exact field extraction
mlr --icsv --ojson cat data.csv   # CSV to JSON for further processing
```

### 4.3 Stay non-interactive

```bash
fzf --filter "query"          # no TUI; prints the best match
lnav -n /var/log/syslog       # headless lnav
xh GET api.example.com </dev/null   # cut stdin so nothing waits for input
apt-get install -y ...
git clone --quiet ...
```

### 4.4 Bound output size

```bash
rg --max-count 50 "pattern"              # at most 50 matches per file
rg --max-filesize 1M "pattern"           # skip huge files
rg -g '!node_modules' -g '!*.lock' "pattern"   # exclude noise
fd --max-results 100 -e log              # cap result count
fd -E node_modules -E .git               # exclude directories
eza --tree --level=2                     # expand only two levels
dust -n 20                               # only the 20 biggest entries
head -n 200 / head -c 100000             # final backstop: truncate lines/bytes
```

### 4.5 Timeouts and exit codes

```bash
timeout 30 rg "pattern" .
timeout 60 aria2c -x 8 https://example.com/big.iso
```

| Tool | Exit 0 | Exit 1 | Exit 2 |
| --- | --- | --- | --- |
| rg / grep / ugrep | match found | **no match (not an error!)** | real error |
| jq | success | general error | usage error (`jq -e` also returns 1 for empty/false results) |
| hyperfine | success | — | benchmarked command failed |

```bash
rg -q "pattern" file.py
case $? in
  0) echo "found" ;;
  1) echo "not found (normal)" ;;
  2) echo "rg execution error — handle it" ;;
esac
```

### 4.6 Agent environment init snippet

```bash
# ---- clean output ----
export NO_COLOR=1 CLICOLOR=0
export PAGER=cat GIT_PAGER=cat BAT_PAGER=cat BAT_STYLE=plain
export DEBIAN_FRONTEND=noninteractive

# ---- unified names (Debian/Ubuntu) ----
mkdir -p ~/.local/bin
command -v fdfind >/dev/null && ln -sf "$(command -v fdfind)" ~/.local/bin/fd
command -v batcat >/dev/null && ln -sf "$(command -v batcat)" ~/.local/bin/bat
export PATH="$HOME/.local/bin:$PATH"

# ---- optional: wire delta into git (humans only; git never pages non-TTY) ----
git config --global core.pager delta
git config --global delta.line-numbers true
```

### 4.7 Minimal core set

If only a handful can be installed, these five cover the highest-frequency agent scenarios — search, locate, replace, parse, read:

1. **ripgrep** — text search
2. **fd** — file lookup
3. **sd** — text replace
4. **jq** (+ yq) — structured data parsing
5. **bat** — file reading (syntax highlighting helps models parse code structure)

## 5. AICR runtime image matrix (verified 2026-09-03)

The AICR deployment image (`deploy/Dockerfile`, Debian 13 trixie slim) installs modern tools through two channels:

- **apt (trixie main)**: `ripgrep` 14.1.1, `fd-find`→`fd` 10.2.0, `bat`→`bat` 0.25.0, `sd` 1.0.0, `eza` 0.21.0, `duf` 0.8.1, `hyperfine` 1.19.0, `hexyl` 0.8.0, `jq`, `miller` 6.13.0, `git-delta` 0.18.2, `lnav` 0.12.4, `ugrep` 7.4.2, `pigz`, `zstd`, `aria2`, `fzf` 0.60.3. Availability verified with `apt-cache` inside a live `debian:trixie-slim` podman container — every runtime package resolves with `Components: main` only (no contrib/non-free needed).
- **Pinned GitHub release static binaries** (amd64/arm64 only): `dust` v1.2.5, `xh` v0.26.2, `doggo` v1.4.0, `jaq` v3.1.1, `difftastic` 0.70.0, `ouch` 0.8.2, `procs` v0.14.12, `watchexec` v2.7.0, `tailspin` 7.0.0 (binary `tspin`, `tailspin` symlinked), `erdtree` v3.1.2 (`erd`), `yq` v4.53.2. Versions are `ARG`-pinned; `GH_RELEASE_PREFIX` prefixes the release URLs for ghproxy-style mirrors or internal caches. Trixie does package `du-dust` 1.2.0, `xh` 0.24.0, `procs` 0.14.10, and `tailspin` 5.4.2, but the pinned static builds are newer and keep both architectures reproducible; `doggo`, `jaq`, `difftastic`, `ouch`, `watchexec`, and `erdtree` have no trixie package.

Deliberately excluded from the image:

- **tokei** — upstream publishes no binaries since v13.0.0 (verified: v13.0.0 and v14.0.0 releases have zero assets); trixie apt carries only the stale 12.1.2 from 2023.
- **qsv** — the musl static binary is ~104 MB compressed; too heavy for the review image. `miller` covers CSV/TSV/JSON column work.
- **plocate** — present in trixie but needs an `updatedb` index that containers never build, so `locate` would always fail or return nothing.

## 6. Traditional → modern cheat sheet

| Traditional | Modern replacement | Install channel |
| --- | --- | --- |
| grep | ripgrep / ugrep | distro repo |
| find | fd | distro repo |
| sed | sd | distro repo (Ubuntu 24.04+) / static binary |
| cat | bat | distro repo |
| ls / tree | eza / erdtree | distro repo (Ubuntu 24.04+) / static binary |
| du / df | dust / duf | distro repo / static binary |
| ps | procs | static binary / Arch repo |
| xxd | hexyl | distro repo |
| curl | xh | static binary / Fedora、Arch repo |
| dig | doggo | static binary |
| wget | aria2 | distro repo |
| tar/unzip | ouch | static binary / Arch repo |
| gzip | pigz / zstd | distro repo |
| time | hyperfine | distro repo |
| cloc | tokei | distro repo / brew / binstall (no GitHub binaries since v13) |
| diff | delta / difftastic | distro repo / static binary |
| tail -f | lnav / tailspin | distro repo / static binary |
| JSON | jq / jaq | distro repo / static binary |
| YAML | yq (mikefarah) | static binary |
| CSV | miller / qsv | distro repo / static binary |
| locate | plocate | distro repo (host only — needs updatedb index) |
| entr | watchexec | static binary / Arch repo |

Cross-platform note: tools marked "distro repo" are nearly all available on macOS via `brew install <same name>` and on Windows via winget/Scoop (except Unix-only tools like `plocate` and `lnav`; see section 1 notes).
