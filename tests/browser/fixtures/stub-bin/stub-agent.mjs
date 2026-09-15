/**
 * Shared stub-agent runtime for the browser gate (P7 run isolation leg).
 * Stands in for the real kilo/opencode CLIs on the native-sandbox agent path:
 * the orchestrator spawns `<binary> run --auto --format json --model … --dir …`
 * (see packages/agents/src/kilo.ts buildCommand) and parses the NDJSON event
 * stream on stdout (extractKiloJsonStreamContent in review-orchestrator.ts).
 *
 * Protocol emitted (exact envelope the orchestrator accepts):
 *   {"type":"text","part":{"type":"text","text":"<review payload JSON>"}}
 *   {"type":"step_finish","part":{"type":"step-finish","tokens":{…},"cost":…}}
 * The text payload is a `{"summary": …}` object so the downstream
 * extractJsonPayload → aicr.publish_summary translation succeeds on the first
 * pass (no format-repair respawn, no direct-LLM fallback).
 *
 * Every `run` invocation appends one JSON line to AICR_STUB_AGENT_LOG. The
 * FIRST recorded invocation holds the run in flight for the release flag.
 * A missing acknowledgement fails the child; it never silently releases.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const RELEASE_POLL_MS = 100;
const RELEASE_CAP_MS = 120_000;

export function runStubAgent(options) {
  const { binary, sentinel } = options;
  const argv = process.argv.slice(2);

  // detectBinary (`<binary> --version`) must succeed without touching the log.
  if (argv.includes("--version")) {
    process.stdout.write(`${binary}-stub 7.0.0\n`);
    return;
  }

  // The task arrives on stdin (orchestrator writes effectiveTask); drain it so
  // a large prompt cannot stall the parent's pipe write.
  process.stdin.resume();

  const logPath = process.env.AICR_STUB_AGENT_LOG;
  const releaseFile = process.env.AICR_STUB_RELEASE_FILE;
  let isFirstInvocation = false;
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
    isFirstInvocation = !existsSync(logPath) || readFileSync(logPath, "utf8").trim() === "";
    const configPath = join(process.cwd(), binary === "kilo" ? ".kilo/kilo.json" : "opencode.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const providerBaseUrl = config.provider?.["iso-provider"]?.options?.baseURL;
    appendFileSync(logPath, `${JSON.stringify({ binary, argv, cwd: process.cwd(), providerBaseUrl, ts: Date.now() })}\n`, "utf8");
  }

  const emit = () => {
    const reviewPayload = JSON.stringify({ summary: sentinel });
    process.stdout.write(`${JSON.stringify({ type: "text", part: { type: "text", text: reviewPayload } })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: "step_finish",
      part: {
        type: "step-finish",
        tokens: { input: 11, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.0001,
      },
    })}\n`);
  };

  // Hold the FIRST invocation in flight until the spec creates the release
  // flag, so the test can publish a new config generation mid-run.
  if (isFirstInvocation && releaseFile && !existsSync(releaseFile)) {
    const deadline = Date.now() + RELEASE_CAP_MS;
    const timer = setInterval(() => {
      if (existsSync(releaseFile)) {
        clearInterval(timer);
        emit();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        process.stderr.write("Browser test did not release the blocked agent.\n");
        process.exitCode = 1;
        process.stdin.destroy();
      }
    }, RELEASE_POLL_MS);
    return;
  }
  emit();
}
