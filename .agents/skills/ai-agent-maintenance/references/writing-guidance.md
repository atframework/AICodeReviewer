# Writing guidance

Apply to repository prose in both public locales and AI-facing documents.
Match the reader, task, language and existing author voice. Clear, accurate
writing is the goal; words, punctuation and detector scores do not establish
authorship. Source scope and verification dates live in the
[authoring record](../../../../docs/ai/sources/authoring.md#editorial-guidance).

## Revision workflow

1. Identify the reader, purpose and facts that must survive the edit. Separate
   verified behavior, inference and unknowns; invent no sources, measurements,
   experiences or successful checks.
2. Correct facts and reasoning, then organization, then grammar and wording.
   Put decisions first in decision notes; retain useful intermediate steps in
   derivations, tutorials and investigations. Do not force three points,
   equal-length sections or a summary after every paragraph.
3. Name the object, action, conditions and result. Keep one name per concept.
   Replace abstract praise with supported behavior, not an invented benchmark.
4. Preserve supported author judgment, doubt, first person and register.
   Do not flatten every text into a neutral report or add fictional anecdotes,
   slang, emotion or deliberate errors to imitate a person.
5. Compare the revision with the original for semantic changes and repeated
   patterns across nearby headings, captions and navigation. Change only the
   affected passages; stop or revert when another pass adds no clear benefit.

## Current behavior

- Describe what the implementation does now. Superseded behavior and staged
  history belong in `CHANGELOG.md`, milestones or migration documentation.
- Preserve stable API/version identifiers and console UI names. Unfinished
  capabilities belong in the roadmap in `docs/ai/index.md`.
- Distinguish implementation, build checks, synthetic tests and real-service
  acceptance. Unverified, missing a real sample and checked-but-failed are
  different states; none means unsupported without further evidence.

## Headings and entry labels

- Use a noun or noun phrase, optionally with a concrete modifier, for document,
  section and product-card headings: `IM 集成示例` / `IM integration examples`,
  rather than the sentence `在团队群聊中查看评审结果`. This noun-heading convention
  is a repository preference, not a universal research finding. Body sentences
  still need clear verbs.
- Name the subject directly. Avoid sentence headings, questions, invitations,
  slogans and `从……到……` / `From … to …` or `先……再……` / `First … then …`
  coverage slogans. Preserve actual ranges and execution order in the body.
- Keep headings short and parallel at the same level. Use sentence case in
  English, no decorative emoji or final period, and no forced line breaks for
  responsive layouts. Check both languages at their actual display widths.
- Labels identify the destination or action: `快速上手` for that guide,
  `查看完整截图` for the full image. Buttons can use action verbs. Keep names
  consistent and merge duplicate destinations with identical actions; retain
  genuinely different operations. Do not imply an unverified action.
- Protect anchors when headings change; update affected links or retain an
  explicit anchor. Proper names, quoted headings and literal UI labels retain
  their required wording.

## Semantic preservation

- Preserve negation, conditions, quantities, units, range endpoints, ordering,
  causality, modality and verification status. `MUST`, `should` and `may` are not
  interchangeable. Three total attempts include the first call, leaving at most
  two retries.
- Preserve identifiers, config keys, environment variables, paths, protocol
  text, quotations and executable examples. Investigate functional defects
  separately from wording fixes.
- Keep limits and uncertainty that affect the conclusion. Never turn
  correlation into causation, an observation into a guarantee, or a completed
  operation into a successful one without support.
- Preserve accurate technical terms and supported criticism. Translate according
  to each language's syntax while retaining technical meaning. Do not rotate
  cache, copy, replica and view as synonyms.

## Wording review

Review these patterns in context; they are not automatic replacement rules:

- Empty openings, writing previews, canned conclusions and assistant chatter.
  Remove content that adds no fact, relationship, condition or useful action.
- Repeated sentence starts, nominalizations, nested modifiers and trailing
  `enabling` / `ensuring` / `highlighting` clauses. Restore a clear subject and
  supported relationship without producing disconnected fragments. Necessary
  transitions and passive constructions remain valid.
- `不是 A，而是 B` / `not X but Y`: retain real correction, distinction and
  exclusion; remove a contrast invented only for emphasis. Simplifying
  `不仅 A，而且 B` / `not only X but also Y` must preserve both facts.
- Unmeasured praise and vague attribution. State supported capabilities and
  identify the source of a claim; do not invent a benchmark to replace an adjective.
- Synonym cycling, stacked hedges, forced triads and decorative bold-label lists.
  Use paragraphs for reasoning, lists for parallel items or steps, and tables
  for comparisons or field mappings.
- Punctuation used for artificial emphasis. Choose commas, colons, parentheses
  and dashes for their actual function; no punctuation quota or random sentence
  variation makes a text more human.

### Project style checks

The existing site validator rejects the following wording as project style,
not as proof of AI authorship. Keep its checks intact; do not expand a lint
finding into a global replacement or silently weaken the gate. Quotations,
identifiers and accurate technical senses need contextual review.

English: delve, leverage, seamless, robust, streamline, unlock, elevate,
empower, cutting-edge, game-changer, realm, journey, crucial, vital,
comprehensive, utilize, facilitate, effortless(ly).

中文：强大、高效、灵活、便捷、丰富、完善、智能、优雅、无缝、轻松、极大地、
显著、至关重要、赋能、助力、打造、抓手。

Other cues such as tapestry, pivotal, landscape, foster, moreover, 核心、
全方位、落地、进行 and 综上所述 require contextual review, not a second
automatic ban list. A useful summary, accurate term or real transition can remain.

## Technical terminology

Software documents use 规范 for a specification, 约定 for interface behavior,
规则 for field constraints, 协议 for external formats and 验收标准 for acceptance.
Reserve 合同 for its legal meaning, quotations or existing identifiers.
Static fixture input is 测试数据 or 样本; retain fixture for actual test setup.
Describe timer operations as 设置、重启 or 再次注册 according to the interface.

For abstract terms such as 预算、水位、兜底、证据 or 门槛, identify the actual
quantity, threshold, fallback action, source, test result or prerequisite.
Preserve defined financial budgets, stream watermarks and other exact terms.
Distinguish retries from total attempts, deadlines from durations, and accepted,
committed, persisted and acknowledged states.

## Visual examples

- State what a screenshot demonstrates. Keep text readable at its rendered size,
  crop unused margins or select an excerpt, and preserve aspect ratio. Avoid a
  fixed-height frame that leaves a short image above a large blank area. Auto
  margins can move that blank area above the image without solving it. For
  equal-height rows, use matching crop ratios and shared caption/image/action
  tracks; verify their adjacency as well as the card height. Inspect mobile and
  desktop views, not source dimensions alone.
- Disclose excerpts and provide the full image or a detail view when needed.
  Preserve diagnostic text; distinguish real screenshots, rendered outputs and
  illustrations. Never fabricate a successful run.
- Captions, alternative text, labels and targets must agree. Content takes
  priority over decorative symmetry; screenshots need not have equal heights.
  The site's [report gallery](../../../../docs/site/src/components/IntegrationGallery.astro)
  uses content-specific crop coordinates and links to full originals.

## Milestones

Briefly state the problem and solution and link stable specifications. Retain
material validation failures, skips and scope limits. Omit reviewed-project
details, identities, operation logs and duplicate implementation descriptions.
Preserve historical dates, versions, commands and factual conclusions when
editing validation records. Version control retains the editing history.
