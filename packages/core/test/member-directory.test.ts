import { describe, expect, it } from "vitest";

import {
	MEMBER_DIRECTORY_LIMITS,
	parseMemberDirectorySource,
	type MemberDirectoryData,
} from "../src/member-directory.js";

/**
 * IM-06 acceptance D01–D04: strict schema, whole-file semantics, YAML/JSON
 * parity, duplicate detection before value loss, limits and mention-injection
 * rejection. Pure parser: no watcher/filesystem involved.
 */

const wecomYaml = `version: 1
directories:
  engineering-wecom:
    platform: wecom
    identity_scope:
      kind: wecom_corp
      id: ww_example
    members:
      - key: alice
        display_name: Alice Zhang
        aliases: ["张三"]
        emails: [alice@example.invalid]
        vcs_accounts:
          - provider: github
            source_trigger: github-main
            username: alice-dev
        mention:
          type: wecom_userid
          id: alice_zhang
`;

const wecomJson = JSON.stringify({
	version: 1,
	directories: {
		"engineering-wecom": {
			platform: "wecom",
			identity_scope: { kind: "wecom_corp", id: "ww_example" },
			members: [{
				key: "alice",
				display_name: "Alice Zhang",
				aliases: ["张三"],
				emails: ["alice@example.invalid"],
				vcs_accounts: [{ provider: "github", source_trigger: "github-main", username: "alice-dev" }],
				mention: { type: "wecom_userid", id: "alice_zhang" },
			}],
		},
	},
}, null, 1);

const model = (data: MemberDirectoryData) => data.directories.get("engineering-wecom")?.members[0];

describe("D01: YAML/JSON parity and clear semantics", () => {
  it("parses equivalent YAML and JSON into the same member model", () => {
    const yaml = parseMemberDirectorySource(wecomYaml, { fileName: "members.yaml" });
    const json = parseMemberDirectorySource(wecomJson, { fileName: "members.json" });
    expect(yaml.ok).toBe(true);
    expect(json.ok).toBe(true);
    if (!yaml.ok || !json.ok) return;
    expect(model(yaml.data)).toEqual(model(json.data));
    expect(yaml.data.version).toBe(1);
    expect(yaml.data.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(yaml.data.digest).not.toBe(json.data.digest);
  });

  it("treats an explicit empty members list as a successful clear and keeps directories isolated", () => {
    const result = parseMemberDirectorySource(`version: 1
directories:
  a:
    platform: feishu
    identity_scope: { kind: feishu_app, id: cli_a }
    members: []
  b:
    platform: wecom
    identity_scope: { kind: wecom_corp, id: ww_b }
    members:
      - key: bob
        mention: { type: wecom_userid, id: bob }
`, { fileName: "d.yaml" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.directories.get("a")?.members).toEqual([]);
    expect(result.data.directories.get("b")?.members).toHaveLength(1);
    // The same literal id may exist in another scope's directory.
    expect(result.data.directories.get("a")).toBeDefined();
  });

  it("rejects an empty directories map", () => {
    const result = parseMemberDirectorySource("version: 1\ndirectories: {}\n", { fileName: "d.yaml" });
    expect(result).toMatchObject({ ok: false, issue: { code: "invalid_shape" } });
  });
});

describe("D02: duplicates and YAML-only syntax fail whole-file", () => {
  it("rejects duplicate YAML keys, duplicate JSON keys and duplicate member keys", () => {
    const yamlDup = parseMemberDirectorySource("version: 1\nversion: 2\ndirectories: {}\n", { fileName: "d.yaml" });
    expect(yamlDup).toMatchObject({ ok: false, issue: { code: /malformed_yaml|invalid_shape/u } });

    const jsonDup = parseMemberDirectorySource('{"version":1,"version":1,"directories":{}}', { fileName: "d.json" });
    expect(jsonDup).toMatchObject({ ok: false, issue: { code: "malformed_json" } });

    const memberDup = parseMemberDirectorySource(`version: 1
directories:
  a:
    platform: wecom
    identity_scope: { kind: wecom_corp, id: ww }
    members:
      - { key: alice, mention: { type: wecom_userid, id: "1" } }
      - { key: alice, mention: { type: wecom_userid, id: "2" } }
`, { fileName: "d.yaml" });
    expect(memberDup).toMatchObject({ ok: false, issue: { code: "duplicate_member_key" } });
  });

  it("rejects the same typed mention id for two members", () => {
    const result = parseMemberDirectorySource(`version: 1
directories:
  a:
    platform: wecom
    identity_scope: { kind: wecom_corp, id: ww }
    members:
      - { key: alice, mention: { type: wecom_userid, id: shared } }
      - { key: bob, mention: { type: wecom_userid, id: shared } }
`, { fileName: "d.yaml" });
    expect(result).toMatchObject({ ok: false, issue: { code: "duplicate_mention_id" } });
  });

  it("rejects YAML aliases, custom tags and loose JSON syntax", () => {
    const alias = parseMemberDirectorySource(`version: 1
directories:
  a: &anchor
    platform: wecom
    identity_scope: { kind: wecom_corp, id: ww }
    members: []
  b: *anchor
`, { fileName: "d.yaml" });
    expect(alias).toMatchObject({ ok: false, issue: { code: /yaml_alias|malformed_yaml/u } });

    const tag = parseMemberDirectorySource("version: !!str 1\ndirectories: {}\n", { fileName: "d.yaml" });
    expect(tag.ok).toBe(false);

    for (const loose of [
      '{"version":1,"directories":{},}', // trailing comma
      "{'version':1}", // single quotes
      "{version:1}", // unquoted key
      "// comment\n{\"version\":1}", // comment
      '{"version":1e999}', // invalid number magnitude → Infinity
    ]) {
      expect(parseMemberDirectorySource(loose, { fileName: "d.json" })).toMatchObject({ ok: false, issue: { code: "malformed_json" } });
    }
  });
});

describe("D03: versions, unknown fields and limits", () => {
  it("rejects unknown versions and unknown fields at exact paths", () => {
    expect(parseMemberDirectorySource("version: 2\ndirectories: {}\n", { fileName: "d.yaml" }))
      .toMatchObject({ ok: false, issue: { code: "invalid_shape", path: ["version"] } });
    const unknown = parseMemberDirectorySource(`version: 1
directories:
  a:
    platform: wecom
    identity_scope: { kind: wecom_corp, id: ww }
    extra: true
    members: []
`, { fileName: "d.yaml" });
    expect(unknown).toMatchObject({ ok: false, issue: { code: "invalid_shape" } });
  });

  it("rejects invalid UTF-8 and enforces file/member/list limits at the boundary", () => {
    expect(parseMemberDirectorySource(Buffer.from([0x68, 0x65, 0xff, 0x6c, 0x6c, 0x6f]), { fileName: "d.yaml" }))
      .toMatchObject({ ok: false, issue: { code: "invalid_encoding" } });
    expect(parseMemberDirectorySource("a".repeat(MEMBER_DIRECTORY_LIMITS.maxFileBytes + 1), { fileName: "d.yaml" }))
      .toMatchObject({ ok: false, issue: { code: "directory_too_large" } });

    const memberLine = (index: number) => `      - { key: m${index}, mention: { type: wecom_userid, id: u${index} } }`;
    const manyMembers = `version: 1\ndirectories:\n  a:\n    platform: wecom\n    identity_scope: { kind: wecom_corp, id: ww }\n    members:\n${
      Array.from({ length: MEMBER_DIRECTORY_LIMITS.maxTotalMembers }, (_, i) => memberLine(i)).join("\n")}`;
    expect(parseMemberDirectorySource(manyMembers, { fileName: "d.yaml" }).ok).toBe(true);
    const tooMany = manyMembers + "\n" + memberLine(MEMBER_DIRECTORY_LIMITS.maxTotalMembers);
    expect(parseMemberDirectorySource(tooMany, { fileName: "d.yaml" }))
      .toMatchObject({ ok: false, issue: { code: "limit_exceeded" } });

    const aliasOverflow = `version: 1\ndirectories:\n  a:\n    platform: wecom\n    identity_scope: { kind: wecom_corp, id: ww }\n    members:\n      - key: alice\n        aliases: [${Array.from({ length: MEMBER_DIRECTORY_LIMITS.maxListEntries + 1 }, (_, i) => `"a${i}"`).join(", ")}]\n        mention: { type: wecom_userid, id: alice }`;
    expect(parseMemberDirectorySource(aliasOverflow, { fileName: "d.yaml" }).ok).toBe(false);
    const aliasBoundary = aliasOverflow.replace(`"a${MEMBER_DIRECTORY_LIMITS.maxListEntries}"`, "").replace(",  ,", ",").replace("[,", "[");
    expect(parseMemberDirectorySource(aliasBoundary, { fileName: "d.yaml" }).ok).toBe(true);
  });
});

describe("D04: mention injection, pseudo identities and scope mismatches", () => {
  const file = (mentionType: string, mentionId: string, scope = "wecom_corp", platform = "wecom") =>
    `version: 1\ndirectories:\n  a:\n    platform: ${platform}\n    identity_scope: { kind: ${scope}, id: dom }\n    members:\n      - key: alice\n        mention: { type: ${mentionType}, id: "${mentionId}" }`;

  it("rejects markup injection and all pseudo identities", () => {
    for (const id of ['x"><at id="all"', "<@all>", "all", "@all"]) {
      expect(parseMemberDirectorySource(file("wecom_userid", id), { fileName: "d.yaml" }))
        .toMatchObject({ ok: false, issue: { code: /invalid_mention|invalid_shape/u } });
    }
  });

  it("rejects mention types outside their identity scope and platform", () => {
    expect(parseMemberDirectorySource(file("feishu_open_id", "ou_x"), { fileName: "d.yaml" }))
      .toMatchObject({ ok: false, issue: { code: "identity_scope_mismatch" } });
    expect(parseMemberDirectorySource(file("wecom_userid", "u", "feishu_app", "feishu"), { fileName: "d.yaml" }))
      .toMatchObject({ ok: false, issue: { code: "identity_scope_mismatch" } });
    expect(parseMemberDirectorySource(file("feishu_user_id", "u", "feishu_app", "feishu"), { fileName: "d.yaml" }))
      .toMatchObject({ ok: false, issue: { code: "identity_scope_mismatch" } });
    expect(parseMemberDirectorySource(file("wecom_mobile", "13800000000"), { fileName: "d.yaml" }).ok).toBe(true);
    expect(parseMemberDirectorySource(file("feishu_open_id", "ou_x", "feishu_app", "feishu"), { fileName: "d.yaml" }).ok).toBe(true);
    expect(parseMemberDirectorySource(file("feishu_user_id", "u", "feishu_tenant", "feishu"), { fileName: "d.yaml" }).ok).toBe(true);
  });

  it("normalizes and dedupes aliases/emails without merging people", () => {
    const result = parseMemberDirectorySource(`version: 1
directories:
  a:
    platform: wecom
    identity_scope: { kind: wecom_corp, id: ww }
    members:
      - key: alice
        aliases: ["Bob ", "bob", ""]
        emails: ["Alice@Example.invalid", "alice@example.invalid"]
        mention: { type: wecom_userid, id: alice }
`, { fileName: "d.yaml" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const member = result.data.directories.get("a")!.members[0]!;
    expect(member.aliases).toEqual(["Bob", "bob"]);
    expect(member.emails).toEqual(["alice@example.invalid"]);
    expect(Object.isFrozen(member) && Object.isFrozen(member.aliases)).toBe(true);
  });
});
