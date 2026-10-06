# Jev integration

Jev is TypeSafe's classifier model. It does not write text. It takes a **state** (any JSON) and a set of
**questions**, and returns a probability for each answer. The extension uses it to decide which chunks of a
tool output to keep. It never asks Jev to rewrite anything, so every kept line is the original line.

## Model and API

- Default: `openrouter/~typesafe/jev-latest` (provider `openrouter`, id `~typesafe/jev-latest`), a classifier
  model with a 32k-token context window in Pi 1.0.3's catalog.
- Called through `ctx.modelRegistry.classify(model, { state, questions }, { signal, timeoutMs, maxRetries: 1 })`.
  This uses Pi's TypeSafe "System One" API. The model is looked up with
  `ctx.modelRegistry.findOfType("classifier", provider, id)`. Credentials are checked with
  `hasConfiguredAuth`.
- Other Jev entries in Pi 1.0.3's catalog can be set with `model` but are **untested**:
  `openrouter/typesafe/jev-1.13`, `typesafe/jev-latest` (64k context), `opencode/jev-1.13`,
  `vercel-ai-gateway/typesafe-ai/jev`, `cloudflare-workers-ai/typesafe/jev`.

### Question types

| Type | Answer |
|---|---|
| `bool` | `probability` that the answer is true |
| `choice` | the chosen key, plus `probabilities` for every key; **single-select** |
| `score` | a score plus confidence (not used here) |

Every question has `instructions` and `criteria`, the meaning of each answer.

## Measured probes

Run on 2026-10-06 against `openrouter/~typesafe/jev-latest`, through `ctx.modelRegistry.classify`. These
are single probes on real tool outputs from this project, not a benchmark.

### Several questions in one request are billed once

| Request | Input tokens |
|---|---|
| `keep_whole` alone | 1,842 |
| `focus` alone | 2,224 |
| `keep_whole` + `focus` in one request | 2,309 |

The answers did not change: `keep_whole` was 0.39 alone and 0.40 combined, and `focus` chose `chunk_7` at
0.58 both times. The state (the chunks) is the expensive part, so all questions go in one request.

### `choice` is single-select; per-chunk yes/no questions are needed

On a grep where the answer cited 4 files, the "whole or which chunk" choice put 0.58 on one file, 0.41 on
`whole`, and about 0 on the other 3 cited files. A choice can only name **one** chunk. A separate yes/no
question per chunk separated them clearly: cited files 0.90–0.93, noise 0.14–0.43.

### Size, latency and cost

A 30k-character grep with 28 chunks and 30 questions: **13,155 input tokens, 745 ms, $0.00055**. Code is
about 2.3 characters per token. With a 32k-token context, that is why `maxSegmentChars` is 40,000 and
`maxChunksPerSegment` is 40.

In the live end-to-end runs, one qualifying run took 2 Jev requests: 550 ms and $0.00083 (GPT-6 Luna run), and
1.18 s and $0.00084 (Claude run).

### `focus` wording

| Wording | Case | Result |
|---|---|---|
| V1: "whole = no single chunk would be enough" | Broad search; the answer used 5 files | `whole` 0.73 (nothing removed) |
| V2: "whole = most of the output is needed; chunk_N = a few chunks are needed, chunk_N is the most important" | Same case | key chunk 0.81, `whole` 0.10 |
| V2 | Explanation of a whole file | `whole` 0.50 |
| V2 | Narrow `read` | the right chunk, 0.74 |
| V2 | RPC grep | the right chunk, 1.00 |

V1 made Jev choose `whole` whenever more than one chunk mattered. V2 is what `src/decide.ts` sends.

### A weak `whole` is unstable

On one output, `focus` split 0.43 `whole` against 0.45 for a chunk, and the choice flipped between
repeated runs. So a `whole` choice only keeps everything when its probability is at least 0.6
(`focusWholeThreshold`). Below that, the per-chunk answers decide. If most chunks turn out to be needed, the
result is still kept whole by `maxKeepRatio` (0.6).

### Citing files is not the same as needing them

`keepCitedFiles` keeps grep chunks for every file that the final answer names. In a live run, Claude's
answer named `test/fixtures/entities.json` to say it was **not** a usage, so the option kept 40 lines of
noise. It is off by default.

### Small reads are not worth it

`read` results of about 2.3k characters always ended as `not-worth`: Jev kept 2 of 3 chunks. So
`minResultChars` was raised to 4,000.

## The final question set

One request per segment, with these questions (exact wording in `src/decide.ts → buildRequest`):

1. **`keep_whole`** (bool): is all of this output still needed for the answer or a likely follow-up? This
   is a cheap coarse check for outputs that are all evidence, like a file being explained.
2. **`focus`** (choice: `whole`, `none`, `chunk_1`…`chunk_N`): does the answer use most of the output,
   nothing, or a few chunks, and which chunk matters most? This gives a confident "everything" or
   "nothing", and guarantees that the single most important chunk is kept even if its own yes/no answer is
   below the threshold.
3. **`chunk_N`** (bool, one per chunk): is this chunk needed? These pick up the other relevant chunks that a
   single-select choice cannot name.

Both the answer and "a likely follow-up question" are named in the questions. This keeps chunks that the
answer did not quote but that a natural next question would need.

## Thresholds and why

| Setting | Value | Reason |
|---|---|---|
| `keepWholeThreshold` | 0.7 | Keep everything only on a clear yes. The first probe above scored 0.39–0.40 on an output where one chunk was the key. |
| `focusWholeThreshold` | 0.6 | A weak `whole` (around 0.4–0.5) flipped between runs. Let the per-chunk answers decide instead. |
| `chunkKeepThreshold` | 0.6 | Needed chunks scored 0.90–0.93 and noise 0.14–0.43 in the probes. 0.6 sits in the gap. |
| `noneThreshold` | 0.5 | Remove a whole output only if `none` wins and no chunk passes its own question |
| `maxKeepRatio` | 0.6 | If most of the output is kept anyway, the saving does not justify the cache miss and the lost context |
| `minResultChars` | 4,000 | Reads around 2.3k characters were never worth an edit |

When an answer is missing, the request fails or the budget runs out, the extension keeps everything.
