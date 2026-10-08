# Design

This page describes what the code in `src/` does, checked against Pi 1.0.3. The Jev questions and the
evidence behind the thresholds are in [JEV.md](JEV.md). Cache behaviour is in [CACHE.md](CACHE.md).

## Module map

| Module | Role |
|---|---|
| `src/index.ts` | The only module that uses the Pi API: hooks, `recall` tool, `/guard` command, status bar, classifier lookup |
| `src/config.ts` | `DEFAULT_CONFIG`, validation (`normalizeConfig`), load/save of `context-guard.json`, `provider/id` parsing |
| `src/run.ts` | `collectRun`: finds the run that just finished, its question, answer, notes and candidate tool results; the shared span and candidate rules |
| `src/checkpoint.ts` | Mid-run checkpoints: eligible outputs (`collectCheckpoint`), superseded detection, the memo and pending edits from the branch, the read point, the break-even rule |
| `src/chunk.ts` | `chunkOutput` (grep-aware chunking) and `segmentChunks` (grouping chunks into Jev requests) |
| `src/decide.ts` | `buildRequest` (the run-end Jev request), `buildCheckpointRequest` (the mid-run one) and `interpret` (answers → keep set); `citedFiles` |
| `src/distill.ts` | `distillRun`: chunk, run Jev requests in parallel within a time budget, decide per result, build `context_edit` drafts |
| `src/items.ts` | Whole items: small outputs (`collectSmall`) and old exchanges (`collectExchanges`), their Jev requests, stubs and edits, and `judgeItems` (batched, parallel, time budget) |
| `src/process.ts` | `processItems`: large outputs, small outputs and old exchanges of one pass, judged in parallel and merged into one list of edits and records |
| `src/render.ts` | The replacement text: header, verbatim chunks, omission lines; the `[context-guard]` marker |
| `src/cache-pin.ts` | Anthropic breakpoints: the previous user question, and the read point after edits (`placeGuardBreakpoints`) |
| `src/stats.ts` | Savings and Jev usage computed from the session; status-bar text |
| `src/recall.ts` | The text returned by `recall` (a tool output, or the transcript of an omitted exchange) |
| `src/types.ts` | Loose structural types for the Pi objects used, so the pure modules can be tested without Pi |

Everything except `index.ts` is pure. `distillRun` gets the classifier as an injected function.

## The boundaries: `agent_before_settle` and `turn_end`

Run-end distillation happens in `agent_before_settle`, and only when `event.outcome === "completed"` and
the guard is on. Long runs also get mid-run checkpoints at `turn_end` (see
[Mid-run checkpoints](#mid-run-checkpoints)); everything below about drafts applies to both.

Why there:

- The final answer exists, so relevance can be judged against it. Pruning during a run would take raw
  data away from the model while it still needs it, and every edit would break the prompt cache again.
  Mid-run checkpoints accept those costs only for outputs that are several turns old, in rare batches,
  and only when the break-even rule says they pay off.
- A boundary handler can return session entry drafts. A `context_edit` draft is append-only: it changes
  only what the model sees from then on. The raw entry stays in the session file, the UI and exports, and
  `ctx.sessionManager.getEntry(id)` still returns it. That is what `recall` reads.
- Edits are branch-relative. After `/tree` to a point before the edit, the model sees the original again.
  Compaction works from the edited projection.
- The handler is awaited, so Jev's latency delays settling (measured 0.5–1.2 s; capped by `timeoutMs`).

**The runner replaces the draft list with the handler's return value.** The handler therefore returns
`{ entries: [...event.entries, ...edits, record] }`, which keeps drafts from other extensions. It never sets
`continue`.

Hooks used:

| Hook | Use |
|---|---|
| `session_start` | Load settings, check the classifier model and credential, draw the status |
| `turn_end` | Mid-run checkpoint, when a batch is due |
| `agent_before_settle` | Distill the finished run (skipping outputs judged mid-run) |
| `before_provider_request` | Anthropic breakpoints (only for `anthropic-messages` models) |
| `session_tree`, `session_compact` | Redraw the status (checkpoint state is read from the branch anyway) |
| `agent_settled` | Redraw the status |

## Algorithm

### 1. Run span

`collectRun` walks back through `event.context.contextEntries` (Pi's projected entries) to the user
message that started the run (`findRunStart`), with or without text. **Steering messages** (user messages
sent while the agent was working: the message before them, custom notices aside, is a tool result or an
assistant message with tool calls) do not start a run; the walk goes on to the prompt before them. The
**question** is that prompt's text followed by every steering message of the run, each prefixed with
`[The user added during the run]`; a message with only an image gets the placeholder
`[the user sent only an image]`, so an older question is never reused. Everything after the prompt is the
run. Assistant
text in the run gives the **answer** (the last text) and the **notes** (all earlier text). Tool calls are
indexed by id so each result can be matched with its tool name and arguments.

**History.** The projected entries *before* the run's user message give the **history** (`historyExchanges`,
default 3; `0` turns all of it off):

- `summary`: the text (`summary` field) of the latest `compactionSummary` or `branchSummary` message, at
  most 2,000 characters.
- `exchanges`: the last N earlier exchanges, oldest first. Every user message starts one (steering messages
  of earlier runs included; an image-only prompt shows as `[the user sent only an image]`). Each holds the prompt (at most
  800 characters) and the **last** assistant text before the next user message (at most 1,200). Tool calls
  and tool results are left out.
- `firstRequest`: the first user prompt in the projection (at most 1,000 characters), only when it is not
  already one of the included exchanges. It often states the goal of the whole session.

Clipping keeps the head (70%) and tail with a `[…]` line in between.

### 2. Candidates

A tool result in the span is a candidate if all of these hold:

- its entry projects to exactly one `toolResult` message,
- it has only text blocks (no images), and it is not an error result unless `distillErrors` is on (the
  default: the log of a failing test or build is often the biggest output of a run, and stale once the
  agent got past it),
- its tool is not in `excludeTools` (`edit`, `write`),
- its model-visible text has at least `minResultChars` (4,000) characters,
- it does not start with `[context-guard]`, meaning it was not distilled already,
- its model-visible text equals the raw entry's text. A result another extension already edited is left
  alone: `recall` returns the raw entry, so anything that edit added could not be recovered.

The run is skipped without any Jev request if there are no candidates, or if their total length is below
`minRunChars` (8,000).

### 3. Chunking (`chunk.ts`)

The target chunk size is `max(800, ⌈length / 120⌉)` characters. It stops at 4,000 unless the output is
larger than about 480k characters, so an output never has much more than 120 chunks.

**grep-style output.** An output counts as grep-style when it has at least 3 non-empty lines (ignoring `--`
separators) and at least 60% of them look like `path:line:` or `path-line-`. Such output is grouped by file:

- Context lines (`path-line-`) are matched to the longest file name already seen in a `path:line:` match.
  This handles names like `2024-05-01-post.md`.
- Separators, blank lines and unmatched lines stay with the current group.
- A group larger than 1.5× the target is split into windows. Every piece names the file.
- A group smaller than a quarter of the target is merged with neighbouring small groups, up to half the
  target.
- Any other group becomes one chunk.

**Other output** is cut into windows of about the target size. If a blank line falls in the last 40% of a
window, the window ends after it. A single line longer than the target becomes its own chunk.

**Segments.** Consecutive chunks are grouped into segments of at most `maxSegmentChars` (32,000)
characters and `maxChunksPerSegment` (40) chunks. A chunk larger than the limit (one huge line) gets a
segment of its own, which is **never sent**: it is kept as it is, with reason `oversize`.
Jev's context window is 32k tokens. The worst case (every history part full at the default 3 exchanges,
a 4k question, a 6k answer, 2k notes and a 32k-character, 40-chunk grep segment) measured 19,630 input
tokens; with `historyExchanges` 10 it was 23,619 (docs/JEV.md).

### 4. One Jev request per segment (`decide.ts → buildRequest`)

The request **state** contains:

| Field | Content |
|---|---|
| `situation` | A fixed explanation: a coding agent answered the question; this is one tool output split into chunks; only kept chunks remain visible. With history it adds that `earlier_conversation` shows the session so far and the agent is likely to continue that work |
| `earlier_conversation` | Only when there is history: `{ summary, first_request, recent_exchanges: [{ user, assistant }, …] }`, empty parts omitted |
| `user_question` | The question, at most 4,000 characters (head and tail kept) |
| `final_answer` | The answer, at most 6,000 characters |
| `agent_notes_during_the_run` | Earlier assistant text, at most 2,000 characters (only if there is any) |
| `tool`, `tool_arguments` | Tool name; arguments as JSON, at most 600 characters |
| `tool_status` | Only for error results: says the call failed, and that its details are usually no longer needed if `final_answer` shows the agent got past the failure |
| `output_size` | Line count, plus "part i of n" when the output has several segments |
| `chunks` | `{ "chunk_1": "…", "chunk_2": "…" }` with chunk numbers counted across the whole output |

The **questions**, all in the same request:

| Id | Type | Asks |
|---|---|---|
| `keep_whole` | bool | Is all of the output still needed, so that removing any chunk would lose evidence or follow-up information? |
| `focus` | choice: `whole`, `none`, `chunk_N`… | Does the answer draw on most of the output (`whole`), on nothing (`none`), or on a few chunks, of which `chunk_N` is the most important? |
| `chunk_N` | bool, one per chunk | Does this chunk contain lines the answer relies on, or that a likely follow-up would need? |

With history, the questions also name the earlier conversation next to `final_answer`: `keep_whole` and
`focus` mention "the ongoing work in earlier_conversation", and each `chunk_N` asks "…lines that
final_answer relies on, or that the user's ongoing task in earlier_conversation will need, even if the
current question is about something else?" (the measured wording, docs/JEV.md). Without history the wording
is exactly the single-run wording that was tuned on live cases.

### 5. Decision per segment (`decide.ts → interpret`)

In this order:

1. If the request did not stop normally, **keep everything** (reason `error`). If `keep_whole` or `focus`
   is missing, **keep everything** (`no-answer`).
2. If P(`keep_whole`) ≥ `keepWholeThreshold` (0.7), **keep everything** (`whole-needed`).
3. If `focus` chose `whole` with probability ≥ `focusWholeThreshold` (0.6), **keep everything**
   (`whole-chosen`).
4. Otherwise, the keep set is every chunk whose P(`chunk_N`) ≥ `chunkKeepThreshold` (0.6), plus the chunk
   `focus` chose, if it chose a chunk. The focus chunk is kept whatever its probability.
5. If `focus` chose `none` with probability ≥ `noneThreshold` (0.5) and the keep set is empty, **remove
   the segment** (`none-needed`).
6. If the keep set is empty and `focus` chose a weak `whole`, **keep everything** (`whole-chosen`).
7. If the keep set is still empty (a weak `none`), keep the chunk with the highest `focus` probability.

### 6. Decision per result (`distill.ts → decideCandidate`)

- The keep sets of all the result's segments are combined. A segment that failed or ran out of time keeps
  all its chunks; the other segments are still used.
- If every chunk is kept, there is no edit.
- If `keepCitedFiles` is on, chunks of files that the answer names are added.
- If the kept chunks are more than `maxKeepRatio` (0.6) of the original length, there is no edit
  (`not-worth`). An edit that saves little is not worth the cache miss or the lost context.
- If the rendered replacement is not shorter than the original, there is no edit (`not-worth`).
- Otherwise the result is `distilled`, or `removed` if no chunk was kept.

### 7. Time budget, concurrency and failures

- Segments run through a pool of `concurrency` (6) parallel requests.
- `timeoutMs` (8,000) is the budget for **all** requests of the run. Each request also gets it as its own
  timeout, with one retry. When the budget runs out, no new requests start, running ones are aborted, and
  each request is raced against the deadline, so a provider that ignores the abort cannot hold up settling.
  An answer that arrives after the deadline is ignored.
- Unstarted, aborted and failed segments keep their chunks (reason `timeout` or `error`).
- If the parent signal (`ctx.signal`) aborts, the run stops the same way. In Pi 1.0.3 the agent's signal is
  usually already cleared at this boundary, so Esc does not cancel it; the time budget is the limit.
- An exception from the whole pass shows a warning and leaves the run untouched.

## Items: what one pass judges

Every pass (run end, or a mid-run checkpoint) collects three kinds of item and judges them in parallel
(`processItems`); their edits and results go into one record.

| Kind | What | How it is judged | Dropped item becomes |
|---|---|---|---|
| `large` | Tool results of the current run of at least `minResultChars` (4,000), under the candidate rules above | Chunked, one request per segment (above) | The kept chunks verbatim with omission lines |
| `small` | Tool results of the current run from `smallResultMinChars` (400) up to `minResultChars`, under the same rules | Whole: one bool per item, many items per request | A one-line stub: `[context-guard] Omitted the output of bash \`…\` (1.2k chars): judged no longer needed. Full output: recall({"entryId":"…"}).` |
| `exchange` | Old exchanges (below) | Whole: one bool per exchange, several per request | A stub on the prompt, every other entry omitted |

**Small outputs** (`collectSmall`). An output whose stub would not be shorter is skipped. Each item carries
the tool label, `status: failed` for error results, `superseded` when a later call made it out of date
(`supersededBy`, as for large outputs mid-run), and the output (at most 4,000 characters). The question is
"will the agent still need the output in item_N?" mid-run, or "does item_N contain anything that
final_answer relies on, or that a likely follow-up would need?" at run end; both say that an output marked
superseded is out of date. An item is kept when P ≥ `smallKeepThreshold` (0.45; probe in
[JEV.md](JEV.md#small-outputs)). Mid-run, small outputs follow the same age rule and memo as large ones; at
run end every small output without the marker is judged, including those kept at a checkpoint.

**Old exchanges** (`collectExchanges`). An exchange is a user prompt and every entry up to the next one:
assistant messages, tool calls and results, custom messages such as subagent notices. Eligible are
exchanges before the current run's user message, without the last `keepRecentExchanges` (2) before it,
that completed (their last assistant message has no tool calls; a steering message belongs to the exchange
it was sent in), that are not already omitted (their prompt shows the stub), that were not judged during the
current run (`exchangeMemo`: exchange results in records after the run's prompt, except deferred ones), and that can be recovered and are worth it: no message with an image, no entry whose model-visible
content differs from the raw entry for any reason other than our own marker (another extension's edit,
or an omission by someone else, which Pi keeps in the projection as an entry with no messages), at least
2,000 characters of editable content, and a stub shorter than that content. A kept exchange is
judged again in a later run, against that run's work. Compaction and branch summaries are never part of an
exchange; entries Pi cannot edit (system messages, `!` shell executions) stay in place.

Jev sees the current work (`user_question`, `earlier_conversation`, and `agent_progress` mid-run or
`final_answer` at run end) and, per exchange, the prompt (at most 600 characters), the last assistant text
(800), the tool calls as `toolLabel()`s (at most 20) and the size. The question: "Is exchange_N still
relevant to the current work? Relevant means the agent may need its details: the same files, task,
decisions or facts." An exchange is omitted only when P < `exchangeOmitThreshold` (0.2; probe in
[JEV.md](JEV.md#old-exchanges)). Then the prompt entry gets the stub
`[context-guard] Omitted an earlier exchange judged unrelated to the current work: "<first 120 characters of the prompt>" (N messages, ~Mk tokens). Full exchange: recall({"entryId":"<prompt entry id>"}).`
and every other editable entry gets `replacement: null`, which omits it from model context. The record's
result for the exchange lists exactly those entry ids (`omitted`), and `recall` on the stub shows exactly
the prompt and those entries. Tool calls and
their results are omitted together. The resulting shapes (a stub user message right before the next user
message; spans without assistant and tool-result messages) are accepted by Anthropic (with
`pi-claude-auth`) and OpenAI Codex, checked live with `test/e2e/omit-probe.ts` and the `topics` scenario.

**Run-end break-even for exchanges** (`exchangeBreakEven`, on). After the pass is judged, its exchange
omissions are checked: their marginal cache cost is the rewrite with them minus the rewrite the pass's
other edits cause anyway (`rewriteCharsFor`, with the trusted read point and floor rules of
[CACHE.md](CACHE.md); on OpenAI Codex any edit costs the whole context, so exchanges ride along for free
when the pass edits anything else). If that cost is above zero, the omissions must save at least
`exchangeMinSavingChars` (8,000) and pass `paysOff` with as many later requests as the session has had so
far (model-visible assistant messages). Otherwise they are deferred: their edits are dropped, their results
say `kept` / `deferred`, and they are judged again at later run ends against the work of that run, so
deferred exchanges accumulate until their total pays off. `exchangeBreakEven: false` always omits
unrelated exchanges.

**Batching.** Whole items are grouped into requests of at most `maxSegmentChars` characters of item text and
`maxChunksPerSegment` (40) items, under the same `timeoutMs` budget; the three kinds run at the same time,
and one shared limiter keeps at most `concurrency` (6) Jev requests in flight across all of them. An item without an
answer (error, timeout) is kept and asked again next time.

## Mid-run checkpoints

A 30–120 minute autonomous run would otherwise carry every tool output until it ends; Pi compacts only
near the window minus 16k tokens. Checkpoints judge older outputs while the run is still going.

**Hook (verified on Pi 1.0.3).** `turn_end` is an actionable boundary (`TurnEndEvent extends
BoundaryState`). `agent-session.js` dispatches it from `agent.finishTurn`, commits the returned drafts
(`_commitBoundaryDrafts` → `_refreshFinalizedContext`), and only then runs `prepareNextTurn`, which rebuilds
the messages from the session projection and runs the turn-end compaction check
(`_compactBeforeNextAssistantResponse`). So a `context_edit` returned at `turn_end` reaches the very next
provider request, before any compaction decision; the e2e runs confirm it (the next request's context
drops by the removed amount). The runner replaces the draft list as for `agent_before_settle`, so the
handler returns `[...event.entries, ...edits, record]`, and it never asks for `continue`.

**When.** At the end of a turn whose assistant message has tool calls (the final turn of a run is left to
run-end distillation), with `outcome: "completed"` and `midRun` on:

1. **Eligible items:** large outputs (`collectCheckpoint`) and small outputs (`collectSmall`) of the current
   run whose call was made at least `midRunMinAgeTurns` (4) turns before the current turn (turn = assistant
   message index in the run) and that are not in the memo, and old exchanges not judged during this run.
2. **Batch:** their total must reach `midRunBatchChars` (60,000; `midRunBatchCharsOpenAI` for
   `openai-codex` models), so edits come in rare batches.
3. **Break-even** (`midRunBreakEven`): the checkpoint must be likely to pay for its one-time cache
   rewrite: `pending chars × turns so far ≥ factor × rewrite chars`, with factor 13 and the whole context
   for OpenAI Codex; factor 16 for Anthropic, where the rewrite is the context after the read point the
   next request would get (the latest trusted entry before the first eligible output, `trustedReadPoint`)
   or, without one, after the question (the floor; with `pinAnthropicCache` off, the whole context); and
   factor 16 and the context from the first eligible output on for other providers
   (derivation in `checkpoint.ts` and [CACHE.md](CACHE.md#mid-run-checkpoints)). "Turns so far" stands in
   for the turns still to come. The rewrite starts at the earliest edited entry: an old exchange comes
   before the question, so with exchanges in the batch the Anthropic rewrite is everything after the latest
   trusted entry before that exchange, or the whole context. If the whole batch does not pay off, the rule
   is tried for the tool outputs alone, and the exchanges wait for run end.

Then all eligible outputs go to `distillRun` with the checkpoint request builder and
`chunkKeepThreshold = midRunChunkKeepThreshold` (0.6), under the same `timeoutMs` budget, abort signal and
keep-on-error rules, with the busy status and working message shown.

**The checkpoint request** (`buildCheckpointRequest`; separate from the run-end request): there is no final
answer yet. The state holds `situation` (the agent is still working; this is an earlier call's output),
`earlier_conversation`, `user_question`, `agent_progress` (`latest_note`: the latest assistant text, at
most 2,000 characters; `earlier_notes`: earlier text of the run, clipped from the start to 2,000),
`later_tool_calls` (labels of the calls made after this output, oldest first; above 30 the first and last
15 with a gap note), `superseded` when it applies, and then tool, status, arguments, size and chunks as at
run end. The questions ask whether the agent will still need the output (or chunk) to finish
`user_question`; out-of-date lines and lines it has already acted on and moved past are not needed. The
probe behind the wording and the threshold is in [JEV.md](JEV.md#checkpoint-wording).

**Superseded** (`supersededBy`), judged from the later tool calls: a `read` whose file was later changed by
`edit`/`write` ("this file was changed after this read (edit src/a.ts, 3 turns later)") or read again with
the same offset and limit; a command that ran again (whitespace and a trailing `2>&1` normalized); any other
tool called again with identical arguments.

**State from the branch.** The memo and the pending edits are derived, at that moment, from the entries
persisted on the active branch (`ctx.sessionManager.getBranch()`). A boundary's drafts are not final: a
later handler can replace the list, and one invalid draft makes Pi discard all of them; state taken from
the returned drafts would then skip those outputs forever. Reading the branch also makes `/tree`,
compaction and reloads correct without any rebuild step. The only in-memory state is the log of cache
entries this process wrote (below), which only ever adds a read point.

**Memo.** Each output is judged mid-run at most once. The memo is the set of output results in the mid-run
records on the branch, except those Jev never answered for (`timeout`, `error`, `aborted`), which the next
checkpoint asks again. A "keep" is therefore not re-asked at every checkpoint. Old exchanges have their own
memo per run (see Items).

**Run end judges kept outputs again.** An output kept at a checkpoint (whole, or `not-worth`) is a
candidate again at run end, this time with the final answer: files the agent was still editing are usually not
needed once the task is done. Distilled outputs carry the marker and are skipped by the candidate rules.

**Anthropic breakpoints** (`placeGuardBreakpoints`). Every Anthropic request gets the previous-question
pin (the floor; with `pi-claude-auth` that block also carries the relocated system prompt). On the first
request after **pending edits** (`context_edit` entries on the branch after the last answered assistant
message, whether from a checkpoint, from run end on the next prompt, or from another extension; a failed or
aborted response does not count, since its retry repeats the request), `cacheAnchors` adds up to two more:

- **Read point**, only at a cache entry this process saw itself write. After placing its breakpoints, the
  extension records every `tool_result` block that carries a breakpoint in the payload (Pi's rolling one
  and its own): entry id, model, time, and the last branch entry at that moment. An entry is trusted only
  if the same model wrote it, or read through it, within the TTL (5 minutes), the entry and that last
  branch entry are still on the branch, and since then no `context_edit` touched anything at or before it
  and no compaction or branch summary was appended. The latest trusted entry before the first edited entry
  is the read point. The log is cleared on `session_start` (and so on reload); anything uncertain falls
  back to the question pin.
- **Refresh on read-through** (`message_end`, `refreshOnReadThrough`): reading a longer prefix keeps the
  entries on its path alive (CACHE.md), so a response moves a logged entry's time to its request's time
  when the request went to the same model, the entry's prefix is unchanged, and `cacheRead` reaches past
  the entry with a margin: at least the run's baseline (the full input of its first request: system prompt,
  tools, question) plus the projected characters from the question to the entry divided by 1.5. Code and
  logs run at about 2.3 characters per token and prose at about 4, so this overestimates the tokens up to
  the entry. Without a baseline, or with any doubt, nothing is refreshed.
- **Write anchor:** the end of the tool-result batch holding the first edited entry, so the edited prefix
  gets an entry that a later checkpoint can read. It counts as written only once it was seen in a request
  the extension sent (the same log).

Priority under the 4-breakpoint budget: after dropping Pi's redundant identity and tools breakpoints, the
question comes first, then the read point, then the write anchor. Cache-warming replays add no assistant
message, so they get the same breakpoints. Measured effect and the TTL findings:
[CACHE.md](CACHE.md#mid-run-checkpoints).

## Replacement format (`render.ts`)

Kept chunks are copied verbatim, in order. Each run of removed chunks becomes one omission line. For
grep-style output, the omission line names the files (up to 5, then "and N more"). For `read`, it gives file
line numbers, using the call's `offset`. For anything else, it gives output line numbers. An illustrative
example (the numbers are made up):

```text
[context-guard] Distilled the output of bash `rg -n -i status`: kept 9 of 410 lines (1.2k of 36.1k chars); the rest was judged not needed for the answer. Full output: recall({"entryId":"3f9c2a1b"}).
[… 52 lines omitted: matches in logs/worker.log, src/api/buildStatus.ts, src/api/jobStatus.ts, src/store/jobStatusReducer.ts, test/fixtures/entities.json and 14 more …]
src/pages/OrdersPage.tsx:35:      <StatusBadge label={order.status} tone={order.status === "failed" ? "danger" : "success"} />
src/pages/ServerListPage.tsx:35:      <StatusBadge label={server.health} tone="warning" pulse={server.degraded} />
[… 301 lines omitted: matches in src/store/orderStatusReducer.ts, … …]
```

If nothing is kept, the whole output is replaced by a single line:
`[context-guard] Removed the output of <label>: N lines (S chars) judged not needed for the answer. Full output: recall({"entryId":"…"}).`

The draft is `{ type: "context_edit", targetId, replacement: { content: [{ type: "text", text }] } }`.

## The `context-guard` record

Each run (and each mid-run checkpoint) that made at least one Jev request also appends a custom entry
(`customType: "context-guard"`):

| Field | Meaning |
|---|---|
| `v` | Format version, `1` |
| `phase` | `"mid-run"` for checkpoints, `"run-end"` otherwise (a record without it counts as run end) |
| `model` | Classifier used |
| `savedChars` | Characters removed by this run's edits |
| `requests`, `inputTokens`, `costUsd`, `ms` | Jev usage for the run |
| `timedOut` | The time budget ran out |
| `results[]` | One per item: `kind` (`large`, `small`, `exchange`; absent means large), `entryId` (for an exchange, its prompt entry), `tool`, `label`, `outcome` (`distilled`, `removed`, `kept`), `reason`, `beforeChars`, `afterChars`, `jev` |

`reason` is one of `chunks`, `none-needed`, `not-worth`, `all-chunks`, `whole-needed`, `whole-chosen`,
`no-answer`, `error` or `timeout` (several are joined with commas) for large outputs, `needed` or
`not-needed` for small outputs, and `relevant`, `unrelated` or `deferred` for exchanges (an omitted exchange's
result also has `omitted`, the entry ids that got `replacement: null`). Whole items have the trace
`p.06` (P of the bool). `jev` holds one trace per segment, such as
`kw.15 focus=chunk_4:.52 keep 9/29` or `kw.82 focus=whole:.71 keep all (whole-needed)`. That is
P(`keep_whole`), the focus choice and its probability, and the result. `/guard` prints these for the last
record (run or checkpoint) and counts the checkpoints.

The extension does not write Jev's usage into Pi's own usage entries. It is recorded only here.

## Statistics (`stats.ts`)

Nothing is kept in memory. Every redraw recomputes from the session:

- **Savings:** Pi's session projection (`buildSessionProjection()`) is checked for tool results whose
  model-visible text starts with `[context-guard]` while the raw entry does not; each one adds raw length
  minus visible length. A prompt that shows the exchange stub adds the raw length of its exchange (the
  prompt and the entries up to the next user message that the model no longer sees: Pi keeps an omitted
  entry in the projection with no messages) minus the stub.
  Tokens are estimated as characters ÷ 4.
- **Jev usage:** the `context-guard` records on the active branch (`getBranch()`) are summed.

So the numbers follow branches, `/tree`, reloads and compaction.

The ready-state footer is `🛡 −4.2k · 1`: ≈ tokens kept out of context · distilled outputs plus omitted
exchanges (the first part
in the theme's success colour, the rest dimmed). Before anything is distilled it shows `🛡 0 saved`.

## Recall

`recall` reads the raw entry with `ctx.sessionManager.getEntry(entryId)`. `context_edit` never changes that
entry. For a tool result it returns the output; for a user prompt (the stub of an omitted exchange) it
returns a transcript of the raw exchange from the branch: `## user`, `## assistant` with the text and
`[tool call] name {arguments}` lines, `## tool result (tool)` and `## custom message (type)` sections, for
exactly the entries the latest record lists as `omitted` (without such a record, up to the next user
message). The tool returns the whole text, or only lines that match `pattern` (with line numbers), or an
`offset`/`limit` window. Output is capped at 2,000 lines and 50 KB, with a continuation note; a single
line longer than 50 KB is cut with a `[line N cut at 50KB]` note. `pattern` is a JavaScript regex of at most
500 characters, matched against the first 4,000 characters of each line inside a `node:vm` sandbox with a
1-second timeout, so a catastrophic pattern returns an error instead of freezing Pi. An id that is
neither a tool result nor a user prompt on the branch gives an error that tells the model to use the id
from a `[context-guard]` note.

## Pitfalls

- **Never advance state on returned drafts.** A later handler may replace them, or Pi may reject the list;
  read state back from the branch.
- **Never omit half of a tool call.** `replacement: null` on a tool result alone would leave its `tool_use`
  without a result, and providers reject the request. A single output that is not needed is replaced with
  a one-line stub; `null` is only used for whole exchanges, which omit the assistant message with the call
  and its results together.
- **Never replace an assistant message's content.** A replacement turns the content into one text block,
  which drops thinking, signatures and tool calls. Assistant messages are only omitted, as part of a whole
  exchange.
- **Steering messages continue the run.** Until 0.2.0 a user message sent during a run started a new span,
  and tool results from before it were never candidates again. In real sessions that left 0.1–0.4M
  characters per steered run in context for good (they also blocked omitting the exchange, which contains
  images). Now the span goes back to the prompt and the steering messages join the question. The
  Anthropic question pin sits on the last user message with text (the steering message), so an edit before
  it has no readable pin: `anthropicRewriteChars` counts the whole context unless a trusted read point
  applies.
- **Recall outputs are not judged mid-run.** The model just asked for them. Judging them at the next
  checkpoint made models recall the same entry again (seen in real sessions). At run end they are judged
  like other outputs.
- **`keepCitedFiles` is off by default.** Answers also name files to rule them out. In a live run, Claude's
  answer said `test/fixtures/entities.json` was *not* a usage, and the option kept 40 lines of noise from
  that file. See [JEV.md](JEV.md).
- **Earlier runs are only edited as whole exchanges.** Editing single outputs of older runs would break the
  prompt cache from that point on for little gain; an old exchange is omitted as a whole, once, when it is
  unrelated to the current work, and only its first later request pays the rewrite.
- **Don't distill from a `context` hook.** Output that varies between requests makes every request miss the
  cache.

## Open questions

1. Other classifier entries (e.g. `typesafe/jev-latest` with a 64k context) and non-code outputs have
   not been tested.
2. The OpenAI Codex WebSocket transport loses its delta continuation after an edit
   ([CACHE.md](CACHE.md#openai)). It is not clear whether anything can be done about that from an extension.
