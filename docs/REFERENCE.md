# Reference

Everything you can see, call and configure. How it works inside: [DESIGN.md](DESIGN.md).

## Requirements

- Pi ≥ 1.0.3
- An OpenRouter credential (`OPENROUTER_API_KEY` or `/login`) for the default classifier,
  `openrouter/~typesafe/jev-latest`. Any classifier model in Pi's catalog can be set with the `model`
  setting, but only the default has been tested.

If the model or credential is missing, the extension does nothing and the status bar says so.

## Status bar

| Text | Meaning |
|---|---|
| `🛡 0 saved` | On and ready; nothing is distilled on this branch yet |
| `🛡 0 · Σ−79k` | A compaction dropped the earlier edits from context: nothing is kept out right now, about 79k tokens were saved on this branch in total |
| `🛡 distilling…` | Jev is judging the outputs of the run that just finished, or of a mid-run checkpoint |
| `🛡 −4.2k · 1` | ≈ tokens kept out of context · items: about 4.2k tokens are currently kept out of context, by 1 distilled or omitted tool output, output without its images, or old exchange |
| `🛡 −4.2k · 1 · Σ−83k` | The same, after a compaction: Σ is the total saved on this branch, including edits the compaction dropped |
| `🛡 guard off` | Turned off with `/guard off` or `"enabled": false` |
| `🛡 no openrouter key` | No credential for the classifier's provider (the provider name is filled in) |
| `🛡 Jev model not found` | The configured `model` is not in Pi's classifier catalog |

The token figure is Pi's usual estimate, characters ÷ 4. It counts what is kept out of the model's context
**on the current branch right now**: original size minus replacement size, for every distilled output,
removed image and omitted exchange that is still in the context (an image counts as about width × height ÷ 750
tokens). It goes down after `/tree` to a point before an edit, and after compaction removes distilled
results; then Σ shows the total of every pass on the branch so far. It is not a measured token count.

## `/guard` command

| Command | Effect |
|---|---|
| `/guard` or `/guard status` | Shows whether the guard is on, the model, the savings on this branch (distilled outputs and omitted exchanges), Jev runs and mid-run checkpoints, requests and cost, whether checkpoints and exchange pruning are on, and the last run's or checkpoint's result for each item (large, small, exchange), including Jev traces such as `kw.15 focus=chunk_4:.52 keep 9/29` or `p.06` |
| `/guard on` / `/guard off` | Turns the guard on or off and saves `enabled` to the settings file |
| `/guard reload` | Re-reads the settings file and shows any warnings again |

Settings are read at session start and on `/guard reload`.

## `recall` tool

Every distilled output and omitted exchange starts with `[context-guard]` and ends with
`recall({"entryId":"…"})`. For an omitted exchange, recall returns the whole exchange as a transcript
(prompt, replies, tool calls and results, custom messages). The model can call:

| Parameter | Meaning |
|---|---|
| `entryId` (required) | The entry id from the header |
| `pattern` | JavaScript regex (≤ 500 chars, 1 s limit); returns only matching lines, prefixed with their line numbers |
| `offset` | First line to return, 1-based. When `pattern` is set, this counts matching lines. |
| `limit` | Most lines to return |

Like Pi's `read` tool, the output is capped at 2,000 lines and 50 KB, and a note says how to continue.

## Configuration

The settings file is `~/.pi/agent/context-guard.json` (inside Pi's agent directory), or the path in
`PI_CONTEXT_GUARD_CONFIG`. Every key is optional. Values that are missing, the wrong type or out of range
fall back to the default.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch (`/guard on` and `/guard off` write it) |
| `model` | `"openrouter/~typesafe/jev-latest"` | Classifier as `provider/id`; the first `/` separates the provider |
| `minResultChars` | `4000` | Tool results from this size are chunked; shorter ones are judged whole (see `smallResultMinChars`) |
| `minRunChars` | `8000` | Distill a run's large outputs only if they add up to at least this (small outputs and exchanges are judged regardless) |
| `keepWholeThreshold` | `0.7` | Keep a segment untouched if P(`keep_whole`) is at least this |
| `focusWholeThreshold` | `0.6` | Keep a segment untouched if `focus` picks "whole" with at least this probability |
| `chunkKeepThreshold` | `0.6` | Keep a chunk if P(chunk needed) is at least this |
| `noneThreshold` | `0.5` | Remove a segment entirely if `focus` picks "none" with at least this probability and no chunk passes |
| `maxKeepRatio` | `0.6` | Skip the edit if the kept chunks are more than this fraction of the original |
| `keepCitedFiles` | `false` | Also keep grep chunks for files that the final answer names (see DESIGN.md for why it is off) |
| `timeoutMs` | `8000` | Total time budget for all Jev requests of one run; unfinished parts are kept |
| `concurrency` | `6` | Jev requests in parallel |
| `maxSegmentChars` | `32000` | Most characters of one output per Jev request (keeps the worst-case request under Jev's 32k-token context, see [JEV.md](JEV.md)) |
| `maxChunksPerSegment` | `40` | Most chunks per Jev request |
| `excludeTools` | `["edit", "write"]` | Tools whose results are never distilled |
| `distillErrors` | `true` | Also distill error results, such as the log of a failing test or build; Jev is told the call failed, and that its details are usually no longer needed once the agent got past it |
| `historyExchanges` | `3` | Earlier exchanges (prompt + last assistant text) sent to Jev so it judges relevance against the ongoing work; `0` sends no earlier conversation at all (integer 0–10) |
| `pinAnthropicCache` | `true` | Anthropic cache breakpoints: at the previous user question on every request, and on the first request after context edits a read point (at a cache entry this process wrote) and a write anchor ([CACHE.md](CACHE.md)) |
| `midRun` | `true` | Mid-run checkpoints during long runs ([RESULTS.md](RESULTS.md#long-autonomous-runs)) |
| `midRunMinAgeTurns` | `4` | Judge an output mid-run only once it is at least this many turns old (integer 1–100) |
| `midRunBatchChars` | `60000` | Run a checkpoint only when the not-yet-judged eligible outputs add up to this many characters |
| `midRunBatchCharsOpenAI` | `60000` | The same, for `openai-codex` models |
| `midRunChunkKeepThreshold` | `0.6` | Keep a chunk at a checkpoint if P(still needed) is at least this (probe in [JEV.md](JEV.md)) |
| `midRunBreakEven` | `true` | Skip a checkpoint unless its one-time prompt-cache rewrite is likely to pay off; `false` checkpoints purely for context room |
| `smallResultMinChars` | `400` | Tool results from this size up to `minResultChars` are judged as whole items; `0` turns this off |
| `smallKeepThreshold` | `0.45` | Keep a small output if P(still needed) is at least this (probe in [JEV.md](JEV.md)) |
| `pruneExchanges` | `true` | Judge old exchanges and omit the unrelated ones |
| `keepRecentExchanges` | `2` | The last this many exchanges before the current prompt are never omitted |
| `exchangeOmitThreshold` | `0.2` | Omit an exchange only if P(still relevant) is below this (probe in [JEV.md](JEV.md)) |
| `exchangeBreakEven` | `true` | At run end, omit unrelated exchanges only when the cache rewrite they cause pays off; deferred ones are judged again at later run ends and omitted once their total pays off. `false` always omits them |
| `exchangeMinSavingChars` | `8000` | A run end omits exchanges only if they save at least this many characters together (when they cost a cache rewrite) |
| `imageKeepTurns` | `3` | Remove images from tool results once this many assistant messages have followed them (`recall` shows them again); images in user messages are kept; `0` turns this off |

Example:

```json
{ "minResultChars": 6000, "excludeTools": ["edit", "write", "bash"] }
```

## Data sent to Jev

**This extension sends data to a third party, and it is on by default.** After every run that qualifies,
each Jev request sends the following to OpenRouter, which forwards it to TypeSafe:

- the user's question (up to 4,000 characters),
- the final answer (up to 6,000 characters),
- the assistant's notes written during the run (up to 2,000 characters),
- excerpts of the earlier conversation in this session: the latest compaction or branch summary (up to
  2,000 characters), the first prompt (up to 1,000), and the last 3 earlier exchanges, each one prompt
  (up to 800) and the last assistant text after it (up to 1,200). Tool calls and tool outputs of earlier runs
  are not included in this part. Set `historyExchanges` to `0` to send none of it,
- the tool name and arguments,
- the full text of the large tool output being judged, and of small outputs (from 400 characters; up to
  4,000 characters each). This can include source code, logs or anything else the tools returned,
- excerpts of old exchanges being judged: each prompt (up to 600 characters), the last assistant text (up to
  800), the tool calls as short labels (tool name and the command or path, up to 80 characters each) and the
  size. Set `pruneExchanges` to `false` to send none of it.

Never sent: tool outputs below `smallResultMinChars` (400 characters), results of excluded tools (`edit`,
`write`), images (never sent: they are removed by age), the text of outputs with images, old exchanges with entries another extension changed,
exchanges below 2,000 characters, and the last `keepRecentExchanges` (2) exchanges before the current
prompt. Large outputs are sent only when the run's large outputs add up to `minRunChars` (8,000); small
outputs and old exchanges are sent at every run end and every mid-run checkpoint that has any.

`/guard off` turns the extension off and saves that choice in the settings file, so it stays off in later
sessions. See OpenRouter's data policy:
<https://openrouter.ai/docs/guides/privacy/data-collection>.

## What it never touches

- messages of the current run other than tool results, and the last `keepRecentExchanges` exchanges before
  the current prompt
- compaction and branch summaries, exchanges that did not finish (the last reply has tool calls), and
  messages Pi cannot edit (system messages, `!` shell executions), which stay in place inside an omitted
  exchange
- images in your own messages; images in tool results younger than `imageKeepTurns` (3) turns
- the text of tool results that contain images (only the images are removed, by age)
- error results, if `distillErrors` is `false`
- results of excluded tools (`edit`, `write` by default)
- results shorter than `smallResultMinChars` (400), and large results of runs below `minRunChars`
- aborted or failed runs
- results that are already distilled, or that another extension already edited
- single lines too long for one Jev request (kept as they are)
- tool outputs of earlier runs one by one: earlier runs are only touched as whole exchanges (and their old
  images)

## Limitations

- **Lossy by design.** Relevance is judged against the run's question and answer and the earlier
  conversation (the ongoing task), so a follow-up that goes somewhere new may need something that was
  removed. The header and omission lines say what is missing, and `recall` returns it. An earlier task
  that comes back after several unrelated ones may have been omitted as a whole exchange.
- **Latency.** Settling waits for Jev. This adds about 0.5–1.2 s after each qualifying run (measured), and
  never more than `timeoutMs` (8 s). A mid-run checkpoint pauses the run the same way.
- **Cost.** Each qualifying run costs a few Jev requests, measured at under $0.001 per run. The first prompt
  after an edit also has a one-time partial prompt-cache miss ([CACHE.md](CACHE.md)).
- **Steering.** A message sent during a run joins the run's question. Outputs from before it can be distilled,
  but the first edit before it rewrites the whole prompt cache once (the question pin moves to the steering
  message).
