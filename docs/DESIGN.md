# Design

This page describes what the code in `src/` does, checked against Pi 1.0.3. The Jev questions and the
evidence behind the thresholds are in [JEV.md](JEV.md). Cache behaviour is in [CACHE.md](CACHE.md).

## Module map

| Module | Role |
|---|---|
| `src/index.ts` | The only module that uses the Pi API: hooks, `recall` tool, `/guard` command, status bar, classifier lookup |
| `src/config.ts` | `DEFAULT_CONFIG`, validation (`normalizeConfig`), load/save of `context-guard.json`, `provider/id` parsing |
| `src/run.ts` | `collectRun`: finds the run that just finished, its question, answer, notes and candidate tool results |
| `src/chunk.ts` | `chunkOutput` (grep-aware chunking) and `segmentChunks` (grouping chunks into Jev requests) |
| `src/decide.ts` | `buildRequest` (the Jev request) and `interpret` (answers → keep set); `citedFiles` |
| `src/distill.ts` | `distillRun`: chunk, run Jev requests in parallel within a time budget, decide per result, build `context_edit` drafts |
| `src/render.ts` | The replacement text: header, verbatim chunks, omission lines; the `[context-guard]` marker |
| `src/cache-pin.ts` | Anthropic breakpoint at the previous user question |
| `src/stats.ts` | Savings and Jev usage computed from the session; status-bar text |
| `src/recall.ts` | The text returned by `recall` |
| `src/types.ts` | Loose structural types for the Pi objects used, so the pure modules can be tested without Pi |

Everything except `index.ts` is pure. `distillRun` gets the classifier as an injected function.

## The boundary: `agent_before_settle`

The work happens in `agent_before_settle`, and only when `event.outcome === "completed"` and the guard is on.

Why there:

- The final answer exists, so relevance can be judged against it. Pruning during a run would take raw
  data away from the model while it still needs it, and every edit would break the prompt cache again.
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
| `agent_before_settle` | Distill the finished run |
| `before_provider_request` | Pin the Anthropic cache breakpoint (only for `anthropic-messages` models) |
| `session_tree`, `session_compact`, `agent_settled` | Redraw the status |

## Algorithm

### 1. Run span

`collectRun` walks back through `event.context.contextEntries` (Pi's projected entries) to the last entry
that has a user message, with or without text. Its text is the **question**; a prompt with only an image
gets the placeholder `[the user sent only an image]`, so an older question is never reused. Everything
after it is the run. Assistant
text in the run gives the **answer** (the last text) and the **notes** (all earlier text). Tool calls are
indexed by id so each result can be matched with its tool name and arguments.

### 2. Candidates

A tool result in the span is a candidate if all of these hold:

- its entry projects to exactly one `toolResult` message,
- it is not an error and has only text blocks (no images),
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

**Segments.** Consecutive chunks are grouped into segments of at most `maxSegmentChars` (40,000)
characters and `maxChunksPerSegment` (40) chunks. A chunk larger than the limit (one huge line) gets a
segment of its own, which is **never sent**: it is kept as it is, with reason `oversize`.
Jev's context window is 32k tokens. Code is about 2.3 characters per token, and a measured 30k-character grep
with 30 questions came to 13,155 input tokens, so 40,000 characters leaves room for the state and the
questions.

### 4. One Jev request per segment (`decide.ts → buildRequest`)

The request **state** contains:

| Field | Content |
|---|---|
| `situation` | A fixed explanation: a coding agent answered the question; this is one tool output split into chunks; only kept chunks remain visible |
| `user_question` | The question, at most 4,000 characters (head and tail kept) |
| `final_answer` | The answer, at most 6,000 characters |
| `agent_notes_during_the_run` | Earlier assistant text, at most 2,000 characters (only if there is any) |
| `tool`, `tool_arguments` | Tool name; arguments as JSON, at most 600 characters |
| `output_size` | Line count, plus "part i of n" when the output has several segments |
| `chunks` | `{ "chunk_1": "…", "chunk_2": "…" }` with chunk numbers counted across the whole output |

The **questions**, all in the same request:

| Id | Type | Asks |
|---|---|---|
| `keep_whole` | bool | Is all of the output still needed, so that removing any chunk would lose evidence or follow-up information? |
| `focus` | choice: `whole`, `none`, `chunk_N`… | Does the answer draw on most of the output (`whole`), on nothing (`none`), or on a few chunks, of which `chunk_N` is the most important? |
| `chunk_N` | bool, one per chunk | Does this chunk contain lines the answer relies on, or that a likely follow-up would need? |

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

Each run that made at least one Jev request also appends a custom entry (`customType: "context-guard"`):

| Field | Meaning |
|---|---|
| `v` | Format version, `1` |
| `model` | Classifier used |
| `savedChars` | Characters removed by this run's edits |
| `requests`, `inputTokens`, `costUsd`, `ms` | Jev usage for the run |
| `timedOut` | The time budget ran out |
| `results[]` | One per candidate: `entryId`, `tool`, `label`, `outcome` (`distilled`, `removed`, `kept`), `reason`, `beforeChars`, `afterChars`, `jev` |

`reason` is one of `chunks`, `none-needed`, `not-worth`, `all-chunks`, `whole-needed`, `whole-chosen`,
`no-answer`, `error` or `timeout` (several are joined with commas). `jev` holds one trace per segment, such as
`kw.15 focus=chunk_4:.52 keep 9/29` or `kw.82 focus=whole:.71 keep all (whole-needed)`. That is
P(`keep_whole`), the focus choice and its probability, and the result. `/guard` prints these for the last run.

The extension does not write Jev's usage into Pi's own usage entries. It is recorded only here.

## Statistics (`stats.ts`)

Nothing is kept in memory. Every redraw recomputes from the session:

- **Savings:** Pi's session projection (`buildSessionProjection()`) is checked for tool results whose
  model-visible text starts with `[context-guard]` while the raw entry does not. Each one adds raw length
  minus visible length. Tokens are estimated as characters ÷ 4.
- **Jev usage:** the `context-guard` records on the active branch (`getBranch()`) are summed.

So the numbers follow branches, `/tree`, reloads and compaction.

## Recall

`recall` reads the raw entry with `ctx.sessionManager.getEntry(entryId)`. `context_edit` never changes that
entry. The tool returns the whole text, or only lines that match `pattern` (with line numbers), or an
`offset`/`limit` window. Output is capped at 2,000 lines and 50 KB, with a continuation note; a single
line longer than 50 KB is cut with a `[line N cut at 50KB]` note. `pattern` is a JavaScript regex of at most
500 characters, matched against the first 4,000 characters of each line inside a `node:vm` sandbox with a
1-second timeout, so a catastrophic pattern returns an error instead of freezing Pi. An id that is
not a tool result gives an error that tells the model to use the id from a `[context-guard]` header.

## Pitfalls

- **Never use `replacement: null` on a tool result.** The matching `tool_use` would lose its result, and
  providers reject the request. A fully removed result is always replaced with a one-line stub.
- **Never edit assistant messages.** A replacement turns the content into one text block, which drops
  thinking, signatures and tool calls.
- **Steering messages move the span.** A user message sent during a run starts a new span. Tool results
  from before it are never candidates, now or later. That is the safe direction.
- **`keepCitedFiles` is off by default.** Answers also name files to rule them out. In a live run, Claude's
  answer said `test/fixtures/entities.json` was *not* a usage, and the option kept 40 lines of noise from
  that file. See [JEV.md](JEV.md).
- **Only the run that just finished is edited.** Editing older runs would break the prompt cache from that
  point on, for every later turn.
- **Don't distill from a `context` hook.** Output that varies between requests makes every request miss the
  cache.

## Open questions

1. Do Pi's cache-warming replays (`cache-warmer.js`, `streamSimple`) go through `before_provider_request`?
   If not, warm requests do not carry the question breakpoint. Not checked.
2. Should the pin go on the last unedited tool result instead of the question? That would keep more of the
   run cached on the next prompt. Not tried.
3. Other classifier entries (e.g. `typesafe/jev-latest` with a 64k context) and non-code outputs have
   not been tested.
4. The OpenAI Codex WebSocket transport loses its delta continuation after an edit
   ([CACHE.md](CACHE.md#openai)). It is not clear whether anything can be done about that from an extension.
