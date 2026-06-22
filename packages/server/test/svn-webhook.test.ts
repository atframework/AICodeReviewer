import { describe, expect, it } from "vitest";

import {
  translateSvnTriggerToReviewEvent,
  type SvnTriggerConfig,
} from "../src/svn-webhook.js";
import { createServerApp } from "../src/index.js";

describe("translateSvnTriggerToReviewEvent", () => {
  const config: SvnTriggerConfig = {
    triggerName: "svn-main",
    workspaceId: "svn-workspace",
    repositoryUrl: "https://svn.example.com/repos/project/trunk",
  };

  it("translates a minimal SVN post-commit JSON payload", () => {
    const event = translateSvnTriggerToReviewEvent(
      { revision: "42", author: "alice" },
      config,
    );

    expect(event).not.toBeNull();
    expect(event?.provider).toBe("svn");
    expect(event?.targetKind).toBe("commit");
    expect(event?.headSha).toBe("42");
    expect(event?.repoRef).toBe("https://svn.example.com/repos/project/trunk");
    expect(event?.sourcePath).toBe("https://svn.example.com/repos/project/trunk");
    expect(event?.reason).toBe("svn:post-commit:42");
    expect(event?.author).toEqual({ username: "alice" });
    expect(event?.rawEventName).toBe("post-commit");
  });

  it("accepts revision aliases rev and r", () => {
    const eventRev = translateSvnTriggerToReviewEvent({ rev: "43" }, config);
    const eventR = translateSvnTriggerToReviewEvent({ r: "44" }, config);

    expect(eventRev?.headSha).toBe("43");
    expect(eventR?.headSha).toBe("44");
  });

  it("ignores repository URL aliases from the payload", () => {
    const eventRepo = translateSvnTriggerToReviewEvent(
      { revision: "42", repo: "https://repo.example.com/svn" },
      config,
    );
    const eventUrl = translateSvnTriggerToReviewEvent(
      { revision: "42", url: "https://url.example.com/svn" },
      config,
    );

    expect(eventRepo?.repoRef).toBe("https://svn.example.com/repos/project/trunk");
    expect(eventUrl?.repoRef).toBe("https://svn.example.com/repos/project/trunk");
  });

  it("configured repositoryUrl wins over payload repository_url", () => {
    const event = translateSvnTriggerToReviewEvent(
      { revision: "42", repository_url: "https://override.example.com" },
      config,
    );

    expect(event?.repoRef).toBe("https://svn.example.com/repos/project/trunk");
  });

  it("uses configured repository_url when payload omits it", () => {
    const event = translateSvnTriggerToReviewEvent(
      { revision: "42" },
      { triggerName: "svn-main", workspaceId: "svn-workspace", repositoryUrl: "https://fallback.example.com" },
    );

    expect(event?.repoRef).toBe("https://fallback.example.com");
    expect(event?.sourcePath).toBe("https://fallback.example.com");
  });

  it("includes base revision when provided", () => {
    const event = translateSvnTriggerToReviewEvent(
      { revision: "42", base_revision: "41" },
      config,
    );

    expect(event?.baseSha).toBe("41");
    expect(event?.headSha).toBe("42");
  });

  it("accepts base revision aliases base_rev and old_revision", () => {
    const eventBaseRev = translateSvnTriggerToReviewEvent(
      { revision: "42", base_rev: "40" },
      config,
    );
    const eventOldRev = translateSvnTriggerToReviewEvent(
      { revision: "42", old_revision: "39" },
      config,
    );

    expect(eventBaseRev?.baseSha).toBe("40");
    expect(eventOldRev?.baseSha).toBe("39");
  });

  it("includes changed files when provided", () => {
    const event = translateSvnTriggerToReviewEvent(
      { revision: "42", changed_files: ["src/app.ts", "README.md"] },
      config,
    );

    expect(event?.changedFiles).toEqual(["src/app.ts", "README.md"]);
  });

  it("accepts files alias for changed_files", () => {
    const event = translateSvnTriggerToReviewEvent(
      { revision: "42", files: ["src/app.ts"] },
      config,
    );

    expect(event?.changedFiles).toEqual(["src/app.ts"]);
  });

  it("accepts author alias user", () => {
    const event = translateSvnTriggerToReviewEvent(
      { revision: "42", user: "bob" },
      config,
    );

    expect(event?.author).toEqual({ username: "bob" });
  });

  it("returns null when revision is missing", () => {
    const event = translateSvnTriggerToReviewEvent({ author: "alice" }, config);

    expect(event).toBeNull();
  });

  it("returns null when configured repositoryUrl is empty", () => {
    const event = translateSvnTriggerToReviewEvent(
      { revision: "42" },
      { ...config, repositoryUrl: "   " },
    );

    expect(event).toBeNull();
  });
});

describe("/triggers/svn endpoint", () => {
  const svnConfig: SvnTriggerConfig = {
    triggerName: "svn-main",
    workspaceId: "svn-workspace",
    repositoryUrl: "https://svn.example.com/repos/project/trunk",
  };

  it("returns 503 when SVN trigger is not configured", async () => {
    const app = createServerApp({ asyncTriggers: true });

    const response = await app.request("/triggers/svn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: "42", author: "alice" }),
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { accepted: boolean; reason: string; provider: string };
    expect(body).toEqual({ accepted: false, reason: "trigger_not_configured", provider: "svn" });
  });

  it("accepts a JSON SVN trigger payload in async mode", async () => {
    const app = createServerApp({ svn: svnConfig, asyncTriggers: true });

    const response = await app.request("/triggers/svn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: "42", author: "alice", files: ["src/app.ts"] }),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      accepted: boolean;
      provider: string;
      eventName: string;
      reviewEvent: { provider: string; repoRef: string; sourcePath: string; headSha: string; changedFiles: string[] };
    };
    expect(body.accepted).toBe(true);
    expect(body.provider).toBe("svn");
    expect(body.eventName).toBe("post-commit");
    expect(body.reviewEvent.provider).toBe("svn");
    expect(body.reviewEvent.repoRef).toBe(svnConfig.repositoryUrl);
    expect(body.reviewEvent.sourcePath).toBe(svnConfig.repositoryUrl);
    expect(body.reviewEvent.headSha).toBe("42");
    expect(body.reviewEvent.changedFiles).toEqual(["src/app.ts"]);
  });

  it("does not let payload repository_url override the configured SVN repository", async () => {
    const app = createServerApp({ svn: svnConfig, asyncTriggers: true });

    const response = await app.request("/triggers/svn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: "42",
        repository_url: "https://attacker.example.com/svn",
      }),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { reviewEvent: { repoRef: string; sourcePath: string } };
    expect(body.reviewEvent.repoRef).toBe(svnConfig.repositoryUrl);
    expect(body.reviewEvent.sourcePath).toBe(svnConfig.repositoryUrl);
  });

  it("accepts form-encoded SVN trigger payloads", async () => {
    const app = createServerApp({ svn: svnConfig, asyncTriggers: true });
    const form = new URLSearchParams();
    form.set("rev", "43");
    form.set("user", "bob");
    form.set("files", "src/a.ts\nsrc/b.ts");

    const response = await app.request("/triggers/svn", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      reviewEvent: { headSha: string; author: { username: string }; changedFiles: string[] };
    };
    expect(body.reviewEvent.headSha).toBe("43");
    expect(body.reviewEvent.author.username).toBe("bob");
    expect(body.reviewEvent.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

