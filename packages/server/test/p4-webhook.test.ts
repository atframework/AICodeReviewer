import { createReviewEvent, type ReviewEvent } from "@aicr/core";
import { describe, expect, it, vi } from "vitest";

import {
  enrichP4ReviewEvent,
  translateP4TriggerToReviewEvent,
  type P4DescribeRunner,
  type P4TriggerConfig,
} from "../src/p4-webhook.js";

describe("translateP4TriggerToReviewEvent", () => {
  const config = {
    triggerName: "p4-main",
    workspaceId: "p4-workspace",
    depot: "//Prx/Prx_Main",
  };

  it("uses configured depot when trigger payload omits depot_path", () => {
    const event = translateP4TriggerToReviewEvent(
      { change: "6244", user: "submitter", client: "submit-client" },
      config,
    );

    expect(event?.repoRef).toBe("//Prx/Prx_Main");
    expect(event?.url).toBe("p4://Prx/Prx_Main@6244");
  });

  it("uses configured depot when trigger payload sends an empty depot_path", () => {
    const event = translateP4TriggerToReviewEvent(
      { change: "6244", depot_path: "" },
      config,
    );

    expect(event?.repoRef).toBe("//Prx/Prx_Main");
  });

  it("allows trigger payload depot_path to override configured depot", () => {
    const event = translateP4TriggerToReviewEvent(
      { change: "6244", depot_path: "//Other/Main" },
      config,
    );

    expect(event?.repoRef).toBe("//Other/Main");
  });

  it("includes sourcePath and submitter client workspace", () => {
    const event = translateP4TriggerToReviewEvent(
      { change: "6244", user: "submitter", client: "submit-client" },
      {
        triggerName: "p4-main",
        workspaceId: "p4-workspace",
        depot: "//Prx/Prx_Main",
        workspace: "submit-client-ws",
      },
    );

    expect(event?.sourcePath).toBe("//Prx/Prx_Main");
    expect(event?.submitterWorkspace).toBe("submit-client");
    expect(event?.author).toEqual({ username: "submitter" });
  });

  it("does not expose configured analysis workspace when payload omits client", () => {
    const event = translateP4TriggerToReviewEvent(
      { change: "6244", user: "submitter" },
      {
        triggerName: "p4-main",
        workspaceId: "p4-workspace",
        depot: "//Prx/Prx_Main",
        workspace: "configured-client-ws",
      },
    );

    expect(event?.submitterWorkspace).toBeUndefined();
    expect(event?.author).toEqual({ username: "submitter" });
  });

  it("accepts alternate submitter metadata fields", () => {
    const event = translateP4TriggerToReviewEvent(
      { change: "6244", p4_user: "submitter", p4_client: "submit-client" },
      config,
    );

    expect(event?.author).toEqual({ username: "submitter" });
    expect(event?.submitterWorkspace).toBe("submit-client");
  });

  it("uses payload depot_path for sourcePath field", () => {
    const event = translateP4TriggerToReviewEvent(
      { change: "6244", depot_path: "//Custom/Path" },
      {
        triggerName: "p4-main",
        workspaceId: "p4-workspace",
        depot: "//Prx/Prx_Main",
      },
    );

    expect(event?.sourcePath).toBe("//Custom/Path");
  });
});

describe("enrichP4ReviewEvent", () => {
  const baseConfig: P4TriggerConfig = {
    triggerName: "p4-main",
    workspaceId: "p4-workspace",
    port: "ssl:p4.example.com:1666",
    user: "svc-aicr",
    password: "ticket123",
    workspace: "aicr-p4-main",
  };

  function makeEvent(overrides: Partial<ReviewEvent> = {}): ReviewEvent {
    return createReviewEvent({
      triggerName: "p4-main",
      provider: "p4",
      workspaceId: "p4-workspace",
      targetKind: "commit",
      repoRef: "//Prx/Prx_Main",
      headSha: "6435",
      reason: "p4:change-commit:6435",
      author: {},
      ...overrides,
    });
  }

  function makeRunner(stdout: string): P4DescribeRunner {
    return vi.fn(async () => ({ stdout }));
  }

  it("returns original event when author and workspace are already present", async () => {
    const event = makeEvent({
      author: { username: "submitter" },
      submitterWorkspace: "submit-client",
    });
    const runner = makeRunner("Change 6435 by fallback@fallback-ws on 2026/05/13 10:00:00");

    const result = await enrichP4ReviewEvent(event, baseConfig, runner);

    expect(result.author).toEqual({ username: "submitter" });
    expect(result.submitterWorkspace).toBe("submit-client");
    expect(runner).not.toHaveBeenCalled();
  });

  it("fills missing author from p4 describe output", async () => {
    const event = makeEvent({ author: {} });
    const runner = makeRunner("Change 6435 by submitter@submit-client on 2026/05/13 10:00:00\n\n\tTest commit\n\nAffected files ...\n");

    const result = await enrichP4ReviewEvent(event, baseConfig, runner);

    expect(result.author).toEqual({ username: "submitter" });
    expect(runner).toHaveBeenCalledOnce();
  });

  it("fills missing submitterWorkspace from p4 describe output", async () => {
    const event = makeEvent({ author: { username: "submitter" } });
    const runner = makeRunner("Change 6435 by submitter@submit-client on 2026/05/13 10:00:00");

    const result = await enrichP4ReviewEvent(event, baseConfig, runner);

    expect(result.submitterWorkspace).toBe("submit-client");
    expect(result.author).toEqual({ username: "submitter" });
  });

  it("fills both missing author and workspace from p4 describe output", async () => {
    const event = makeEvent();
    const runner = makeRunner("Change 6435 by submitter@submit-client on 2026/05/13 10:00:00");

    const result = await enrichP4ReviewEvent(event, baseConfig, runner);

    expect(result.author).toEqual({ username: "submitter" });
    expect(result.submitterWorkspace).toBe("submit-client");
  });

  it("keeps original event when runner throws", async () => {
    const event = makeEvent();
    const runner = vi.fn(async () => {
      throw new Error("p4 connection failed");
    });

    const result = await enrichP4ReviewEvent(event, baseConfig, runner);

    expect(result.author?.username).toBeUndefined();
    expect(result.submitterWorkspace).toBeUndefined();
  });

  it("keeps original event when config has no P4 connection params", async () => {
    const event = makeEvent();
    const runner = makeRunner("Change 6435 by submitter@submit-client on 2026/05/13 10:00:00");
    const minimalConfig: P4TriggerConfig = {
      triggerName: "p4-main",
      workspaceId: "p4-workspace",
    };

    const result = await enrichP4ReviewEvent(event, minimalConfig, runner);

    expect(result.author?.username).toBeUndefined();
    expect(result.submitterWorkspace).toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
  });

  it("keeps original event when headSha is missing", async () => {
    const event = makeEvent({ headSha: undefined });
    const runner = makeRunner("Change 6435 by submitter@submit-client on 2026/05/13 10:00:00");

    const result = await enrichP4ReviewEvent(event, baseConfig, runner);

    expect(result.author?.username).toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
  });

  it("passes correct args and env to runner", async () => {
    const event = makeEvent();
    const runner = makeRunner("Change 6435 by submitter@submit-client on 2026/05/13 10:00:00");

    await enrichP4ReviewEvent(event, baseConfig, runner);

    expect(runner).toHaveBeenCalledOnce();
    const [args, env] = runner.mock.calls[0]!;
    expect(args).toEqual([
      "-p", "ssl:p4.example.com:1666",
      "-u", "svc-aicr",
      "-c", "aicr-p4-main",
      "describe", "-s", "6435",
    ]);
    expect(env.P4PASSWD).toBe("ticket123");
  });

  it("does not override existing values even when p4 output differs", async () => {
    const event = makeEvent({
      author: { username: "original-user" },
      submitterWorkspace: "original-ws",
    });
    const runner = makeRunner("Change 6435 by fallback@fallback-ws on 2026/05/13 10:00:00");

    const result = await enrichP4ReviewEvent(event, baseConfig, runner);

    expect(result.author).toEqual({ username: "original-user" });
    expect(result.submitterWorkspace).toBe("original-ws");
  });
});
