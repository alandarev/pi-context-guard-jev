# Design: pi-context-guard

**Prune the tool output of a finished run down to what the answer needs, using a
cheap decision model and Pi's append-only `context_edit` entries.**

Status: design checked against Pi 1.0.3 docs and `dist/` source. The draft in
`src/index.ts` loads, and the breakpoint pin was checked on a synthetic payload. The
pruner has never run in a real session.

## Goal

A question like *"what pieces of the system use UI element X"* makes the main model
search widely. Many `rg`/`read`/`bash` results go into the context, but the final answer
needs only a small part of them. After the run finishes:

1. A decision model reads the question, the final answer and every tool result from the run.
2. For each large tool result it keeps only the relevant lines (with `file:line`).
3. The extension appends a `context_edit` per result that replaces the result's model-visible content.

Later turns see the distilled evidence. The raw output stays in the session file, the
UI and exports, and can be recovered with a `recall` tool.

### Non-goals

- Replacing compaction. This complements it and delays when compaction is needed.
- Pruning during a run. The main model still needs the raw data, and every edit would
  invalidate the cache again (see `CACHE.md`).
- Editing user or assistant messages.

## Pi mechanisms used

### `context_edit` entries — `docs/session-format.md` → *ContextEditEntry*

```json
{"type":"context_edit","id":"…","parentId":"…","timestamp":"…","targetId":"<entry id>","replacement":null}
```

- Each entry is an append-only edit of one earlier user, assistant, tool-result or
  custom-message entry. It changes only what the model sees from then on. Raw history,
  UI, exports and session accounting are unchanged.
- `replacement: null` omits the target. A non-null value replaces only its content.
  String replacements for assistant and tool-result entries are normalized to one text block.
- If several edits target the same entry, the latest one on the active branch wins.
- Edits are branch-relative: `/tree` to a point before the edit shows the original again.
- `buildSessionProjection()` applies the edits. Compaction also works from the edited
  projection (`docs/compaction.md`).

### `agent_before_settle` boundary — `docs/extensions.md` → *Events and concurrency*

- This is the last point where an extension can act, after the final answer and before
  Pi settles. It can append entries and request one more model request; we never do.
- Types (`dist/core/extensions/types.d.ts`):
  - `BoundaryState { entries: SessionBoundaryDraft[]; continue; context: BoundaryContextPreview; outcome: "completed" | "aborted" | "error" }`
  - `BoundaryContextPreview.contextEntries: ProjectedSessionEntry[]` where `ProjectedSessionEntry = { sourceEntry: SessionEntry; messages: AgentMessage[] }`
  - `ContextEditEntryDraft { type: "context_edit"; targetId: string; replacement }`
- **The runner replaces `entries` with each handler's return value**
  (`dist/core/extensions/runner.js` → `emitBoundary`). Always return
  `[...event.entries, ...ours]`, otherwise edits from other extensions are lost.
- The handler is awaited, so the decision model's latency delays settling.

### Nested model call

- `ctx.modelRegistry.find(provider, id)` and
  `ctx.modelRegistry.complete(model, { messages }, { maxTokens, signal, cacheRetention: "none" })`.
  `examples/extensions/custom-compaction.ts` uses the same pattern.
- `ctx.signal` is `AbortSignal | undefined` and may be missing at boundaries.
- `ctx.modelRegistry.classify()` (classifier models) could make cheap keep/drop
  decisions. Not investigated; see *Open questions*.

### Provider payload hook — `before_provider_request`

- `event.payload` is the provider request body; a non-undefined return value replaces it
  (`runner.js` → `emitBeforeProviderRequest`).
- Used to pin a cache breakpoint at the user's question (see `CACHE.md`).

### Recall

- `ctx.sessionManager.getEntry(id)` returns the raw entry. `context_edit` never changes
  it, so a `recall(entryId)` tool can return the original tool output.

## Algorithm (draft)

1. **Trigger:** `agent_before_settle` with `outcome === "completed"` and the guard enabled.
2. **Run span:** walk `event.context.contextEntries` back to the last entry with a
   `user` message. Everything after it belongs to the run.
3. **Candidates:** tool-result entries in the span that
   - contain only text (no images),
   - are longer than `minResultChars`,
   - were not pruned already (their projected text doesn't start with our marker).

   Skip the whole run if the candidates total less than `minRunChars`.
4. **Decision request:** send the question, the final assistant answer, and each candidate
   wrapped as `<result id="ENTRY_ID" tool="NAME">…</result>`. Ask for JSON
   `{ "<id>": "<distilled text>" }` with only the lines (keeping `file:line`) that support the
   answer or are likely needed for follow-ups. Leave out ids that need no change.
5. **Validate** every returned item:
   - the id is in the candidate set,
   - the distilled text is non-empty,
   - it is at most `maxShrinkRatio` × the original length; otherwise skip it, since the saving isn't worth an edit.
6. **Emit** for each kept item: `{ type: "context_edit", targetId, replacement: MARKER + header + distilled }`.
   The header names the entry id and the `recall` tool.
7. **Return** `{ entries: [...event.entries, ...edits] }`. Never set `continue`.

## Pitfalls

- **Never `replacement: null` on a tool result.** The matching `tool_use` in the assistant
  message would be left without a result, and the provider rejects the request. Always
  replace with a stub or distilled text.
- **Don't edit assistant messages.** A replacement turns the content into one text block,
  which drops thinking, signatures and `tool_use` blocks.
- **Lossy by design.** Relevance is judged against *this* answer, so a follow-up question
  may need something that was dropped. The marker header plus `recall` is the way back.
- **Steering messages** sent during a run are user messages too, so they move the
  span boundary. That's probably acceptable, but test it.
- **Decision model context limit.** Very large runs may exceed it; split candidates into
  several requests.
- **Latency.** Settling waits for the decision model, so use a fast model and keep the thresholds.
- **Usage accounting.** `ContextEditEntryDraft` has no `usage` field, so the decision
  model's tokens don't appear in session totals unless recorded some other way (open question).
- **Cache.** Pruning causes a one-time partial cache miss on the next prompt. Without the
  question-breakpoint pin, a long run can make that a miss on the whole conversation
  history. See `CACHE.md`.

## Open questions

1. Decision model: `anthropic/claude-haiku-4-5`, `google/gemini-2.5-flash`, or a classifier via
   `modelRegistry.classify()` for keep/drop plus a cheap line extractor?
2. Judge relevance against the final answer only, or also guess likely follow-ups?
3. Do Pi's cache-warming replays (`dist/core/cache-warmer.js` → `streamSimple`) go through
   `before_provider_request`? If not, warm requests don't carry the question breakpoint.
4. Does Anthropic refresh a shorter nested prefix entry when a longer one is read? (Undocumented.)
5. Usage accounting for the decision call: custom entry, `appendUsage` (not on the
   read-only session manager), or accept the gap?
6. Configuration: Pi settings vs `pi.registerFlag()` vs `/guard` subcommands; per-tool allowlist
   (`read`, `bash`, `grep`, `find`, codemode, MCP).
7. Should the pin be applied only when the guard is about to prune, or always? Always is
   harmless and simpler.

## Verification plan

1. **Load:** `pi -e src/index.ts` starts without extension errors.
2. **Unit:** span and candidate selection against fixture `contextEntries` (synthetic
   user → assistant(tool_use) → toolResult… → assistant answer).
3. **Live prune:** ask a grep-heavy question. The session `.jsonl` should gain
   `context_edit` entries targeting the run's tool-result entry ids, and the next request
   should contain the distilled text.
4. **Recall:** the main model can fetch a pruned result's original via `recall`.
5. **Cache:** follow `CACHE.md` → *Verify*.
6. **Safety:** a run with images, an aborted run and an error run produce no edits; a
   second run does not prune results that are already pruned.
