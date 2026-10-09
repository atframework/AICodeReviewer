# Feishu application API

- last_checked: 2026-09-21 (authentication, send, directory); 2026-09-22 (recall, UUID deduplication)
- next_review: before changing authentication, message or directory contracts
- update_trigger: API errors, permission changes, card rendering changes, SDK model changes

Official documentation entrypoints:

- [Tenant token](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal)
- [Send message](https://open.feishu.cn/document/server-docs/im-v1/message/create)
- [Recall message](https://open.feishu.cn/document/server-docs/im-v1/message/delete)
- [Group members](https://open.feishu.cn/document/server-docs/group/chat-member/get)
- [User profile](https://open.feishu.cn/document/server-docs/contact-v3/user/get)
- [Card Markdown](https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags)

The HTML pages expose a `rel="alternate"` link to their `.md` counterpart.
On 2026-09-21, those official Markdown endpoints provided the full API and field
permission tables even though the web reader returned empty HTML bodies.
Use a direct HTTP read of that declared alternate when verifying these contracts.
Request paths and field shapes were also checked against the official
[Python SDK](https://github.com/larksuite/oapi-sdk-python/tree/v2_main/lark_oapi):
`core/token/manager.py`, `api/im/v1/model/create_message_request_body.py`,
`get_chat_members_request.py`, `get_chat_members_response_body.py`,
`api/contact/v3/model/get_user_request.py` and `user.py`.
The official [Go SDK constants](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/core/constants.go)
identify `99991663` as invalid tenant token and `99991671` as invalid access
token; only these explicit rejections permit one token-refresh retry.

The application message API accepts a serialized card in `content`, with
`receive_id`, `msg_type` and `uuid`. Membership uses `member_id_type=open_id`,
`has_more` and `page_token`; a security-limited list is incomplete. Profile data
includes `name`, `en_name`, `nickname`, `email`, `enterprise_email`, `mobile`,
`open_id`, `user_id` and `union_id`. Fields are optional in the SDK; schema
presence does not establish tenant permission or visibility.

The send page's declared Markdown alternate was checked again on 2026-10-08:
card/rich-text requests are capped at 30 KB, including JSON escaping of `content`.
Webhook requests have a separate 20 KB cap in the
[custom bot guide](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot).
The report renderer measures outgoing UTF-8 requests, reserves native mentions,
detail links and actions, and marks truncation only when that limit is exceeded.
Local boundary tests are in `packages/outputs/test/im-report-limits.test.ts`;
they do not establish platform rendering or delivery.

The send page's Markdown alternate specifies a UUID limit of 50 characters and
a one-hour deduplication period. Automatic batch recovery uses a stable UUID
within 59 minutes; see [publication contracts](publication-reconciliation.md).

For AICR's application identity, use `im:message:send_as_bot` for sends and
`im:chat.members:read` for membership. The user-profile API accepts
`contact:contact.base:readonly` as an entry permission; `contact:user.base:readonly`
is a separate field grant for name, English name and nickname. Email uses
`contact:user.email:readonly`, enterprise email uses `contact:user.employee:readonly`,
mobile uses `contact:user.phone:readonly`, and user ID uses
`contact:user.employee_id:readonly`. Do not substitute a field grant for an API
entry grant or assume the two email fields share one permission. The API pages
list broader alternatives; the public guide documents the selected combination.
The user-profile page's `41050` guidance requires contact data scope, separate
from app availability. Bots must belong to both configured groups and be allowed
to speak in the destination; production app changes require publication/approval.

Implementation and local regression evidence: `packages/outputs/src/feishu-app.ts`,
`feishu-members.ts`, `packages/outputs/test/feishu-app.test.ts` and
`packages/server/test/feishu-app-publishing.test.ts`. Actual tenant grants,
field visibility, JSON 2.0 mention delivery, and recipient availability depend on
the tenant. The opt-in `feishu-app-live.test.ts` checks directory/profile reads,
sends one real card and recalls it. The official recall endpoint accepts DELETE
with the tenant token and `im:message:send_as_bot` for the bot's own message.
This tenant's acceptance and remaining mention boundaries are recorded in M30.

Event subscriptions, card callbacks, webhook mention limits and long-connection
options were separately checked on 2026-09-28 for the pending IM design. See the
[IM source record](im-integrations.md); that research does not establish callback
runtime support or refresh the older send/directory acceptance above.
