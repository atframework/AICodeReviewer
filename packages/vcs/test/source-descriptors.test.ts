import { describe, expect, it, vi } from "vitest";
import { P4VcsAdapter } from "../src/p4.js";
import { parseSvnSourceInfo, SvnVcsAdapter } from "../src/svn.js";

describe("verified VCS source descriptors (V06-V10)", () => {
  it.each(["//streams/main", null])("reads recorded P4 stream %s without querying a current client", async (stream) => {
    const command = vi.fn(async () => ({ stdout: `... change 42\n... user submitter\n... client old-client\n... status submitted\n${stream ? `... stream ${stream}\n` : ""}`, stderr: "" }));
    const adapter = new P4VcsAdapter({ repositoryDir: "build/tmp/p4-descriptors", port: "ssl:p4.example:1666", user: "service", workspace: "service-client", p4: command });
    expect(await adapter.describeSource("42")).toMatchObject({ change: "42", user: "submitter", client: "old-client", stream, server: "ssl:p4.example:1666", service_client: expect.stringMatching(/^service-client-[a-f0-9]{10}$/u) });
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(["-ztag", "describe", "-s", "-m", "1", "42"]));
  });

  it.each([
    "... change 41\n... status submitted\n",
    "... change 42\n... status pending\n",
    "... change 42\n... status submitted\n... user alice\n... user bob\n",
    "Permission denied",
  ])("rejects missing/conflicting P4 metadata", async (stdout) => {
    const adapter = new P4VcsAdapter({ repositoryDir: "build/tmp/p4-descriptors", p4: async () => ({ stdout, stderr: "" }) });
    await expect(adapter.describeSource("42")).rejects.toThrow();
  });

  it("does not hide descriptor transport failures", async () => {
    const adapter = new P4VcsAdapter({ repositoryDir: "build/tmp/p4-descriptors", p4: async () => { throw new Error("descriptor denied"); } });
    await expect(adapter.describeSource("42")).rejects.toThrow("descriptor denied");
  });

  it("parses SVN repository identity, strips URL credentials and decodes entities", () => {
    expect(parseSvnSourceInfo('<info><entry kind="dir"><url>https://alice:secret@svn.example/repo?token=hidden&amp;x=1</url><repository><root>https://svn.example/repo?key=hidden</root><uuid>repo-&#x31;</uuid></repository></entry></info>')).toEqual({ repository_url: "https://svn.example/repo", repository_root: "https://svn.example/repo", repository_uuid: "repo-1" });
    expect(parseSvnSourceInfo("<info><entry></entry></info>")).toEqual({ repository_url: null, repository_root: null, repository_uuid: null });
  });

  it.each(["<log/>", "<info/>", '<!DOCTYPE info><info><entry></entry></info>', '<info><entry><url>https://a</url><url>https://b</url></entry></info>', '<info><entry><repository><uuid>a</uuid></repository><repository><uuid>b</uuid></repository></entry></info>'])("rejects invalid/ambiguous SVN identity XML", (xml) => expect(() => parseSvnSourceInfo(xml)).toThrow());

  it("pins svn info to a configured URL and revision, rejects a different returned URL", async () => {
    const command = vi.fn(async (_args: readonly string[]) => ({ stdout: '<info><entry><url>https://evil.example/repo</url></entry></info>', stderr: "" }));
    const adapter = new SvnVcsAdapter({ repositoryDir: "build/tmp/svn-descriptors", repositoryUrl: "https://svn.example/repo", svn: command });
    await expect(adapter.describeSource("42")).rejects.toThrow("conflicts");
    expect(command).toHaveBeenCalledWith(expect.arrayContaining(["info", "--xml", "-r", "42", "https://svn.example/repo@42"]));
    await expect(adapter.describeSource("42 --username attacker")).rejects.toThrow("numeric revision");
    expect(command).toHaveBeenCalledTimes(1);
  });
});
