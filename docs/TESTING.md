# Testing

## Unit tests

```bash
npm install
npm test            # node --test test/unit/*.test.ts
npm run typecheck   # tsc --noEmit
npm run check       # both
```

These need Node ≥ 22.18, which runs the `.ts` files directly. There is no network access and no model call.

| File | Covers |
|---|---|
| `checkpoint.test.ts` | Mid-run eligibility and age, the memo and candidate rules, later calls, notes, superseded detection (edits, re-reads, reruns), cache anchors (read point only from logged entries of the same model within the TTL, invalidated by later edits and compaction, parallel-call batches never split, early return without pending edits), refresh on read-through (same model, cacheRead clearly past the entry, unchanged prefix; trusted after 5 minutes once refreshed), the run baseline, the Anthropic rewrite estimate (from the trusted read point, else from the question), pending edits, the memo from records, the break-even rule, context size with summaries |
| `run.test.ts` | Run span (including image-only prompts), question/answer/notes, candidate rules (errors, images, excluded tools, short, already-distilled and other-extension-edited results), steering messages; history (last N exchanges, first request, compaction/branch summaries, image-only and steering prompts, clipping, `historyExchanges` 0) |
| `chunk.test.ts` | grep detection, grouping by file, context lines and `--`, `-digits-` file names, split/merge rules, plain-text windows, segment limits |
| `decide.test.ts` | Checkpoint request shape and wording; run-end request shape, with and without `earlier_conversation` (state order, omitted parts, history wording vs. the unchanged single-run wording); the decision order (error, missing answers, `keep_whole`, strong/weak `whole`, chunks, `none`); `citedFiles` |
| `distill.test.ts` | Skips, edits, `removed`, `not-worth`, failures, time budget (including a classifier that never answers and late answers), parent abort, concurrency limit, multi-segment outputs, oversize segments never sent, `keepCitedFiles`, usage sums |
| `render.test.ts` | Labels, verbatim chunks with omission lines, `read` offsets, file lists, full removal |
| `cache-pin.test.ts` | Question pin: API-key and OAuth payloads, trailing system messages, TTL selection and `ttl-conflict`, string content, tool-result-only messages, over-budget restore. Anchors: question > read > write priority, read anchor inside a batch of tool_result blocks, breakpoint budget (identity and tools breakpoints dropped, then write, then read; the question survives a foreign breakpoint), not found / last message / already marked, normalized tool ids, TTL order, `markedToolResults` |
| `stats.test.ts` | Savings from the projection, run records (checkpoints counted), status texts and colours, cost format |
| `recall.test.ts` | Original output, pattern (length cap, 4,000-char match window, catastrophic-regex timeout), offset/limit, line and byte caps, oversized lines |
| `config.test.ts` | Defaults, validation and ranges (incl. `historyExchanges` 0–10 integer and the `midRun*` settings), `provider/id` parsing, load/save round trip |
| `extension.test.ts` | The real entry point (see below) |

`extension.test.ts` loads `src/index.ts` through **Pi's own extension loader** (`loadExtensions` from the
`@earendil-works/pi-coding-agent` devDependency), then drives the handlers with a fake `ctx`. It sets
`PI_CODING_AGENT_DIR` and `PI_CONTEXT_GUARD_CONFIG` to a temporary directory, so `/guard on|off` never touches the real
`~/.pi/agent/context-guard.json`. It checks that the handlers, tool and command are registered, that drafts
are appended after other extensions' drafts, that unfinished runs and a missing model are ignored, that the
pin applies only to `anthropic-messages`, that `recall` works, and that `/guard off|on` persists. For
`turn_end` it checks that the final turn is skipped, that a batch below `midRunBatchChars` and a checkpoint
that would not break even are skipped, that a due checkpoint appends edits and a `mid-run` record after other
drafts (never `continue`), that nothing is judged twice once the record is committed, that drafts a later
handler dropped (or Pi rejected) are judged again, that an unanswered output (error) is asked again, that the
memo follows `/tree`, and that run end judges outputs kept mid-run again. On a `pi-claude-auth`-shaped
payload (system prompt moved into the first user message) it checks the question pin on every request; on
the first request after edits a write anchor, and a read point only at an entry this process sent earlier
(also on a warming replay); a read point after run-end edits; and no read point for another model, after
the TTL (mocked clock), after a reload, for an anchor dropped for the budget, or for history made with
pinning off. Through `message_end` it checks that a response that read through a logged entry keeps it
usable past 5 minutes, and that a short read or another model's response does not.

Test through Pi's loader (or `pi -e`), not a plain Node import of the extension. Plain Node imports of
`@earendil-works/pi-coding-agent` can fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`, even though Pi loads the
same code without problems.

## Live end-to-end test

This uses a real Pi, a real main model and real Jev requests. **It costs money or subscription quota**: a few
main-model requests per turn, plus a few Jev requests (under $0.001 per distilled run).

```bash
node test/e2e/run-e2e.mjs --model <provider/id> [--ext <path>]... [--scenario badge|sequential|history|long] \
  [--config '<JSON>'] [--no-guard] [--turns N] [--thinking level]
```

| Option | Default | Meaning |
|---|---|---|
| `--model` | (required) | Main model, e.g. `openai-codex/gpt-6-luna` or `anthropic/claude-sonnet-5-5` |
| `--ext` | none | Extra extension to load; can be repeated (e.g. an auth extension) |
| `--scenario` | `badge` | `badge`: 3 turns about `StatusBadge` usages. `sequential`: 2 turns with 10+ sequential tool calls, for the question pin. `history`: 3 turns for the earlier-conversation feature. `long`: one autonomous "fix all failing tests" run, for mid-run checkpoints (both below). |
| `--config` | `{}` | context-guard settings for this run, e.g. `'{"pinAnthropicCache":false}'` |
| `--no-guard` | off | Control run without context-guard |
| `--turns` | `3` | Turns to run (capped by the scenario) |
| `--thinking` | `low` | Pi thinking level |

How it works:

- `test/e2e/make-fixture.mjs` generates a deterministic fake web app. A `StatusBadge` component is used in 5
  places, hidden among many other "status" matches: a similar `StatusBar`, reducers, API clients, a log file
  and JSON fixtures. `rg -n -i status` over it prints 36,113 characters.
- Each turn is a separate `pi --mode json -ne` process on the same session id, run inside the fixture repo.
  Pi's installed extensions are disabled. context-guard, any `--ext`, and `test/e2e/capture.ts` (loaded
  last) are loaded explicitly. The capture extension records every final provider payload and its cache
  breakpoints.
- `PI_CONTEXT_GUARD_CONFIG` points at a per-run file, so your own settings are never read or changed.
- `pi` must be on `PATH`. The exit code is 0 only when every check passes.

### Checks

| Check | Meaning |
|---|---|
| turn 1 answer names all 5 usages | Distilling did not hurt the first answer |
| turn 1 produced context edits | A `context_edit` entry was written |
| turn 1 Jev record saved chars | The `context-guard` record has `savedChars` > 0 |
| turn 2 answer names the danger usages | The follow-up was answered correctly from the distilled context |
| turn 2 first request carries distilled text | The payload contains more `[context-guard]` markers than turn 1's |
| turn 2 first request no longer carries raw search noise | `statusNote` and `http_status=` (noise lines) are gone from the payload |
| turn 2 first request reads cache | `cacheRead` > 0 on the first request after the edit |
| turn 3 quotes the removed line exactly | The model quoted line 3 of `src/api/jobStatus.ts` from the "first search" |
| turn 3 used recall (line was distilled away) | Only when that line is missing from turn 3's payload: the model must have called `recall` |
| sequential: turn 1 produced context edits / 10+ tool calls / 10+ model requests | The sequential scenario really was long and sequential |
| long: the suite is green afterwards | `npm test` passes in the fixture after the run |
| long: at least one mid-run checkpoint (forced) | Only with `midRunBreakEven: false` in `--config`: a `mid-run` record was written (a default run may rightly make none) |
| long: request after the checkpoint at request N reads the cached prefix | Anthropic: the first request after each checkpoint reads at least what the run's first request read and wrote (system prompt and question) |
| history: turn 2 produced context edits | The broad search in turn 2 was distilled |
| history: turn 3 names exactly the clients that retry on 429 | The answer names the 9 clients whose fixture file has `=== 429`; a client named only to say it does *not* retry is allowed |
| anthropic requests stay within 4 breakpoints | For `anthropic/…` models: the pin never exceeds the limit |

**`history` scenario.** Turn 1 only states a session goal ("I'm about to migrate every API client in
src/api to a shared retry helper… just acknowledge"), turn 2 is the broad `rg -n -i status` StatusBadge
search, turn 3 asks which clients retry on HTTP 429 without a new search ("if it's not in your context, use
recall"). Run it with and without `--config '{"historyExchanges":0}'` to compare. Besides the checks, the
summary has a `history` block: `keptApiRetryLines` / `kept429Lines` (src/api retry lines kept in turn 2's
distilled text), the turn-2 Jev results and ms, turn 3's tool calls and whether it used `recall`, and the
clients turn 3 named. Results are in [JEV.md](JEV.md#earlier-conversation-historyexchanges).

**`long` scenario.** `test/e2e/make-long-fixture.mjs` generates a small Node project (`ledgerly`: money
in integer cents, business-day calendars, CSV, pricing, a ledger report; 182 tests). Ten bugs sit in
different modules, in up to three layers: an import-time `ReferenceError` hides a whole test file, and two
tests fail first because of one bug and then, once it is fixed, because of another. A full `npm test` prints
12k characters when green and 25–30k with the failures, so every rerun is a large, quickly superseded tool
output. The prompt asks the agent to fix one bug at a time and run the plain suite after every fix, without
asking anything. (`--fixed` writes the bug-free version, `--bugs 1,4,…` a subset.) GPT-6 Luna needs 26–37
requests; Claude Sonnet 5.5 needs 8–14, because it batches several fixes per command and pipes test output
into `grep`/`head`. Load `--ext test/e2e/plain-test-runs.ts` for Claude to strip a pipe after `npm test`
(it logs each rewrite to stderr), so its suite runs return full logs like GPT's.

The summary gets a `long` block: per-request contexts (input + cacheRead + cacheWrite) and a sparkline,
totals of input/cacheRead/cacheWrite/output and the main-model cost Pi reports, every `context-guard`
record with its phase, saved characters, Jev ms and cost, and the request before and after it (context,
cacheRead, cacheWrite), whether the suite is green, `recall` calls, and repeated non-suite tool calls (lost
outputs searched again). Results are in the README ("Long autonomous runs") and in
[CACHE.md](CACHE.md#mid-run-checkpoints).

**Anthropic TTL experiment.** `node test/e2e/ttl-probe.mjs [--arms refresh,control,ttl1h,idle,idle1h]`
runs `test/e2e/ttl-probe.ts` with Claude: does a cache entry stay alive while later requests read a longer
prefix, and does it expire when nothing reads it for 6 minutes? About 9 minutes and roughly $0.9 at list price for all five arms.
Results: [CACHE.md](CACHE.md#do-cache-entries-on-the-read-path-stay-alive-measured).

With the guard on, the badge scenario has 9 checks, plus 1 for Anthropic models. Most guard checks are
skipped with `--no-guard`.

### Artifacts

Each run writes to `test/e2e/out/<timestamp>-<model>-<scenario>[-noguard][-cfg…]/` (ignored by git):

| File | Content |
|---|---|
| `summary.json` | Per turn: answer, tool calls, usage, first-request breakpoints, edits, Jev records with traces; and the checks |
| `turn-N.events.jsonl`, `turn-N.stderr.txt` | Pi's JSON event stream and stderr |
| `capture.jsonl` | One line per provider request and assistant message |
| `capture.jsonl.tN-NNN.json` | The full payload of each request (turn N, request NNN) |
| `sessions/` | The Pi session file, including `context_edit` and `context-guard` entries |
| `repo/` | The generated fixture |
| `context-guard.json` | The settings used |

### Claude subscription in this setup

Requests with an Anthropic subscription needed the `pi-claude-auth` extension. With Pi's native OAuth alone,
the request failed with HTTP 400 "Third-party apps now draw from your extra usage". Load it explicitly, since
the runner disables installed extensions:

```bash
node test/e2e/run-e2e.mjs --model anthropic/claude-sonnet-5-5 --ext ~/.pi/agent/npm/node_modules/pi-claude-auth
node test/e2e/run-e2e.mjs --model anthropic/claude-sonnet-5-5 --ext ~/.pi/agent/npm/node_modules/pi-claude-auth --scenario sequential
node test/e2e/run-e2e.mjs --model anthropic/claude-sonnet-5-5 --ext ~/.pi/agent/npm/node_modules/pi-claude-auth --scenario sequential --config '{"pinAnthropicCache":false}'
node test/e2e/run-e2e.mjs --model openai-codex/gpt-6-luna
node test/e2e/run-e2e.mjs --model openai-codex/gpt-6-luna --no-guard
node test/e2e/run-e2e.mjs --model openai-codex/gpt-6-luna --scenario history
node test/e2e/run-e2e.mjs --model openai-codex/gpt-6-luna --scenario history --config '{"historyExchanges":0}'
# mid-run checkpoints (up to 4 in parallel)
node test/e2e/run-e2e.mjs --model openai-codex/gpt-6-luna --scenario long --no-guard
node test/e2e/run-e2e.mjs --model openai-codex/gpt-6-luna --scenario long --config '{"midRun":false}'
node test/e2e/run-e2e.mjs --model openai-codex/gpt-6-luna --scenario long
node test/e2e/run-e2e.mjs --model anthropic/claude-sonnet-5-5 --ext ~/.pi/agent/npm/node_modules/pi-claude-auth --ext test/e2e/plain-test-runs.ts --scenario long
```

### Results (Pi 1.0.3)

| Run | Result |
|---|---|
| GPT-6 Luna, badge | 36,113 → 1,501 chars, 2 Jev requests, 550 ms, $0.00083; turn 3 used `recall` with a regex; 9/9 checks pass |
| Claude Sonnet 5.5, badge | 36,113 → 3,066 chars, 2 Jev requests, 1.18 s, $0.00084; turn 2 cacheRead 5,777 / cacheWrite 2,036; turn 3 used `recall`; 10/10 checks pass |
| Claude Sonnet 5.5, sequential, with / without pin | first request after the run: cacheRead 5,810 / 1,693, cacheWrite 8,913 / 13,068 |
| GPT-6 Luna, badge, with / without guard | turn 2 cacheRead 2,560 / 13,824 |
| GPT-6 Luna, badge, with history (default) | 36,113 → ~2.3k chars; 9/9 checks pass (a run in parallel with 4 others had one OpenAI cache miss on turn 2: 8/9) |
| GPT-6 Luna / Claude Sonnet 5.5, history on / off | See [JEV.md](JEV.md#earlier-conversation-historyexchanges): 2 rounds × 4 runs |
| GPT-6 Luna / Claude Sonnet 5.5, long (mid-run checkpoints) | See the README, "Long autonomous runs"; all suites green, no `recall` |

See [CACHE.md](CACHE.md) for what the cache numbers mean.

## Real-world examples (`examples.mjs`)

The README's "Examples (measured)" section comes from `test/e2e/examples.mjs`. It runs the same prompts on
real public code twice, with context-guard on and with it off (`--no-guard`), and compares the first
request of the follow-up turn.

```bash
node test/e2e/examples.mjs                      # all examples, at most 4 Pi runs at once
node test/e2e/examples.mjs --only A --models gpt # a subset
node test/e2e/examples.mjs --jobs 2
```

| Example | Workspace (a temp copy) | Turn 1 | Turn 2 | Correct when | Models |
|---|---|---|---|---|---|
| A. code search | The installed Pi package: `dist/` without `*.map` and `dist/bundle/` (one-line minified duplicates), plus `docs/` | "Where does Pi decide to auto-compact…? Start with `rg -n -i compact dist docs`…" | "Which of those settings can a user change, and what are their defaults?" | Names `enabled`, 16384 and 20000 | GPT-6 Luna, Claude Sonnet 5.5 |
| B. test log | This repository (`src/`, `test/unit/`, configs; `node_modules` symlinked; a git repo) with one off-by-one in `src/render.ts` (3 tests fail) | "Run node --test --test-reporter=spec test/unit/*.test.ts…" | "Now fix it and rerun only the failing test file." | `render` and `extension` tests pass afterwards | GPT-6 Luna |
| C. large file | As A | "Read dist/core/agent-session.js completely…" | Quote the exact error thrown when a prompt arrives during compaction (not mentioned in turn 1's answer) | The answer contains the exact message | GPT-6 Luna |

Each run gets its own workspace, session id and `PI_CONTEXT_GUARD_CONFIG` file (defaults). The Pi package is
public (npm); nothing private is sent to OpenRouter. Example B also records the test log's size
(`testLogChars`, which must be ≥ 8,000 to be a fair example; it was 14.4–15.8k).

Output: `test/e2e/out/examples-<stamp>/` with `results.md` (the table), `results.json`, and one directory per
run (`A-claude-on`, …) holding `summary.json` (per turn: tool calls, tool-result sizes, edits with kept/total
lines, Jev records, the first request's input/cacheRead/cacheWrite, main-model cost from Pi's usage, the
answer), the raw events, the captured payloads, and `turn-N.edit-K.txt`: the exact replacement text the
model saw.

**Cost of a full run** (8 Pi runs, measured once): Jev $0.0055 in total; main models $0.26 as computed by
Pi from list prices (most of it Claude in example A; GPT runs used a subscription). About 5 minutes with 4
parallel jobs.

**Findings** (details in the README):

- Next-request context, on / off: A Claude 15.5k / 28.2k tokens, A GPT 11.5k / 34.3k, C GPT 9.2k / 35.3k,
  B GPT 5.7k / 7.5k; all follow-ups correct, none needed `recall`.
- The first request after an edit costs more with the guard on (cache rewrite): A Claude $0.033 / $0.016.
- B: the failing test log (an error result, distilled because `distillErrors` is on) went 15.8k → 8.6k
  chars, keeping the 3 failures with their assertion messages.
- C: `read` outputs end with Pi's "[Showing lines …]" note; omission ranges are clamped to the file lines
  and a removed note gets no omission line.

## Manual TUI check (tmux)

This checks the status bar, the working message and `/guard` in the real interactive UI.

Pi has to run with the same network access as your normal Pi sessions. A tmux server keeps the
environment and network namespace it was started in. If your providers are only reachable through a VPN
network namespace, start Pi inside it, e.g. `sudo ip netns exec <ns> sudo -E -u $USER pi …`, or your own
wrapper.

```bash
REPO=~/projects/pi/pi-context-guard-jev
node $REPO/test/e2e/make-fixture.mjs /tmp/cg-fixture
echo '{}' > /tmp/cg-fixture.json        # keeps /guard on|off away from your real settings

PI_CMD="pi -e $REPO/src/index.ts"       # prefix with your netns wrapper if needed
# add  -e ~/.pi/agent/npm/node_modules/pi-claude-auth  for a Claude subscription in a -ne run
tmux new-session -d -s cg -x 200 -y 50 -c /tmp/cg-fixture "PI_CONTEXT_GUARD_CONFIG=/tmp/cg-fixture.json $PI_CMD"
tmux capture-pane -p -t cg | tail -5     # footer: 🛡 0 saved

tmux send-keys -t cg "Which parts of this codebase use the StatusBadge UI component? Start with rg -n -i status." Enter
tmux capture-pane -p -t cg | tail -5     # while Jev runs: 🛡 distilling…
tmux capture-pane -p -t cg | tail -5     # afterwards: 🛡 −4.2k · 1 (numbers vary)

tmux send-keys -t cg "/guard" Enter
tmux capture-pane -p -t cg -S -40        # model, savings, Jev runs/requests/cost, per-result traces

tmux kill-session -t cg
```

Expected, as observed: the footer goes from `🛡 0 saved` to `🛡 distilling…` to
`🛡 −4.2k · 1` (≈ tokens kept out of context · distilled results). Pi's own context meter drops (33k to 17k in the observed run). `/guard` lists the
last run's results with traces such as `kw.15 focus=chunk_4:.52 keep 9/29`. Also try `/guard off` (footer
`🛡 guard off`) and `/tree` back to before the run (savings go back to `0 saved`).
