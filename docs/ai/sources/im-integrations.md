# IM application and callback source record

- last_checked: 2026-09-28
- next_review: before implementing application sends, callbacks, file directories or command admission
- update_trigger: platform payload/permission changes, rejected callback verification, mention delivery changes, SDK updates
- scope: planning evidence only; no application was configured and no real message was sent

This record supports the [IM design](../../design/im-integrations.md) and
[member directory design](../../design/member-directory.md). Existing Feishu sending and
directory evidence retains its own dates in [feishu.md](feishu.md).

## Official sources and verified boundaries

| ID | Primary source | Boundary checked |
| --- | --- | --- |
| W1 | [WeCom webhook messages](https://developer.work.weixin.qq.com/document/path/91770) | text/Markdown support userid mentions; phone list belongs to text; markdown_v2 does not support that mention syntax; this protocol exposes outbound webhook operations |
| W2 | [WeCom application sends](https://developer.work.weixin.qq.com/document/path/90236) | `message/send`, recipient fields, business errors and partial invalid/unlicensed recipients; finite duplicate checking; template-card response codes |
| W3 | [Application callback overview](https://developer.work.weixin.qq.com/document/path/90238) | Token/EncodingAESKey, encrypted GET challenge, 1-second verification, 5-second normal response, three retries; successful empty response permits later active reply |
| W4 | [Application message format](https://developer.work.weixin.qq.com/document/path/90239) | XML message identity and sender fields; ordinary app messages do not establish an arbitrary group chat ID |
| W5 | [Application event format](https://developer.work.weixin.qq.com/document/path/90240) | menu and template-card events, EventKey/TaskId; action fields participate in deduplication |
| W6 | [Create appchat](https://developer.work.weixin.qq.com/document/path/90245) and [send to appchat](https://developer.work.weixin.qq.com/document/path/90248) | self-built application and root-department visibility requirements; creation yields appchat ID; supported group message types must not be inferred from message/send |
| W7 | [API bot overview](https://developer.work.weixin.qq.com/document/path/101039) and [messages](https://developer.work.weixin.qq.com/document/path/100719) | independent callback API; msgid, aibotid, group-only chatid, chattype, typed sender identity, stream-refresh distinction |
| W8 | [API bot events](https://developer.work.weixin.qq.com/document/path/101027) | event envelope, template-card actions and optional group ID; event-specific fields must be parsed explicitly |
| W9 | [API bot active replies](https://developer.work.weixin.qq.com/document/path/101138) | verified callback may carry response_url; one call within one hour, not a permanent outbound channel |
| W10 | [Official Python sample archive](https://dldir1.qq.com/wework/wwopen/file/aibot_demo_python.tar.gz), linked by W7 | Python 3 GET and POST use empty receiveid; encrypted JSON input and reply envelope, signature and cipher framing inspected without running the sample |
| W11 | [WeCom global error codes](https://developer.work.weixin.qq.com/document/path/90313), checked 2026-09-28 | access-token whitelist for one refresh-and-retry is exactly `40014` (invalid) and `42001` (expired); `41001` (missing) is a caller bug; rate-limit codes `45009/45033/45036`; trusted-IP requirement surfaces as `60020` with `301042` (whitelist), effective one minute after admin configuration |
| W12 | [WeCom gettoken](https://developer.work.weixin.qq.com/document/path/91039), checked 2026-09-28 | `GET /cgi-bin/gettoken` returns `expires_in` 7200 s normally, token at most 512 bytes, must be cached per application; the platform may expire tokens early, so expiry-driven refresh is mandatory |
| W13 | [WeCom message/send limits](https://developer.work.weixin.qq.com/document/path/90236), checked 2026-09-28 | text and Markdown content cap at 2048 UTF-8 bytes with platform-side truncation (senders must split themselves); `touser` ≤1000, `toparty`/`totag` ≤100; partial invalid recipients return `invaliduser/invalidparty/invalidtag/unlicenseduser` with all-invalid `81013`; per member 30 msgs/min and 1000/hour, per app 账号上限数×200 人次/day; duplicate check window defaults 1800 s, max 4 h; interactive template-card `response_code` is single-use within 72 h; `task_id` ≤128 bytes over `[0-9A-Za-z_\-@]` |
| W14 | [WeCom appchat/send limits](https://developer.work.weixin.qq.com/document/path/90248), checked 2026-09-28 | supported types are text/image/voice/video/file/textcard/news/mpnews/Markdown and template_card is absent; text/Markdown cap at 2048 bytes; chatid groups must be created by the same self-built app whose visible scope is the root department; enterprise cap 20,000 recipients/min with per-member 200/min and 10,000/day silently dropped; the endpoint has no deduplication parameter or message ID |
| F1 | [Receive Feishu messages](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive) | im.message.receive_v1, sender_type, chat_id, p2p/@ permissions; deduplicate by message_id, not event_id |
| F2 | [Event overview](https://open.feishu.cn/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM) | HTTP and SDK long connection; 3-second event acknowledgment; retry intervals of 15 seconds, 5 minutes, 1 hour and 6 hours, at most four retries |
| F3 | [Callback overview](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/callback-subscription/callback-overview) | synchronous interaction with no event-style redelivery guarantee |
| F4 | [Card action callback](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication) | card.action.trigger, 3-second response, open_chat_id/open_message_id; card update token valid for 30 minutes and at most two updates |
| F5 | [HTTP event subscription](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/choose-a-subscription-mode/send-notifications-to-developers-server) | encrypted payload and verification token; challenge response within one second |
| F6 | [Receiving and verifying events](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-case) | signature hashes timestamp, nonce, encrypt key and raw request body; encrypted payload and token handling; challenge is a distinct verification path |
| F7 | [Custom webhook bot](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot) | webhook cards support URL navigation but not request callbacks; mentions require valid group-member open_id/user_id; external groups only support open_id |
| F8 | [Long-connection callbacks](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/callback-subscription/configure-callback-request-address) | official SDK callback transport exists; HTTP-first is a local scope decision |
| N1 | [Node 22 fs.watch caveats](https://nodejs.org/docs/latest-v22.x/api/fs.html#caveats) | platform/network/container differences, inode replacement, missing filenames and Windows directory removal behavior |
| P1 | [fast-xml-parser upstream](https://github.com/NaturalIntelligence/fast-xml-parser) and its [published advisories](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories), checked 2026-09-28 | upstream describes v4/v5 as functionally aligned and v6 as experimental; v5 exposes `processEntities: false` plus explicit expansion limits. 2026 advisory chain (DOCTYPE/entity expansion resets and bypasses, latest GHSA-8r6m-32jq-jx6q / CVE-2026-73569 affecting ≥5.9.3, patched in 5.10.1) makes DTD/entity rejection in the strict wrapper mandatory regardless of version |
| P2 | [YAML parser options](https://eemeli.org/yaml/#options) | AST/options provide a basis for duplicate-key and alias handling; strict JSON grammar still needs separate assertions |
| P3 | [saxes upstream](https://github.com/lddubeau/saxes) | repository shown archived on 2025-12-31; not selected as the default parser for new code |

Parser review on 2026-09-28 selected stable fast-xml-parser 5.x as a candidate only.
The IM-00 recheck on 2026-09-28 pinned `fast-xml-parser@5.11.1` (latest stable 5.x,
registry modified 2026-08-27) with a hard floor of 5.10.1 for CVE-2026-73569; the
implementation plan is `processEntities: false`, `preserveOrder: true`, explicit
DOCTYPE/ENTITY rejection before parsing, and the 256 KiB / 32-depth caps from the
implementation specification. No dependency was installed yet; installation happens in the
server package only, and the S01/S06 fixed vectors remain the proof obligation.
The upstream README is not proof that default parsing meets these requirements.
The [implementation specification](../../design/im-implementation-spec.md) fixes required
behavior; failure to meet it blocks the XML task instead of silently changing parsers.

## Retrieval and evidence limits

The web reader could not open WeCom pages. Direct HTTPS returned the official
rendered article for W1–W9; headings, tables and payload fields were inspected.
Feishu HTML declares `rel="alternate" type="text/markdown"`; its `.md` endpoints
provided the full articles above. Page redirects can change the topic:
the older request-url path currently describes long connections, so verify titles
instead of assuming the path still means HTTP configuration.
The official [Node SDK request handler](https://github.com/larksuite/node-sdk/blob/main/dispatcher/request-handle.ts)
was also inspected, but protocol claims above follow the official API articles;
SDK JSON reserialization is not a reason to discard the HTTP request's raw bytes.

The [API bot encryption page](https://developer.work.weixin.qq.com/document/path/101035)
returned its title without readable protocol content. W7's official archive provided
`aibot_demo_python3/demo_server.py` and `WXBizJsonMsgCrypt.py` as an alternate primary source.
They use empty receiveid for verification/decryption, lower-case `encrypt` input,
and an encrypted reply containing `msgsignature`, timestamp and nonce.
The sample verifies a sorted-field SHA-1 signature and uses AES-CBC framing with
32-byte padding. Use strict padding/length validation and secure randomness in the
implementation; the sample is protocol evidence, not a production security template.
Archive SHA-256: `c69092b70916c8eba3f8cfeb08e8116540888b5403915e36236c32cc78082171`.
No sample code or cryptographic test was executed. P0/P3 must create positive and
negative vectors, and P6 must verify the actual tenant callback.
The 2026-09-28 IM-00 pass closed the token error-code allowlist (W11) and the
tenant trusted-IP requirement (W11/W12); per-tenant network reachability and actual
visibility/licensing still need the controlled live acceptance.

W1's outbound protocol does not specify a traditional webhook inbound callback.
The design therefore selects the separate API bot for interactive WeCom requests;
it does not claim every product branded “robot” has the same capability.
Similarly, no source here promises that an API bot chatid works with appchat/send.
The conservative capability mapping must be checked in the actual test tenant.

Temporary source extracts and the fetch helper live under
`build/tmp/im-design-research/`; they are research artifacts, not permanent fixtures.
Use the source links to refresh evidence. Full copied vendor pages are not committed.

## Local decisions, not vendor promises

The proposed 1-second internal admission target, 5-minute request replay window,
7-day receipt retention, 24-hour button validity, directory size limits and watch/poll
intervals are AICR design choices. Tests must prove their behavior and compatibility
with real platform delivery. File directories do not verify live membership or
authorize commands. Finite duplicate-check windows and local transactions cannot
establish exactly-once remote message delivery.

Relevant current implementation: outputs `channel-identity.ts`, `feishu-app.ts`,
`index.ts`, `publication-journal.ts`; server `bootstrap.ts`, `runtime-config.ts`,
`runtime-queue.ts`, `observability-api.ts`; core `config.ts`, `review-event.ts`,
`queue.ts`, `queue-worker.ts`. Regression extensions are enumerated in the design;
their enumeration is not implementation or test evidence.
