# pi-context-guard-jev

A Pi extension that shrinks large tool outputs once a run has finished.
Questions like *"which parts of the codebase use component X?"* make the agent search widely. The
`rg`/`read`/`bash` outputs fill the context, but the final answer usually needs only a few lines of them.
When a run finishes, the extension asks the Jev classifier (by TypeSafe) which parts of each large
output the answer still needs. It then uses Pi's append-only `context_edit` entries to replace each output
with only those parts, copied verbatim. Later turns carry the answer and its evidence instead of everything
that was searched. The raw output stays in the session file, and the model can fetch it again with the
`recall` tool.

## How it works

1. **A run finishes.** When Pi is about to settle a completed run (`agent_before_settle`), the extension
   looks at that run only: everything after the last user message.
2. **It picks candidates.** These are text-only tool results of at least 4,000 characters. The run is
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

Errors, timeouts and unclear answers always mean *keep*. For the full algorithm, see
[docs/DESIGN.md](docs/DESIGN.md).

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
| `🛡 distilling…` | Jev is judging the outputs of the run that just finished |
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
| `/guard` or `/guard status` | Shows whether the guard is on, the model, the savings on this branch, Jev runs, requests and cost, and the last run's result for each tool output, including Jev traces such as `kw.15 focus=chunk_4:.52 keep 9/29` |
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
| `historyExchanges` | `3` | Earlier exchanges (prompt + last assistant text) sent to Jev so it judges relevance against the ongoing work; `0` sends no earlier conversation at all (integer 0–10) |
| `pinAnthropicCache` | `true` | Add an Anthropic cache breakpoint at the previous user question ([docs/CACHE.md](docs/CACHE.md)) |

Example:

```json
{ "minResultChars": 6000, "excludeTools": ["edit", "write", "bash"] }
```

## What it does not touch

- user and assistant messages, custom messages
- tool results that contain images or are errors
- results of excluded tools (`edit`, `write` by default)
- results shorter than `minResultChars`, and runs below `minRunChars`
- aborted or failed runs
- results that are already distilled, or that another extension already edited
- single lines too long for one Jev request (kept as they are)
- earlier runs: only the run that just finished is edited

## Limitations

- **Lossy by design.** Relevance is judged against *this* question and answer, so a follow-up may need
  something that was removed. The header and omission lines say what is missing, and `recall` returns it.
- **Latency.** Settling waits for Jev. This adds about 0.5–1.2 s after each qualifying run (measured), and
  never more than `timeoutMs` (8 s).
- **Cost.** Each qualifying run costs a few Jev requests, measured at under $0.001 per run. The first prompt
  after an edit also has a one-time partial prompt-cache miss ([docs/CACHE.md](docs/CACHE.md)).
- **Steering.** A message sent during a run starts a new span. Tool results from before it are never
  distilled.

## Measured

Pi 1.0.3. A generated test repo; the prompt "which parts use the `StatusBadge` component", starting with
`rg -n -i status` (36,113 characters of output). See [docs/TESTING.md](docs/TESTING.md).

| Main model | Output after distilling | Jev | Follow-ups |
|---|---|---|---|
| GPT-6 Luna (openai-codex) | 1,501 chars (96% removed) | 2 requests, 550 ms, $0.00083 | Turn 2 answered from the distilled context; turn 3 used `recall` and quoted a removed line exactly |
| Claude Sonnet 5.5 | 3,066 chars | 2 requests, 1.18 s, $0.00084 | Turn 2 read 5,777 tokens from cache; turn 3 used `recall` |

- In the interactive TUI, Pi's own context meter dropped from 33k to 17k after one distilled run, and the footer
  showed `🛡 −4.2k · 1` (≈ tokens kept out of context · distilled results).
- In a long Claude run (11 sequential tool calls), the question breakpoint raised the first request's cache
  read from 1,693 to 5,810 tokens and lowered its cache write from 13,068 to 8,913.
- With OpenAI, the first request after an edit read 2,560 tokens from cache instead of 13,824
  (a one-time partial miss).

These are single runs on one test repo, not a benchmark.

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md): architecture and algorithm
- [docs/CACHE.md](docs/CACHE.md): prompt-cache impact (Anthropic, OpenAI) and the cost model
- [docs/JEV.md](docs/JEV.md): the Jev questions, probe results and threshold choices
- [docs/TESTING.md](docs/TESTING.md): unit tests, live end-to-end tests, manual TUI check

## License

MIT
