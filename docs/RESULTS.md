# Measured results

Single runs on Pi 1.0.3, not a benchmark: the main model takes a different path each time. Costs are what Pi
reports at list price. How to reproduce them: [TESTING.md](TESTING.md).

## Examples

Real runs on public code: each example ran once with the guard on and once with it off (`--no-guard`), from
the same prompts. Reproduce with `node test/e2e/examples.mjs`.
Examples A–C judge large outputs only (their numbers match `smallResultMinChars: 0`); example D shows the
default configuration and `exchangeBreakEven: false`.

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
| D. five topics | Claude Sonnet 5.5, `exchangeBreakEven: false` | 1 old exchange omitted (8.8k chars) | 2 requests, $0.0003 | 8.0k / 12.8k tokens (prompt 5) | $0.017 / $0.006 (prompt 5's first request) | correct, searched again |

**D. Several topics in one session.** In the generated test repo, five prompts in a row: which API
clients retry on 503; a README paragraph for `StatusBar`; a count of HTTP 500 lines in a log; where
`StatusBadge` is used; and then "back to the clients that retry on 503: which of them also retry on 502?"
(`node test/e2e/run-e2e.mjs --scenario topics --turns 5`). The README exchange is under 2,000 characters
and is never judged; the last 2 exchanges before each prompt are never judged either.

| Model, configuration | First exchange at the end of prompt 4 | At the end of prompt 5 | Prompt 5 | Context of prompt 5's first request | Main-model cost | Jev |
|---|---|---|---|---|---|---|
| GPT-6 Luna, default | judged unrelated (P = 0.07), **deferred**: too small to pay for the cache rewrite in a 4-prompt session | relevant (P = 0.95), kept | correct, no `recall` | 7.5k, 6,656 read from cache | $0.0018 | $0.0005 |
| Claude Sonnet 5.5, default | unrelated (P = 0.07), deferred | relevant (P = 0.97), kept | correct, no `recall` | 11.5k, 11,049 read from cache | $0.073 | $0.0003 |
| Claude Sonnet 5.5, `exchangeBreakEven: false` | unrelated (P = 0.08), **omitted** (8.8k characters, 5 entries) | – | correct, searched again | 8.0k: 1,760 read, 6,280 written | $0.087 | $0.0003 |
| Claude Sonnet 5.5, guard off | – | – | – | 12.8k | $0.083 | – |

In this short session the gate kept the first exchange, which the follow-up then needed. With the gate off,
the omission made the next request rewrite the cache from the omitted exchange on (it comes before the
question pin) and the model searched again; the smaller context pays off only in longer sessions.

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
  with `pinAnthropicCache: false` ([CACHE.md](CACHE.md)).
- **Small or fully needed outputs are left whole.** In A, GPT's 9k-character read of `agent-session.js` was
  `not-worth` (too much of it was needed) and a 6k narrowed search was judged needed whole.

Numbers on the generated StatusBadge test repo (96% removed, `recall` of a removed line) are in
[TESTING.md](TESTING.md#results-pi-103).

## Long autonomous runs

**Measured** (Pi 1.0.3, e2e scenario `long`: "fix all failing tests" in a generated project with 10 bugs,
the full suite after every fix; single runs, not a benchmark; costs are what Pi reports at list price):

| Main model | Configuration | Requests | Peak context | Main-model cost | Checkpoints (Jev) | Suite green |
|---|---|---|---|---|---|---|
| GPT-6 Luna | guard off | 32 / 37 | 68.4k / 87.7k | $0.020 / $0.030 | – | yes / yes |
| GPT-6 Luna | `midRun: false` (run end only) | 26 | 86.3k | $0.022 | – (run end $0.006) | yes |
| GPT-6 Luna | default | 29 | **45.0k** | $0.021 | 2 at requests 16 and 24, 0.8 s each, removed 62k and 60k chars ($0.006 with run end) | yes |
| GPT-6 Luna | `smallResultMinChars: 0` (large outputs only) | 31 | 72.4k | $0.024 | 1 at request 19, 1.0 s, removed 154k chars ($0.007 with run end) | yes |
| Claude Sonnet 5.5 | guard off | 14 | 89.8k | $0.41 | – | yes |
| Claude Sonnet 5.5 | `smallResultMinChars: 0` | 8 | 65.7k | $0.24 | none: too short to pay off (run end $0.003) | yes |
| Claude Sonnet 5.5 | forced: `midRunBreakEven: false`, `midRunMinAgeTurns: 2`, `midRunBatchChars: 20000`, `smallResultMinChars: 0` | 12 | 43.3k | $0.34 | 3 ($0.0032 with run end) | yes |

Context per request (every 5th request), GPT-6 Luna:

| Request | 1 | 6 | 11 | 16 | 21 | 26 | 31 | 36 |
|---|---|---|---|---|---|---|---|---|
| guard off (37 requests) | 3.0k | 14.6k | 29.3k | 41.4k | 52.1k | 62.5k | 73.3k | 83.4k |
| default (29 requests) | 3.2k | 17.0k | 35.3k | 41.0k | 39.3k | 28.9k | – | – |

At the default run's first checkpoint, Jev distilled four superseded test logs (for example 30,164 → 8,163)
and replaced 4 of 7 small reads of files the agent had already edited with one-line notes (for example
3,386 → 145); the next request carried 20.1k instead of 41.0k tokens. No run needed `recall`.

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
- Details: [CACHE.md](CACHE.md#mid-run-checkpoints), [DESIGN.md](DESIGN.md#mid-run-checkpoints),
  wording probe in [JEV.md](JEV.md#checkpoint-wording).

## Old images

Claude Sonnet 5.5 with `pi-claude-auth`, 2026-10-08: six 1200×800 PNGs, read one per message, then a
follow-up about the second one. The run end removed the four images that were 3–6 turns old, with no Jev
request (19.9k chars ≈ 5k tokens). The next request carried 2 images instead of 6: 9.4k input tokens
instead of about 14.1k. Told not to read the file again, the model called `recall`, got the image back and
read the code number in it correctly.
