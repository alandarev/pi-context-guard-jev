# pi-context-guard-jev

A [Pi](https://github.com/earendil-works/pi) extension that removes tool output your agent no longer needs
from its context. The Jev classifier decides which lines to keep. Kept lines are copied verbatim, and the
model can `recall` anything that was removed.

![A 496-line search is distilled after the run; the footer shows about 10.1k tokens kept out of context](https://raw.githubusercontent.com/alandarev/pi-context-guard-jev/master/assets/screenshot.png)

## Install

```bash
pi install npm:pi-context-guard-jev
```

Requires Pi ≥ 1.0.3 and an OpenRouter credential (`OPENROUTER_API_KEY` or `/login`). Once it is ready, the
footer shows `🛡 0 saved`.

## What it removes

| Item | Rule | The model then sees |
|---|---|---|
| Large tool output (≥ 4k chars) | Jev keeps the chunks the work still needs | The kept lines, verbatim, and one line per removed stretch |
| Small tool output (400–4k chars) | Jev: is it still needed? | A one-line note |
| Earlier exchange about another task | Jev: is it still relevant? | A one-line note on its prompt |
| Image in a tool result | After 3 turns (no Jev call) | The result's text and a one-line note |

The extension runs when a run finishes. In long runs it also runs mid-run, once enough old output has piled
up. An edit makes the next request rewrite part of the prompt cache, so mid-run edits and edits to earlier
exchanges wait until the smaller context pays for that. It leaves alone images you send, results of `edit`
and `write`, and the last two exchanges before your current prompt.

## Example

The agent ran `rg -n -i compact dist docs` (50 KB) to find where Pi decides to auto-compact. After the
run, the output that later requests carry starts like this:

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
…
```

With the matches it kept, the model then answered which compaction settings a user can change and their
defaults correctly, without `recall`.

Small outputs, old exchanges and images leave one line each:

```text
[context-guard] Omitted the output of bash `npm test` (1.2k chars): judged no longer needed. Full output: recall({"entryId":"…"}).
[context-guard] Omitted an earlier exchange judged unrelated to the current work: "which API clients retry on 503?" (6 messages, ~2.2k tokens). Full exchange: recall({"entryId":"…"}).
[context-guard] Removed 1 image from this output (1280×960; ~1.6k tokens), 4 turns old. recall({"entryId":"…"}) shows it again.
```

## Results

Context size of the next request, with the guard on and off:

| Task | Model | On | Off |
|---|---|---|---|
| Code search (50 KB `rg`), then a follow-up question | Claude Sonnet 5.5 | 15.5k | 28.2k |
| The same | GPT-6 Luna | 11.5k | 34.3k |
| Reading a 164 KB file, then a question about a detail | GPT-6 Luna | 9.2k | 35.3k |
| Failing test log, then "now fix it" | GPT-6 Luna | 5.7k | 7.5k |
| Autonomous run fixing 10 bugs (peak over the run) | GPT-6 Luna | 45k | 68–88k |
| Six screenshots, then a question about one of them | Claude Sonnet 5.5 | 9.4k | ~14.1k |

Every follow-up was answered correctly, and every task was finished. The screenshot row's "off" value is
the request before the images were removed. Jev costs $0.0003–0.007 and takes 0.6–2 s per pass. These are
single runs, not a benchmark. Details: [docs/RESULTS.md](docs/RESULTS.md).

## Use

It works on its own; there is nothing to call.

- **Footer:** `🛡 −4.2k · 3` means about 4.2k tokens are kept out of context right now, by 3 edits. After a
  compaction, `🛡 0 · Σ−79k` shows the total saved in the session.
- **`/guard`:** shows every decision of the last pass, with Jev's probabilities. `/guard off` and
  `/guard on` are saved for later sessions. `/guard reload` re-reads the settings.
- **`recall`:** the model calls it when it needs something removed: the whole original, lines that match a
  regex, or a line range. You can also ask for it ("recall the full test log").
- **Undo:** use `/tree` to go back to before an edit; the original is still in the session file.

## Configure

Optional. Put the settings in `~/.pi/agent/context-guard.json`:

```json
{
  "excludeTools": ["edit", "write", "bash"],
  "imageKeepTurns": 5,
  "historyExchanges": 0
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch (`/guard on` and `/guard off` write it) |
| `excludeTools` | `["edit", "write"]` | Tools whose output is never touched |
| `imageKeepTurns` | `3` | Remove images from tool results after this many turns; `0` turns this off |
| `pruneExchanges` | `true` | Omit earlier exchanges about other tasks |
| `midRun` | `true` | Also run during long runs, not only at the end |
| `historyExchanges` | `3` | Earlier exchanges sent to Jev as context; `0` sends none |
| `model` | `openrouter/~typesafe/jev-latest` | Classifier model |

All settings: [docs/REFERENCE.md](docs/REFERENCE.md#configuration).

## Privacy

Jev runs on OpenRouter and TypeSafe. Each pass sends them your prompt, the agent's answer or progress
notes, short excerpts of earlier messages, and the text of the tool outputs being judged. That text can
include source code and logs. Images, `edit` and `write` results, and outputs under 400 chars are never
sent. Turn the extension off with `/guard off`. The full list of what is sent:
[docs/REFERENCE.md](docs/REFERENCE.md#data-sent-to-jev).

## Trade-offs

- **The first request after an edit costs more.** The prompt cache has to be rewritten from the edit
  onward. In short sessions you gain context room, not a lower bill.
- **Lossy by design.** A follow-up that goes somewhere new may need `recall` (the model sees what was
  removed and how to get it back).
- **It adds 0.5–2 s** after a run, or mid-run while a checkpoint runs (at most 8 s).

## More

- [docs/REFERENCE.md](docs/REFERENCE.md): every setting, status, command and `recall` parameter
- [docs/RESULTS.md](docs/RESULTS.md): measured runs, including where it does not help
- [docs/DESIGN.md](docs/DESIGN.md): how it works
- [docs/CACHE.md](docs/CACHE.md): prompt-cache costs on Anthropic and OpenAI
- [docs/JEV.md](docs/JEV.md): the Jev questions and threshold choices
- [docs/TESTING.md](docs/TESTING.md): unit and live tests

MIT license.
