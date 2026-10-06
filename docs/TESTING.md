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
| `run.test.ts` | Run span, question/answer/notes, candidate rules (errors, images, excluded tools, short and already-distilled results), steering messages |
| `chunk.test.ts` | grep detection, grouping by file, context lines and `--`, `-digits-` file names, split/merge rules, plain-text windows, segment limits |
| `decide.test.ts` | Request shape; the decision order (error, missing answers, `keep_whole`, strong/weak `whole`, chunks, `none`); `citedFiles` |
| `distill.test.ts` | Skips, edits, `removed`, `not-worth`, failures, time budget, parent abort, concurrency limit, multi-segment outputs, `keepCitedFiles`, usage sums |
| `render.test.ts` | Labels, verbatim chunks with omission lines, `read` offsets, file lists, full removal |
| `cache-pin.test.ts` | API-key and OAuth payloads, trailing system messages, TTL copy, string content, tool-result-only messages, over-budget restore |
| `stats.test.ts` | Savings from the projection, run records, status texts and colours, cost format |
| `recall.test.ts` | Original output, pattern, offset/limit, line and byte caps |
| `config.test.ts` | Defaults, validation and ranges, `provider/id` parsing, load/save round trip |
| `extension.test.ts` | The real entry point (see below) |

`extension.test.ts` loads `src/index.ts` through **Pi's own extension loader** (`loadExtensions` from the
`@earendil-works/pi-coding-agent` devDependency), then drives the handlers with a fake `ctx`. It sets
`PI_CODING_AGENT_DIR` to a temporary directory, so `/guard on|off` never touches the real
`~/.pi/agent/context-guard.json`. It checks that the handlers, tool and command are registered, that drafts
are appended after other extensions' drafts, that unfinished runs and a missing model are ignored, that the
pin applies only to `anthropic-messages`, that `recall` works, and that `/guard off|on` persists.

Test through Pi's loader (or `pi -e`), not a plain Node import of the extension. Plain Node imports of
`@earendil-works/pi-coding-agent` can fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`, even though Pi loads the
same code without problems.

## Live end-to-end test

This uses a real Pi, a real main model and real Jev requests. **It costs money or subscription quota**: a few
main-model requests per turn, plus a few Jev requests (under $0.001 per distilled run).

```bash
node test/e2e/run-e2e.mjs --model <provider/id> [--ext <path>]... [--scenario badge|long] \
  [--config '<JSON>'] [--no-guard] [--turns N] [--thinking level]
```

| Option | Default | Meaning |
|---|---|---|
| `--model` | (required) | Main model, e.g. `openai-codex/gpt-6-luna` or `anthropic/claude-sonnet-5-5` |
| `--ext` | none | Extra extension to load; can be repeated (e.g. an auth extension) |
| `--scenario` | `badge` | `badge`: 3 turns about `StatusBadge` usages. `long`: 2 turns with 10+ sequential tool calls, for the cache pin. |
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
| long: turn 1 produced context edits / 10+ tool calls / 10+ model requests | The long scenario really was long and sequential |
| anthropic requests stay within 4 breakpoints | For `anthropic/…` models: the pin never exceeds the limit |

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
node test/e2e/run-e2e.mjs --model anthropic/claude-sonnet-5-5 --ext ~/.pi/agent/npm/node_modules/pi-claude-auth --scenario long
node test/e2e/run-e2e.mjs --model anthropic/claude-sonnet-5-5 --ext ~/.pi/agent/npm/node_modules/pi-claude-auth --scenario long --config '{"pinAnthropicCache":false}'
node test/e2e/run-e2e.mjs --model openai-codex/gpt-6-luna
node test/e2e/run-e2e.mjs --model openai-codex/gpt-6-luna --no-guard
```

### Results so far (Pi 1.0.3)

| Run | Result |
|---|---|
| GPT-6 Luna, badge | 36,113 → 1,501 chars, 2 Jev requests, 550 ms, $0.00083; turn 3 used `recall` with a regex; 9/9 checks pass |
| Claude Sonnet 5.5, badge | 36,113 → 3,066 chars, 2 Jev requests, 1.18 s, $0.00084; turn 2 cacheRead 5,777 / cacheWrite 2,036; turn 3 used `recall`; 10/10 checks pass |
| Claude Sonnet 5.5, long, with / without pin | first request after the run: cacheRead 5,810 / 1,693, cacheWrite 8,913 / 13,068 |
| GPT-6 Luna, badge, with / without guard | turn 2 cacheRead 2,560 / 13,824 |

See [CACHE.md](CACHE.md) for what the cache numbers mean.

## Manual TUI check (tmux)

This checks the status bar, the working message and `/guard` in the real interactive UI.

Start a **fresh** tmux server with its own socket (`-L`) from the shell that has your credentials and network
settings. An existing tmux server keeps the environment it was started with.

```bash
REPO=~/projects/pi/pi-context-guard-jev
node $REPO/test/e2e/make-fixture.mjs /tmp/cg-fixture
echo '{}' > /tmp/cg-fixture.json        # keeps /guard on|off away from your real settings

tmux -L cg new-session -d -s cg -x 200 -y 50
tmux -L cg send-keys -t cg "cd /tmp/cg-fixture && PI_CONTEXT_GUARD_CONFIG=/tmp/cg-fixture.json pi -e $REPO/src/index.ts" Enter
# add  -e ~/.pi/agent/npm/node_modules/pi-claude-auth  for a Claude subscription
tmux -L cg capture-pane -p -t cg | tail -5     # footer: 🛡 0 saved

tmux -L cg send-keys -t cg "Which parts of this codebase use the StatusBadge UI component? Start with rg -n -i status." Enter
tmux -L cg capture-pane -p -t cg | tail -5     # while Jev runs: 🛡 distilling…
tmux -L cg capture-pane -p -t cg | tail -5     # afterwards: 🛡 −4.2k tok · 1 distilled (numbers vary)

tmux -L cg send-keys -t cg "/guard" Enter
tmux -L cg capture-pane -p -t cg -S -40        # model, savings, Jev runs/requests/cost, per-result traces

tmux -L cg kill-server
```

Expected, as observed: the footer goes from `🛡 0 saved` to `🛡 distilling…` to
`🛡 −4.2k tok · 1 distilled`. Pi's own context meter drops (33k to 17k in the observed run). `/guard` lists the
last run's results with traces such as `kw.15 focus=chunk_4:.52 keep 9/29`. Also try `/guard off` (footer
`🛡 guard off`) and `/tree` back to before the run (savings go back to `0 saved`).
