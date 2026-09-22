# Remote publication API contracts

- last_checked: 2026-09-22
- next_review: before changing publication markers, pagination or idempotency
- update_trigger: platform response changes, new publishers, query permission failures

Primary sources:

- [GitHub issue comments](https://docs.github.com/en/rest/issues/comments): raw
  Markdown body, comment IDs, repository/issue list endpoints and pagination.
- [GitHub reviews](https://docs.github.com/en/rest/pulls/reviews): create/list
  reviews with a body and ID; reviews aggregate inline comments.
- [Gitea API](https://docs.gitea.com/api/): issue/comment/review create, get and
  list resources; [pagination](https://docs.gitea.com/development/api-usage/).
  Local acceptance uses Gitea 1.25.4, not the documentation site's moving release.
- [GitLab notes](https://docs.gitlab.com/api/notes/) and
  [discussions](https://docs.gitlab.com/api/discussions/): MR-local endpoints,
  raw bodies, discussion IDs and nested `notes[].body`.
- [Feishu create message](https://open.feishu.cn/document/server-docs/im-v1/message/create.md):
  UUID length at most 50; the same UUID sends at most one message within one hour.
  This is the HTML page's declared Markdown alternate. The contract does not
  establish an unlimited deduplication period or lookup by UUID.

AICR appends an HTML comment containing its operation hash to report bodies and
uses list/get APIs for recovery. Platforms provide storage/query, not uniqueness
enforcement for this marker. Missing results cannot prove absence of a concurrent
or delayed write. The implementation requires one match, bounds paging, and
retains unknown outcomes. Feishu's 59-minute retry ceiling reserves a transport
margin; only a successful response with a message ID confirms delivery.
Feishu/WeCom webhook publishers have no implemented remote lookup protocol.

Code/test pointers: `packages/outputs/src/publication-journal.ts`,
`publication-journal.test.ts`, `gitea-assignment-live.test.ts`, server
`auto-commit-runtime.test.ts` and core `auto-commit-store-conformance.ts`.
All additional GitHub/GitLab/Feishu fault cases use local injected transports;
they do not constitute a new production integration acceptance.
