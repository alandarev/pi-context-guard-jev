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

**Worst-case budget probe** (with earlier conversation in the state): every history part at its
clip limit (2,000-character summary, 1,000-character first request, 800 + 1,200 characters per exchange),
a 4,000-character question, a 6,000-character answer, 2,000 characters of notes, and one 40-chunk segment of
31,848 characters of dense `rg` output over Pi's `dist/core`:

| `historyExchanges` | Request bytes | Input tokens | Latency | Cost |
|---|---|---|---|---|
| 3 (default) | 68,951 | **19,630** | 650 ms | $0.00082 |
| 10 (maximum) | 83,214 | **23,619** | 799 ms | $0.00099 |

Both fit Jev's 32k-token context with room to spare (the target was ≤ 28k), so `maxSegmentChars` is
**32,000**, which keeps the worst case well below 32k with history included, and `maxChunksPerSegment`
is 40. Nested objects in the state (`earlier_conversation`) are accepted.

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
`minResultChars` is 4,000.

### Earlier conversation (`historyExchanges`)

Without history, Jev only sees the run's own question and answer. A broad search in a session whose goal was
stated earlier ("I'm about to migrate every API client to a shared retry helper") then loses exactly the
lines the ongoing work needs, because this run's question ("where is StatusBadge used?") does not mention
them. So the state carries `earlier_conversation`: the latest compaction/branch summary, the first
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
'{"historyExchanges":0}'`), with the wording `src/decide.ts` sends. Turn 1 states the retry-migration goal,
turn 2 is the broad StatusBadge search, turn 3 asks which clients retry on 429 without a new search (9 of
the 10 clients do); one run per cell:

| Model, history | src/api retry lines kept in turn 2 (of 80; with 429) | Turn-2 output, chars before → after | Jev | Turn 3 used `recall` | Turn 3 answer |
|---|---|---|---|---|---|
| GPT-6 Luna, on | **72 (21)** | 36,113 → 12,402 | 568 ms | yes | correct |
| GPT-6 Luna, off | 0 | 36,113 → 1,753 | 564 ms | yes | correct |
| Claude Sonnet 5.5, on | 5 (1) | 22,641 → 2,103 (Claude ran `rg … \| head -200`) | 555 ms | yes | missed `ticketStatus` (cut by Claude's own `head -200`) |
| Claude Sonnet 5.5, off | 0 | 36,113 → 2,638 | 547 ms | yes | correct list; headline says "eight" |

With history, GPT kept 72 of the 80 retry lines (9 of the 10 clients), at the cost of keeping 12.4k instead
of ~1.8k characters; Claude ran a truncated search and kept 5. A round with the second wording of the
table above kept no retry lines with history. History did not change turn-3 behaviour: the models used
`recall` either way, and the answers were about as good. Where it pays off is the context the model already
has after turn 2. Single runs per cell; the variance between runs is large.

### Checkpoint wording

Mid-run checkpoints ask a different question: there is no final answer, so Jev judges whether the agent
will still need an output to finish the task (`buildCheckpointRequest`; state and wording in
[DESIGN.md](DESIGN.md#mid-run-checkpoints)). Probed offline on real mid-run states from two no-guard runs
of the e2e `long` scenario (`fix all failing tests`), two repetitions per variant, reporting the share of
the output's characters that would be kept at chunk thresholds 0.5 / 0.55 / 0.6:

| Output (state) | What should happen | base wording | "acted" wording |
|---|---|---|---|
| GPT, 6 old `npm test` logs, each rerun later (`superseded`) | mostly go | 0.5: 15–69%, 0.6: **8–36%** | 0.5: 15–45%, 0.6: 15–30% |
| Claude, first `npm test` log (still the only full failure list; later runs were filtered) | keep the unresolved failures | 0.5: 73–80%, 0.6: 35–41% | 0.5: 80–87%, 0.6: 33–46% |
| Claude, `cat` of 5 source files, **all fixed since** | go | 0.5: 49–62%, 0.6: **11%** | 11% at every threshold |
| Claude, the same `cat` one turn after it ran, **files not fixed yet** | stay | 0.5: 100%, 0.6: **78%** | 0.5: 90%, 0.6: **10%** |

- *base*: "To finish user_question, will the agent still need the lines in chunk_N? Lines that are out of
  date or that the agent has already acted on and moved past are not needed."
- *acted*: "Will the agent need to look at chunk_N again before it finishes user_question? Say no if
  later_tool_calls show the agent already acted on it, or if superseded says a newer version exists."
  It dropped the in-use files (10%) and was rejected.
- A stronger `superseded` sentence ("the agent still sees that newer output…"), with the acted wording, did not help (15–65% at 0.5).

Mid-run probabilities are compressed (per-chunk 0.14–0.76, against 0.14–0.93 at run end). At 0.5,
superseded logs and finished files kept 50–70%, which `maxKeepRatio` (0.6) would then turn into "not
worth it", so most checkpoints would edit nothing. **Base wording at 0.6** separated the cases: in-use
files 78%, finished files 11%, superseded logs 8–36%. So `midRunChunkKeepThreshold` defaults to 0.6, the
same as run end, not lower: the brief proposed starting at 0.5 to keep more, and the probe showed that
0.5 keeps nearly everything.

### Old exchanges

`buildExchangeRequest` asks one bool per exchange: "Is exchange_N still relevant to the current work
(user_question and what the agent is doing for it)? Relevant means the agent may need its details: the
same files, task, decisions or facts." Probed with `node test/e2e/probe-items.mjs` (2 repetitions):

- three hand-written sessions (`test/e2e/probe-data/exchanges.json`) modeled on the shape of real long
  main-thread sessions (a prompt, a final answer, tool-call labels, a size; 5 old exchanges each, mixed
  relevant and unrelated to the current task);
- the eligible exchanges at prompts 4 and 5 of two no-guard runs of the `topics` scenario (GPT and Claude,
  public test repo): the first exchange (API retries) is unrelated to prompt 4 (`StatusBadge`) and relevant
  to prompt 5 (its follow-up).

| Label | P(relevant), 42 answers |
|---|---|
| relevant (16) | 0.47–0.96 (the weakest: "add a disk-usage alert for the backup volume" for a failing-backup task, 0.47–0.49; "how is contextTokens estimated with edits" for a compaction-settings task, 0.68) |
| unrelated (26) | 0.03–0.10 |

| Omit when P < | Accuracy | Relevant exchanges omitted | Unrelated exchanges omitted |
|---|---|---|---|
| 0.1 – 0.4 | 42/42 | 0/16 | 26/26 |
| 0.5 | 41/42 | 1/16 | 26/26 |

`exchangeOmitThreshold` is 0.2: omit only when Jev is clearly sure, with a wide margin to the weakest
relevant exchange (0.47). The sessions are synthetic or generated, so real sessions may be less clear-cut;
the margin is meant to absorb that. Repetitions agreed within 0.03.

### Small outputs

`buildSmallRequest` asks one bool per output ("will the agent still need the output in item_N?" mid-run;
"does item_N contain anything that final_answer relies on, or that a likely follow-up would need?" at run
end), with `superseded` shown when a later call made the output out of date.

| Probe | Needed | Not needed |
|---|---|---|
| Two hand-written mid-run states on the `long` fixture's code (`test/e2e/probe-data/small.json`), 24 answers | 0.59–0.74 | 0.06–0.32 |
| A `long` run of GPT-6 Luna (public fixture), mid-run at request 12 and at run end: reads of source files | not superseded: 0.48–0.68 | superseded (the file was edited afterwards): 0.19–0.41 |

At 0.6 (the chunk threshold) 2 of 10 needed outputs would be dropped; at 0.45 none, and every superseded or
unneeded output goes. `smallKeepThreshold` is 0.45. Without the `superseded` hint, Jev kept reads of files
the agent had already edited (0.49–0.86), so the hint is part of the request.

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
| `smallKeepThreshold` | 0.45 | Small-output probe above: needed outputs ≥ 0.48, superseded or unneeded ≤ 0.41 |
| `exchangeOmitThreshold` | 0.2 | Exchange probe above: unrelated ≤ 0.10, relevant ≥ 0.47; omit only when Jev is clearly sure |
| `midRunChunkKeepThreshold` | 0.6 | Checkpoint probe above: 0.5 kept 50–100% of everything; 0.6 kept in-use files and dropped finished ones |

When an answer is missing, the request fails or the budget runs out, the extension keeps everything.
