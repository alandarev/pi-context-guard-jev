# pi-context-guard-jev

**Your agent ran a 50 KB search to answer one question. Every later request still carries all 50 KB.
This Pi extension keeps the lines that mattered.**

![A broad 496-line search is distilled after the run; the footer shows about 10.1k tokens kept out of context](https://raw.githubusercontent.com/alandarev/pi-context-guard-jev/master/assets/screenshot.png)

When a run finishes, the extension asks the Jev classifier (by TypeSafe) which parts of each large tool
output the work still needs: a broad `rg`, a full-file `read`, a failing test log. It then uses Pi's
append-only `context_edit` entries to replace each output with only those parts, copied verbatim. Later
turns carry the answer and its evidence instead of everything that was searched. The raw output stays in
the session file, and the model can fetch it again with the `recall` tool.

```bash
pi install npm:pi-context-guard-jev     # needs an OpenRouter key: OPENROUTER_API_KEY or /login
```

## Why use it

- **Most of a session's context is tool output that stopped mattering.** Pi keeps every output for the
  rest of the session, so every later request re-sends it, the context window fills, and compaction (a
  lossy summary of everything) comes sooner. In the [measured examples](#examples-measured), the next
  request carried **9.2k instead of 35.3k tokens** after reading a 164 KB file, **11.5k instead of 34.3k**
  after a code search, and **5.7k instead of 7.5k** after a failing test run. Every follow-up was still
  answered correctly.
- **Verbatim, never rewritten.** Jev is a classifier: it answers yes/no and multiple-choice questions and
  does not write text. Kept lines are copied byte for byte, and each removed stretch becomes one line that
  says what was there (`[… 79 lines omitted: matches in dist/core/tools/grep.js, …]`). Unlike a summary,
  nothing the model sees afterwards is paraphrased or invented.
- **Nothing is lost.** The original stays in the session file. The model can `recall` it (whole, by
  regex, or by line range), and `/tree` back to before the edit restores it.
- **Judged against the work, not by size.** Truncation and size limits can't tell a needed line from
  noise. Jev sees the question, the final answer and the earlier conversation, and decides chunk by chunk,
  so lines the ongoing task needs survive even when this run's question was about something else. A
  failed command the agent already got past is removed outright.
- **Cheap and quick.** $0.0004–0.003 and 0.6–1 s per qualifying run (measured). It distills when a run
  finishes, and during long runs at checkpoints, only once old outputs have piled up and removing them is
  worth breaking the prompt cache ([Long autonomous runs](#long-autonomous-runs)).
- **Claude and OpenAI, cache-aware.** Tested with Claude Sonnet 5.5 and GPT-6 Luna. On Anthropic it adds a
  cache breakpoint at the previous question, so the request after an edit still reads the conversation
  up to there from cache.
- **You can see what it does.** The footer shows `🛡 −10.1k · 1`. `/guard` lists every decision with Jev's
  probabilities, and `/guard off` turns it off for good.

**Trade-offs:**
- **It sends data to a third party.** Tool output goes to OpenRouter and TypeSafe ([Privacy](#privacy)).
- **It can cost a little more in short sessions.** The first request after an edit rewrites the prompt
  cache, so the first gain is context room; the bill shrinks only in longer sessions
  ([Examples](#examples-measured)).
- **Follow-ups may need `recall`.** A question that goes somewhere new can need something that was
  removed.

## How it works

1. **A run finishes.** When Pi is about to settle a completed run (`agent_before_settle`), the extension
   looks at that run only: everything after the last user message.
2. **It picks candidates.** These are text-only tool results of at least 4,000 characters, including the
   output of failed commands. The run is
   skipped if the candidates add up to less than 8,000 characters.
3. **It chunks each output.** grep-style output is grouped by file. Other output is cut into windows of
   roughly 0.8–4k characters, with breaks at blank lines where possible.
4. **It sends one Jev request per segment** (up to 32,000 characters and 40 chunks). Each request asks three
   kinds of question about the user's question and the final answer, and, when there is one, the earlier
   conversation of the session (so output that the ongoing work still needs is kept even if this run's
   question was about something else):
   - `keep_whole`: is all of this output still needed?
   - `focus`: does the answer use most of it, none of it, or a few chunks (and if so, which one matters most)?
   - one yes/no question per chunk: is this chunk needed?
5. **It writes a `context_edit` per result.** The edit keeps the needed chunks verbatim, replaces each run of
   removed chunks with an omission line, and starts with a header that tells the model how to
   `recall` the full output. If the kept part would still be more than 60% of the original, the result is
   left as it is.

During long runs, **mid-run checkpoints** do the same for older outputs before the run ends (next
section).

Errors, timeouts and unclear answers always mean *keep*. For the full algorithm, see
[docs/DESIGN.md](docs/DESIGN.md).

## Long autonomous runs

Run-end distillation helps the *next* prompt. A 30–120 minute autonomous run (the main agent or a long
worker) would still carry every tool output until it ends, and Pi compacts only near the window
minus 16k tokens. So, while a run is going, the extension also checkpoints:

1. **At a turn boundary** (`turn_end`; Pi applies the edit to the very next request, before its compaction
   check), outputs of the current run that are at least `midRunMinAgeTurns` (4) turns old and not judged
   before are eligible. The final turn of a run is left to run-end distillation.
2. **In batches:** a checkpoint runs only when the eligible outputs add up to `midRunBatchChars` (60,000)
   characters, so edits, and the cache rewrites they cause, are rare.
3. **Only when it pays:** an edit makes the next request rewrite the prompt cache once (OpenAI Codex: the
   whole context; Anthropic: everything after the latest cache entry it can still read, at worst after the
   question). The break-even rule
   (`midRunBreakEven`) skips a checkpoint unless the expected saving over the rest of the run covers that.
4. **Jev gets a checkpoint question:** no final answer exists yet, so it sees the task, the agent's latest
   notes, the tool calls made since this output, and whether the output was superseded (the file was
   edited afterwards, or the same command ran again). It answers whether the agent will still need each
   chunk to finish. Each output is judged mid-run at most once; run-end distillation judges the rest,
   including outputs kept at a checkpoint, with the final answer.
5. **On Anthropic** the previous question stays pinned, and the first request after a checkpoint also gets
   a breakpoint at the latest cache entry this process wrote before the first edited output, so the
   unchanged part of the run is still read from cache.

**Measured** (Pi 1.0.3, e2e scenario `long`: "fix all failing tests" in a generated project with 10 bugs,
the full suite after every fix; single runs, not a benchmark; costs are what Pi reports at list price):

| Main model | Configuration | Requests | Peak context | Main-model cost | Checkpoints (Jev) | Suite green |
|---|---|---|---|---|---|---|
| GPT-6 Luna | guard off | 32 / 37 | 68.4k / 87.7k | $0.020 / $0.030 | – | yes / yes |
| GPT-6 Luna | `midRun: false` (run end only) | 26 | 86.3k | $0.022 | – (run end $0.006) | yes |
| GPT-6 Luna | default | 31 | 72.4k | $0.024 | 1 at request 19, 1.0 s, removed 154k chars ($0.007 with run end) | yes |
| Claude Sonnet 5.5 | guard off | 14 | 89.8k | $0.41 | – | yes |
| Claude Sonnet 5.5 | default | 8 | 65.7k | $0.24 | none: too short to pay off (run end $0.003) | yes |
| Claude Sonnet 5.5 | forced: `midRunBreakEven: false`, `midRunMinAgeTurns: 2`, `midRunBatchChars: 20000` | 12 | 43.3k | $0.34 | 3 ($0.0032 with run end) | yes |

Context per request (every 5th request), GPT-6 Luna:

| Request | 1 | 6 | 11 | 16 | 21 | 26 | 31 | 36 |
|---|---|---|---|---|---|---|---|---|
| guard off (37 requests) | 3.0k | 14.6k | 29.3k | 41.4k | 52.1k | 62.5k | 73.3k | 83.4k |
| default (31 requests) | 3.2k | 27.9k | 35.2k | 62.7k | 28.6k | 34.2k | 43.7k | – |

At the checkpoint, Jev removed 154k characters (five superseded test logs and an old search, for example
30,150 → 1,834); the next request carried 28.5k instead of 72.4k tokens. No run needed `recall`.

**Trade-offs:**
- **OpenAI Codex reads nothing from cache after any edit** (2,560 or 0 tokens on the next request, after
  every checkpoint measured, wherever the edit was). Each checkpoint re-sends the context uncached once and
  pays back after about 8–10 later requests. In these 26–37-request runs the main-model cost came out
  about the same with and without checkpoints, plus about $0.005 of Jev per run; the gain is a smaller
  context.
- **On Anthropic a checkpoint rewrites the cache after the latest entry the next request can read** (at worst after the question; writing costs 12.5× the read price).
  In the forced run, the requests after the three checkpoints read 5.8k / 16.7k / 16.7k tokens and wrote
  10.9k / 22.8k / 20.0k. After the first checkpoint of a run only the system prompt and question can be
  read, because the run's first output is usually the first one edited. Claude solved the task in 8–14
  requests, too few for a checkpoint to pay off, so with the default break-even rule it never
  checkpointed; forced checkpoints in such short runs cost more than they saved. Checkpoints are meant
  for runs that go on for dozens of requests.
- **Latency mid-run:** a checkpoint pauses the run for the Jev requests (0.5–2.2 s measured, at most
  `timeoutMs`).
- Details: [docs/CACHE.md](docs/CACHE.md#mid-run-checkpoints), [docs/DESIGN.md](docs/DESIGN.md#mid-run-checkpoints),
  wording probe in [docs/JEV.md](docs/JEV.md#checkpoint-wording).

## Install

```bash
pi install npm:pi-context-guard-jev
# or from GitHub
pi install git:github.com/alandarev/pi-context-guard-jev
# or, for development, load it for one session from a checkout
pi -e ./src/index.ts
```

### Requirements

- Pi ≥ 1.0.3
- An OpenRouter credential (`OPENROUTER_API_KEY` or `/login`) for the default classifier,
  `openrouter/~typesafe/jev-latest`. Any classifier model in Pi's catalog can be set with the `model`
  setting, but only the default has been tested.

If the model or credential is missing, the extension does nothing and the status bar says so.

## Privacy

**This extension sends data to a third party, and it is on by default.** After every run that qualifies,
each Jev request sends the following to OpenRouter, which forwards it to TypeSafe:

- the user's question (up to 4,000 characters),
- the final answer (up to 6,000 characters),
- the assistant's notes written during the run (up to 2,000 characters),
- excerpts of the earlier conversation in this session: the latest compaction or branch summary (up to
  2,000 characters), the first prompt (up to 1,000), and the last 3 earlier exchanges, each one prompt (up to
  800) and the last assistant text after it (up to 1,200). Tool calls and tool outputs of earlier runs are not
  included. Set `historyExchanges` to `0` to send none of it,
- the tool name and arguments,
- the full text of the large tool output being judged. This can include source code, logs or anything else
  the tools returned.

Small results, edit/write results and runs below the size limits are never sent.

`/guard off` turns the extension off and saves that choice in the settings file, so it stays off in later
sessions. See OpenRouter's data policy:
<https://openrouter.ai/docs/guides/privacy/data-collection>.

## Status bar

| Text | Meaning |
|---|---|
| `🛡 0 saved` | On and ready; nothing is distilled on this branch yet |
| `🛡 distilling…` | Jev is judging the outputs of the run that just finished, or of a mid-run checkpoint |
| `🛡 −4.2k · 1` | ≈ tokens kept out of context · distilled results: about 4.2k tokens are currently kept out of context, by 1 distilled tool result |
| `🛡 guard off` | Turned off with `/guard off` or `"enabled": false` |
| `🛡 no openrouter key` | No credential for the classifier's provider (the provider name is filled in) |
| `🛡 Jev model not found` | The configured `model` is not in Pi's classifier catalog |

The token figure is Pi's usual estimate, characters ÷ 4. It counts what is kept out of the model's context
**on the current branch right now**: original length minus replacement length, for every distilled result
that is still in the context. It goes down after `/tree` to a point before an edit, and after compaction
removes distilled results. It is not a measured token count and not a cumulative total.

## `/guard` command

| Command | Effect |
|---|---|
| `/guard` or `/guard status` | Shows whether the guard is on, the model, the savings on this branch, Jev runs and mid-run checkpoints, requests and cost, whether checkpoints are on, and the last run's or checkpoint's result for each tool output, including Jev traces such as `kw.15 focus=chunk_4:.52 keep 9/29` |
| `/guard on` / `/guard off` | Turns the guard on or off and saves `enabled` to the settings file |
| `/guard reload` | Re-reads the settings file and shows any warnings again |

Settings are read at session start and on `/guard reload`.

## `recall` tool

Every distilled result starts with `[context-guard]` and ends its header with
`Full output: recall({"entryId":"…"}).` The model can call:

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
| `minResultChars` | `4000` | Ignore tool results shorter than this many characters |
| `minRunChars` | `8000` | Skip the run if its candidates add up to less than this |
| `keepWholeThreshold` | `0.7` | Keep a segment untouched if P(`keep_whole`) is at least this |
| `focusWholeThreshold` | `0.6` | Keep a segment untouched if `focus` picks "whole" with at least this probability |
| `chunkKeepThreshold` | `0.6` | Keep a chunk if P(chunk needed) is at least this |
| `noneThreshold` | `0.5` | Remove a segment entirely if `focus` picks "none" with at least this probability and no chunk passes |
| `maxKeepRatio` | `0.6` | Skip the edit if the kept chunks are more than this fraction of the original |
| `keepCitedFiles` | `false` | Also keep grep chunks for files that the final answer names (see DESIGN.md for why it is off) |
| `timeoutMs` | `8000` | Total time budget for all Jev requests of one run; unfinished parts are kept |
| `concurrency` | `6` | Jev requests in parallel |
| `maxSegmentChars` | `32000` | Most characters of one output per Jev request (keeps the worst-case request under Jev's 32k-token context, see docs/JEV.md) |
| `maxChunksPerSegment` | `40` | Most chunks per Jev request |
| `excludeTools` | `["edit", "write"]` | Tools whose results are never distilled |
| `distillErrors` | `true` | Also distill error results, such as the log of a failing test or build; Jev is told the call failed, and that its details are usually no longer needed once the agent got past it |
| `historyExchanges` | `3` | Earlier exchanges (prompt + last assistant text) sent to Jev so it judges relevance against the ongoing work; `0` sends no earlier conversation at all (integer 0–10) |
| `pinAnthropicCache` | `true` | Anthropic cache breakpoints: at the previous user question on every request, and on the first request after context edits a read point (at a cache entry this process wrote) and a write anchor ([docs/CACHE.md](docs/CACHE.md)) |
| `midRun` | `true` | Mid-run checkpoints during long runs ([Long autonomous runs](#long-autonomous-runs)) |
| `midRunMinAgeTurns` | `4` | Judge an output mid-run only once it is at least this many turns old (integer 1–100) |
| `midRunBatchChars` | `60000` | Run a checkpoint only when the not-yet-judged eligible outputs add up to this many characters |
| `midRunBatchCharsOpenAI` | `60000` | The same, for `openai-codex` models |
| `midRunChunkKeepThreshold` | `0.6` | Keep a chunk at a checkpoint if P(still needed) is at least this (probe in docs/JEV.md) |
| `midRunBreakEven` | `true` | Skip a checkpoint unless its one-time prompt-cache rewrite is likely to pay off; `false` checkpoints purely for context room |

Example:

```json
{ "minResultChars": 6000, "excludeTools": ["edit", "write", "bash"] }
```

## What it does not touch

- user and assistant messages, custom messages
- tool results that contain images
- error results, if `distillErrors` is `false`
- results of excluded tools (`edit`, `write` by default)
- results shorter than `minResultChars`, and runs below `minRunChars`
- aborted or failed runs
- results that are already distilled, or that another extension already edited
- single lines too long for one Jev request (kept as they are)
- earlier runs: only the current run is edited (mid-run checkpoints edit its older outputs, once each)

## Limitations

- **Lossy by design.** Relevance is judged against the run's question and answer and the earlier
  conversation (the ongoing task), so a follow-up that goes somewhere new may need something that was
  removed. The header and omission lines say what is missing, and `recall` returns it.
- **Latency.** Settling waits for Jev. This adds about 0.5–1.2 s after each qualifying run (measured), and
  never more than `timeoutMs` (8 s). A mid-run checkpoint pauses the run the same way.
- **Cost.** Each qualifying run costs a few Jev requests, measured at under $0.001 per run. The first prompt
  after an edit also has a one-time partial prompt-cache miss ([docs/CACHE.md](docs/CACHE.md)).
- **Steering.** A message sent during a run starts a new span. Tool results from before it are never
  distilled.

## Examples (measured)

Real runs on public code with Pi 1.0.3: each example ran once with the guard on and once with it off
(`--no-guard`), from the same prompts. These are single runs, not a benchmark: the main model takes a
different path each time. Reproduce with `node test/e2e/examples.mjs` ([docs/TESTING.md](docs/TESTING.md)).

**A. Searching a real codebase.** In a copy of the published Pi package (`dist/` without source maps and
the minified bundle, plus `docs/`), the agent was asked where Pi decides to auto-compact, starting with
`rg -n -i compact dist docs`. Pi's bash tool returned the last 50 KB of that search. Jev kept the matches
in the compaction module, the settings and the decision points in `agent-session.js`, and dropped matches
in the grep tool, HTML export templates, the SDK and so on. Then the agent was asked "which of those
settings can a user change, and what are their defaults?".
- Claude Sonnet 5.5: 50,413 → 16,210 chars (141 of 431 lines kept). The first turn-2 request carried
  **15.5k tokens instead of 28.2k**. The answer was correct (`enabled` true, `reserveTokens` 16384,
  `keepRecentTokens` 20000), without `recall`.
- GPT-6 Luna: 51,216 → 13,023 chars (107 of 385 lines), and a 5.4k read of `compaction.js` → 1.8k; two
  smaller outputs were left whole. Turn 2 carried **11.5k tokens instead of 34.3k** and was correct, without
  `recall`.

**C. Reading a 164 KB source file.** The agent read `dist/core/agent-session.js` (3,535 lines) in
seven 500-line pieces and explained how a prompt reaches the model. Jev kept 45–164 lines of each of the first
four pieces and removed the last three completely (each became a one-line stub). The follow-up asked for a
detail the explanation never mentioned: the exact error thrown when a prompt arrives during compaction.
That line was among the kept ones, so the agent quoted it exactly without `recall`. The turn-2 request
carried **9.2k tokens instead of 35.3k**.

**B. A failing test run.** In a copy of this repository with one injected off-by-one bug, the agent ran
the unit tests (a 15.8k-character log, 3 failures among 116 tests) and reported the cause. Jev kept the
3 failures with their assertion messages and the failing-test summary, and dropped the passing tests:
15.8k → 8.6k chars. Turn 2 ("now fix it") carried **5.7k tokens instead of 7.5k**, and both runs fixed
the bug. Failing commands are distilled because `distillErrors` is on by default.

What the model sees after distilling (example A, Claude; the first lines of the real replacement):

```text
[context-guard] Distilled the output of bash `rg -n -i compact dist docs`: kept 141 of 431 lines (15.1k of 50.4k chars); the rest was judged not needed for the answer. Full output: recall({"entryId":"1704787f"}).
[… 79 lines omitted: matches in dist/core/tools/grep.js, dist/core/session-manager.js, dist/core/export-html/template.js, dist/core/export-html/template.css, dist/core/sdk.js and 5 more …]
dist/core/compaction/compaction.d.ts:25:    /** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
dist/core/compaction/compaction.d.ts:28:export interface CompactionSettings {
dist/core/compaction/compaction.d.ts:33:export declare const DEFAULT_COMPACTION_SETTINGS: CompactionSettings;
dist/core/compaction/compaction.d.ts:54:/** Estimate projected context without trusting usage captured before a later edit or compaction. */
dist/core/compaction/compaction.d.ts:57: * Check if compaction should trigger based on context usage.
dist/core/compaction/compaction.d.ts:59:export declare function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean;
[… 44 lines omitted: matches in dist/core/compaction/compaction.d.ts, dist/core/compaction/branch-summarization.d.ts, dist/core/compaction/index.d.ts, dist/core/session-manager.d.ts, dist/core/cache-stats.js and 2 more …]
```

| Example | Model | Tool output before → after | Jev | Next request's context, on / off | Main-model cost of turn 2, on / off | Follow-up |
|---|---|---|---|---|---|---|
| A. code search | Claude Sonnet 5.5 | 50.4k → 16.2k chars | 3 requests, 0.8 s, $0.0012 | 15.5k / 28.2k tokens | $0.033 / $0.016 | correct, no `recall` |
| A. code search | GPT-6 Luna | 56.6k → 14.8k chars (2 outputs; 2 more, 15k, left whole) | 5 requests, 0.6 s, $0.0015 | 11.5k / 34.3k tokens | $0.0012 / $0.0005 | correct, no `recall` |
| C. 164 KB file | GPT-6 Luna | 163k → 26k chars (7 reads) | 7 requests, 0.9 s, $0.0027 | 9.2k / 35.3k tokens | $0.0007 / $0.0005 | correct, no `recall` |
| B. failing test log | GPT-6 Luna | 15.8k → 8.6k chars | 1 request, 0.8 s, $0.0004 | 5.7k / 7.5k tokens | $0.0022 / $0.0016 | fixed in both runs |

**When it doesn't help.**

- **The first request after an edit costs more, not less.** The prompt cache only matches up to the
  first changed message, so the next request writes the shorter history again instead of reading the long
  one from cache. In A that made Claude's turn-2 request cost $0.033 instead of $0.016, and GPT's $0.0012
  instead of $0.0005; OpenAI read nothing from cache on that request (in the fixture runs it read 2,560
  tokens instead of 13,824: a partial miss).
  At the per-token prices in these runs, the smaller context earns that back after about 7 more requests
  (Claude, A), about 3 (GPT, A) or about 1 (GPT, C). Before that, the benefit is a smaller context window,
  not a lower bill. Anthropic requests also get a cache breakpoint at the previous question; in a run with
  11 sequential tool calls it raised the first request's cache read from 1,693 to 5,810 tokens compared
  with `pinAnthropicCache: false` ([docs/CACHE.md](docs/CACHE.md)).
- **Small or fully needed outputs are left whole.** In A, GPT's 9k-character read of `agent-session.js` was
  `not-worth` (too much of it was needed) and a 6k narrowed search was judged needed whole.

Numbers on the generated StatusBadge test repo (96% removed, `recall` of a removed line) are in
[docs/TESTING.md](docs/TESTING.md#results-pi-103).

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md): architecture and algorithm
- [docs/CACHE.md](docs/CACHE.md): prompt-cache impact (Anthropic, OpenAI) and the cost model
- [docs/JEV.md](docs/JEV.md): the Jev questions, probe results and threshold choices
- [docs/TESTING.md](docs/TESTING.md): unit tests, live end-to-end tests, manual TUI check

## License

MIT
