import { register } from "node:module";

register(new URL("../../../server/test/fixtures/aicr-source-hooks.mts", import.meta.url));
// Windows force-terminates SIGTERM targets. Exercise the CLI's process signal
// event in that host; POSIX tests send the actual OS signal.
if (process.platform === "win32") {
  process.on("message", message => { if (message === "SIGTERM") process.emit("SIGTERM"); });
  process.channel?.unref();
}
await import("../../src/index.js");
