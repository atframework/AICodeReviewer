import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const IS_WINDOWS = process.platform === "win32";
const IS_LINUX = process.platform === "linux";

/**
 * Enumerate every descendant PID of `rootPid` on Linux by walking `/proc`.
 *
 * Descendants may escape the original process group/session: agent binaries
 * (e.g. the Kilo CLI) commonly `setsid` their worker subprocesses into a new
 * session, so a `kill(-rootPid)` group signal never reaches them and they
 * survive as orphans. `/proc/<pid>/stat` keeps the real PPID regardless of
 * `setsid` (which only changes session/pgid, not the parent link), so a
 * parent-link walk still finds the whole tree.
 */
function collectDescendantPidsLinux(rootPid: number): number[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }

  const childrenByParent = new Map<number, number[]>();
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    const pid = Number(entry);
    let ppid: number | undefined;
    try {
      // /proc/<pid>/stat is "pid (comm) state ppid ...". `comm` may contain
      // spaces and parens, so parse everything after the last ')'.
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = raw.lastIndexOf(")");
      if (closeParen === -1) {
        continue;
      }
      const after = raw.slice(closeParen + 2).split(" ");
      ppid = Number(after[1]); // after[0] is state, after[1] is ppid
    } catch {
      continue;
    }
    if (!Number.isFinite(ppid)) {
      continue;
    }
    const siblings = childrenByParent.get(ppid);
    if (siblings) {
      siblings.push(pid);
    } else {
      childrenByParent.set(ppid, [pid]);
    }
  }

  const descendants: number[] = [];
  const seen = new Set<number>();
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const kids = childrenByParent.get(current);
    if (!kids) {
      continue;
    }
    for (const kid of kids) {
      descendants.push(kid);
      queue.push(kid);
    }
  }
  return descendants;
}

/**
 * Terminates a process and its entire descendant tree.
 *
 * POSIX: the caller must spawn the process with `detached: true` so it becomes
 * a process-group leader. On Linux we additionally walk `/proc` to kill every
 * descendant by PID, because agent worker subprocesses often `setsid` into a
 * new session that a `kill(-pid)` group signal cannot reach.
 *
 * Windows: uses `taskkill /T` to walk the descendant tree.
 */
export function killProcessTree(proc: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  const pid = proc.pid;
  if (pid === undefined) {
    return;
  }

  if (IS_WINDOWS) {
    // Windows has no graceful tree signal for console apps (a plain
    // taskkill without /F does not terminate node processes), so always
    // force-kill the whole descendant tree. Repeating this on the
    // SIGKILL stage is harmless when the tree is already gone.
    spawn(
      "taskkill",
      ["/pid", String(pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    ).unref();
    return;
  }

  // Kill descendants deepest-first so a still-living parent cannot respawn a
  // child between our kills. This catches workers that escaped into their own
  // process group/session.
  if (IS_LINUX) {
    const descendants = collectDescendantPidsLinux(pid);
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      const descendantPid = descendants[index];
      if (descendantPid === undefined) {
        continue;
      }
      try {
        process.kill(descendantPid, signal);
      } catch {
        // process already gone
      }
    }
  }

  // detached: true makes the child a process-group leader, so -pid targets the
  // whole group. Keep this as a fast path that also covers any descendant that
  // never escaped the original group.
  try {
    process.kill(-pid, signal);
  } catch {
    // fall through to a direct kill of the root
  }

  try {
    proc.kill(signal);
  } catch {
    // process/group already gone
  }
}
