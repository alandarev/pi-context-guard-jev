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
about 2.3 characters per token.

**Worst-case budget probe** (after earlier conversation was added to the state): every history part at its
clip limit (2,000-character summary, 1,000-character first request, 800 + 1,200 characters per exchange),
a 4,000-character question, a 6,000-character answer, 2,000 characters of notes, and one 40-chunk segment of
31,848 characters of dense `rg` output over Pi's `dist/core`:

| `historyExchanges` | Request bytes | Input tokens | Latency | Cost |
|---|---|---|---|---|
| 3 (default) | 68,951 | **19,630** | 650 ms | $0.00082 |
| 10 (maximum) | 83,214 | **23,619** | 799 ms | $0.00099 |

Both fit Jev's 32k-token context with room to spare (the target was ≤ 28k), so `maxSegmentChars` is
**32,000** (lowered from 40,000 to keep the worst case well below 32k now that history is included) and
`maxChunksPerSegment` stays 40. Nested objects in the state (`earlier_conversation`) are accepted.

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

### Earlier conversation (`historyExchanges`)

Without history, Jev only sees the run's own question and answer. A broad search in a session whose goal was
stated earlier ("I'm about to migrate every API client to a shared retry helper") then loses exactly the
lines the ongoing work needs, because this run's question ("where is StatusBadge used?") does not mention
them. So the state now carries `earlier_conversation`: the latest compaction/branch summary, the first
prompt and the last 3 exchanges (prompt + last assistant text), clipped (docs/DESIGN.md).

**Wording.** Offline A/B on the real turn-2 run of the e2e `history` scenario (Claude's `rg -n -i status`,
57 chunks, 11 of them with `src/api` retry lines; P = per-chunk probability for those 11 chunks, 3 samples
unless noted):

| Variant | P(src/api chunks) | src/api chunks kept | All chunks kept |
|---|---|---|---|
| No history | 0.13–0.33 | 0 | 9 |
| History, chunk_N "…or that the ongoing work in earlier_conversation or a likely follow-up will need?" | 0.21–0.42 | 0 | 7–8 |
| History, chunk_N "…or that the ongoing work in earlier_conversation will need, even if user_question is about something else?" (2 samples) | 0.27–0.50 | 0 | 8 |
| History, chunk_N "…or that the user's ongoing task in earlier_conversation will need, even if the current question is about something else?" (3 samples) | 0.37–0.64 | 2–5 | 9–12 |
| Same wording, but the earlier exchange replaced by an unrelated "I'll ask a few questions" (control, 2 samples) | 0.20–0.35 | 0 | 7 |

The last wording is what `src/decide.ts` sends: it is the only one that lifts the relevant chunks over the
0.6 threshold, and the control shows it does not keep more when the history is unrelated. The effect is
still borderline (the relevant chunks sit around the threshold), so history makes Jev keep *some* of
what the ongoing work needs, not reliably all of it; `recall` remains the safety net.

**Live A/B** (`node test/e2e/run-e2e.mjs --scenario history`, with and without `--config
'{"historyExchanges":0}'`). Turn 1 states the retry-migration goal, turn 2 is the broad StatusBadge search,
turn 3 asks which clients retry on 429 without a new search (9 of the 10 clients do). Round 1 used the
first wording above, round 2 the final one; one run per cell:

| Model, history | Round | src/api retry lines kept in turn 2 (of 80; with 429) | Turn-2 output, chars before → after | Jev | Turn 3 used `recall` | Turn 3 answer |
|---|---|---|---|---|---|---|
| GPT-6 Luna, on | 1 | 0 | 36,113 → 1,772 | 518 ms | yes | correct |
| GPT-6 Luna, off | 1 | 0 | 36,113 → 2,100 | 594 ms | no | wrong ("can't determine") |
| Claude Sonnet 5.5, on | 1 | 0 | 36,113 → 2,612 | 685 ms | yes | correct |
| Claude Sonnet 5.5, off | 1 | 8 (3) | 36,113 → 4,439 | 588 ms | yes | correct list; headline says "10" |
| GPT-6 Luna, on | 2 | **72 (21)** | 36,113 → 12,402 | 568 ms | yes | correct |
| GPT-6 Luna, off | 2 | 0 | 36,113 → 1,753 | 564 ms | yes | correct |
| Claude Sonnet 5.5, on | 2 | 5 (1) | 22,641 → 2,103 (Claude ran `rg … \| head -200`) | 555 ms | yes | missed `ticketStatus` (cut by Claude's own `head -200`) |
| Claude Sonnet 5.5, off | 2 | 0 | 36,113 → 2,638 | 547 ms | yes | correct list; headline says "eight" |

Honest reading: with the first wording, history made no difference to what was kept (0 retry lines with
history; the one run that kept 8 had history off). With the final wording, GPT round 2 kept 72 of the 80
retry lines (9 of the 10 clients), at the cost of keeping 12.4k instead of ~1.8k characters; Claude round 2
ran a different, truncated search (`| head -200`) and kept 5. It did not change turn-3 behaviour: the main models used `recall` in 7 of 8
runs either way, and the turn-3 answers were about as good with and without history. Where history pays
off is the context the model already has after turn 2, which avoids the recall round trip only when enough
is kept. Single runs per cell; the variance between rounds is large.

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
