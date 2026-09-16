# MCP Sources

Read only the record for the external contract being changed. Dates describe the
last evidence check, not guaranteed current behavior. Retained records were not
revalidated by the 2026-09-12 layout change unless explicitly marked below.

## Model Context Protocol

- Sources:
  - <https://modelcontextprotocol.io/docs/getting-started/intro>
  - <https://modelcontextprotocol.io/docs/learn/architecture>
  - <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
  - <https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices>
  - <https://modelcontextprotocol.io/llms.txt>
- Evidence: MCP standardizes tool metadata/schema/results over host/client/server JSON-RPC. Validate inputs and trust boundaries; expose only configured tools. Protocol version and authorization changes require a source refresh.
- `last_checked`: 2026-05-18
- `next_review`: 2026-08-18
- `update_trigger`: Re-check when changing AICR MCP tool schemas, adding external MCP servers, changing authorization, or adopting a new MCP protocol version.

## Review metadata tools

- Sources checked on 2026-09-16:
  - <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
  - <https://git-scm.com/docs/git-rev-list>
  - <https://docs.gitlab.com/user/project/integrations/webhook_events/>
- Evidence: MCP tools declare object input schemas and return text/structured
  results; read-only annotations describe behavior but do not enforce access.
  Git `base..head` includes commits reachable from head excluding base ancestry;
  `--first-parent` would omit merged side history. GitLab MR and note payloads
  carry source/target projects separately. AICR's pending state replay is its
  own host workflow, not an MCP protocol requirement.
- `update_trigger`: Re-check on review-membership, tool-schema or webhook-identity changes.
