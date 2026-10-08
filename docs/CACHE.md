# Prompt-cache impact

**Summary.** An edit changes the context from the first distilled tool result onwards. The next prompt
therefore has a one-time partial cache miss: everything before the edited result can still be read from the
cache, and everything after it is written again. After that, each request carries the smaller, distilled
history. On Anthropic models, a long run can push the reusable cache entry out of reach. The extension adds
one cache breakpoint to prevent that (measured below). On OpenAI, caching is automatic. Pi's Codex transport
also loses its delta continuation once after an edit.

Pi facts were checked in the Pi 1.0.3 source (`@earendil-works/pi-ai/dist/api/anthropic-messages.js`,
`openai-codex-responses.js`). Provider facts come from the primary docs, read on 2026-10-06 (see
[Sources](#sources)). Numbers marked *measured* come from the live tests in [TESTING.md](TESTING.md). Single
runs, not averages.

## Anthropic

### What Anthropic does (documented)

- At most **4** cache breakpoints per request.
- For each breakpoint, the lookup goes back **at most 20 positions** to find an earlier cache entry.
  Consecutive `tool_use` blocks count as one position, and so do consecutive `tool_result` blocks.
- Entries with a longer TTL must come before entries with a shorter TTL.
- Reading an entry refreshes its TTL. The docs do **not** say that reading a longer prefix refreshes a
  shorter entry that was written separately; measured below, it does
  ([Mid-run checkpoints](#mid-run-checkpoints)).
- Pricing relative to base input: 5-minute write 1.25×, 1-hour write 2×, read 0.1× (0.05× on Opus 5.5).
- The minimum cacheable prompt is 512 tokens on Sonnet/Opus 5.5.

### Where Pi puts breakpoints

| Breakpoint | Where |
|---|---|
| tools | the last tool definition |
| system | the system prompt block |
| messages | rolling: the last user or system message only |

With an API key that makes 3 breakpoints. With Anthropic OAuth, Pi also adds a `"You are Claude Code…"`
identity block as `system[0]`, with its own breakpoint, which makes 4. With `PI_CACHE_RETENTION=long`, all
breakpoints get `ttl: "1h"` where the model supports it.

The `pi-claude-auth` extension, used for the Claude subscription tests, rewrites the payload differently.
It moves the system prompt into the first user message and adds a billing block that is not cached. The
measured requests never had more than 4 breakpoints.

### The problem

The first request of a run has the question as its last message, so it writes a cache entry ending at the
question. After the run is distilled, the next prompt's prefix matches up to the first edited result, which
includes the question. But that entry was written by the run's first request, and the rolling breakpoint is
now at the end of the conversation. If the run had more than about 20 positions between the question and the
end (a dozen sequential tool calls is enough), the lookback never reaches the question's entry. Only tools and
system are read, and the whole history is written again.

### The fix, as implemented (`src/cache-pin.ts`)

In `before_provider_request`, for models with `api === "anthropic-messages"` (when `enabled` and
`pinAnthropicCache` are on):

1. Find Pi's rolling `cache_control` (the last one in `messages`). Without one, caching is off: do nothing.
2. Skip trailing mid-conversation `system` messages (effort or tool changes). Then find the most recent user
   message with text that is **not** the last message. Tool-result-only user messages do not count. This is
   the run's question during a run, and the previous question on the first request of a new prompt.
3. Put a `cache_control` on that message's last text block (string content is converted to one text block
   first). If it already has one, leave it. The TTL must keep Anthropic's order (every breakpoint before it
   at least as long, every one after it no longer): the rolling breakpoint's TTL is used when that holds,
   otherwise the other TTL; if neither fits, nothing is pinned (`ttl-conflict`). Pi itself always uses one
   TTL for every breakpoint, so in practice the pin copies it.
4. If that makes more than 4 breakpoints, remove the breakpoint from `system[0]` (the OAuth identity block).
   The `system[1]` breakpoint covers that prefix too.
5. If it is still more than 4, undo everything and leave the payload as Pi built it.

During a run, every request reads the question's entry directly, so the entry stays refreshed and the lookback
limit does not matter. Moving a breakpoint does not change the cached content, so existing entries stay
valid. The pin is added on every Anthropic request, whether or not anything was distilled.

### Measured

Claude Sonnet 5.5 via `pi-claude-auth`, Pi 1.0.3:

| Case | First request after the distilled run |
|---|---|
| Short run (badge scenario), with pin | cacheRead 5,777, cacheWrite 2,036 |
| Long run (11 sequential tool calls, 36,113 → ~3.3k chars), **with pin** | cacheRead **5,810**, cacheWrite **8,913** |
| Same long run, **without pin** (`pinAnthropicCache: false`) | cacheRead **1,693** (tools + system only), cacheWrite **13,068** |

Without the pin, the 20-position lookback missed the question's entry. With the pin, it was hit. No request
had more than 4 breakpoints.

## OpenAI

### What OpenAI does (documented)

- Caching is automatic, with no breakpoints. The whole rendered prefix must match. A change prevents reuse
  from that point on.
- GPT-5.6 and later: 1,024-token minimum, about 30 minutes retention, reads cost about 0.1×.

### Pi's Codex transport

Over WebSocket, Pi's `openai-codex` transport sends only the new input items with `previous_response_id`, as
long as the input only grows. After an edit, the input is no longer an extension of the previous one, so
Pi sends the full input. The server-side continuation is lost for that request, and in every measurement the
cache read was at most the 2,560-token stable prefix, **wherever the first edited item was** (also when it
was 18 turns into a run; see [Mid-run checkpoints](#mid-run-checkpoints)). This happens once, on the first
request after the edit.

### Measured

GPT-6 Luna (openai-codex), badge scenario, turn 2 first request:

| Case | cacheRead |
|---|---|
| Without the guard (control) | 13,824 |
| With the guard | 2,560 (only the stable prefix before the first edited item) |
| With the guard, one earlier run | 0 |

The pin does not apply to OpenAI.

## Mid-run checkpoints

A checkpoint edits outputs from earlier in the *current* run, so the next request cannot read the run from
cache beyond the first edited output. Two questions decide the design: does a cache entry at the
unchanged prefix still exist when the checkpoint comes, possibly many minutes after it was written; and
how much does the one-time rewrite cost against the per-request saving.

### Do cache entries on the read path stay alive? (measured)

`node test/e2e/ttl-probe.mjs` (Claude Sonnet 5.5, `pi-claude-auth`). The model `cat`s a ~31k-token file
(entry A ends at that result, written once as Pi's rolling breakpoint), then makes further requests; at the
end, the request after A is changed so that only A can be read.

| Arm | Between writing A and the test request | Test request |
|---|---|---|
| refresh | 8 requests in 7.6 min, each marking A (5m) and reading the longer prefix | cacheRead **31,001** (A alive) |
| control | the same 8 requests, A **not** marked again | cacheRead **30,999** (A alive) |
| ttl1h | as refresh, A at `ttl: "1h"` | cacheRead 31,001; but switching the earlier breakpoints to 1h was itself a full miss (cacheRead 0 → 31,001 written at the 1h price) |
| idle (5m) | **no request for 362 s** (Pi's cache warming stopped) | cacheRead **1,431**, cacheWrite 29,633 (A expired) |
| idle1h | no request for 365 s, A at 1h | cacheRead 30,977 (A alive) |

So the 5-minute TTL is real (idle), but **every request that reads a longer prefix keeps the shorter entries
on its path alive** (control). During an active run (requests seconds apart, and Pi's own cache warming,
setting `cacheWarming: "streaming"` by default, during long tool calls), every turn boundary that was once
the rolling breakpoint stays readable. A 1-hour TTL is not needed and would cost a full rewrite at 2× once.
The extension therefore keeps Pi's TTL (5m by default). Pi's warming requests go through
`before_provider_request` (seen in the capture), so they carry the extension's breakpoints too.

What the lookback limit still breaks: the request after an edit has its rolling breakpoint at the end; the
first edited output is usually many more than 20 positions back. So every Anthropic request keeps the
previous-question pin (the floor: system prompt and question; with `pi-claude-auth`, the relocated system
prompt sits in that same user message), and the first request after any edits (checkpoint, run end, or
another extension; the `context_edit` entries after the last answered assistant message) gets two more
breakpoints (`cacheAnchors` in `src/checkpoint.ts`):

- a **read point**, only at a cache entry this process saw itself write: a `tool_result` block that carried
  a breakpoint in a request it sent, to the same model, still on the branch, and with no `context_edit` at
  or before it and no compaction or branch summary since, written or read through within the last 5
  minutes. A response refreshes an entry when its `cacheRead` shows the request read clearly past it: at
  least the run's baseline (the full input of the run's first request) plus the characters from the
  question to the entry divided by 1.5, which overestimates the tokens (code ≈ 2.3 characters per token).
  This follows the control arm above. The latest trusted entry before the first edited entry is used. The
  log lives in memory and is empty after a reload, so a read point is never inferred;
- a **write anchor** at the end of the first edited tool-result batch, so the edited prefix gets an entry
  that the next checkpoint can read. It enters the log only if it was really in the request.

Budget: Pi uses 3 (API key: tools, system, rolling) or 4 breakpoints (OAuth: plus the identity
`system[0]`; `pi-claude-auth`: tools, `system[1]`, question, rolling). To make room, the identity breakpoint
(covered by `system[1]`) and then the tools breakpoint (covered by the system breakpoint) are dropped. If
that is not enough, the write anchor goes first, then the read point; the question stays. Marks use the
rolling breakpoint's TTL and are skipped if they would break the TTL order. Only breakpoints actually left in
the payload are logged, so an anchor dropped for the budget is never treated as written.

### The first request after a checkpoint (measured)

Claude Sonnet 5.5, long scenario with settings that force checkpoints into a short run
(`midRunBreakEven: false`, `midRunMinAgeTurns: 2`, `midRunBatchChars: 20000`), with `pi-claude-auth` and
`test/e2e/plain-test-runs.ts`:

| Configuration | Checkpoint | First edited output | Next request |
|---|---|---|---|
| default anchors | 1st (after request 3) | the run's first output | cacheRead **5,832** (system prompt + question, via the question pin), cacheWrite 10,867 |
| default anchors | 2nd (after request 8) | 3 turns into the run | cacheRead **16,699** (read at the entry written after the 1st checkpoint), cacheWrite 22,778 |
| default anchors | 3rd (after request 10) | 5 turns into the run | cacheRead **16,699**, cacheWrite 20,008 |
| `pinAnthropicCache: false` | 1st | the run's first output | cacheRead 5,832, cacheWrite 29,570 |
| `pinAnthropicCache: false` | 2nd, 3rd, 4th | 2–6 turns into the run | cacheRead **5,832** each time, cacheWrite 41,162 / 32,183 / 33,872 |

Without the guard's breakpoints, every request after a checkpoint read only the system-and-question entry
and rewrote the whole run. With them, the later checkpoints read up to the entry written by the first
request after the first checkpoint. The first checkpoint of a run usually edits the run's first output, so
only the system prompt and question can be read then. When a read point is placed, the write anchor often
does not fit the budget (question, read point, `system[1]` and rolling take all four slots).

GPT-6 Luna (openai-codex), long scenario, 8 checkpoints in 5 runs (default batch and age settings), at
requests 13–30: the first request after every checkpoint read **2,560 or 0** tokens from cache (17k–29k
uncached), against 35k–72k read on the request before it. That is the transport, not the position of the
edit.

### Economics and the break-even rule

At the prices in these runs (Sonnet 5.5: input $2/M, 5m write $2.5/M, read $0.2/M; GPT-6 Luna: input
$0.10/M, cached $0.01/M), a checkpoint costs once, and saves on every later request:

- OpenAI Codex: the whole context is sent uncached once: extra ≈ 0.9 × context × input price.
- Anthropic: everything after the read point is written again: extra ≈ (1.25 − 0.1) × rewritten tokens.
- Saving per later request: the removed tokens × the cache-read price. Jev removed 60–90% of checkpoint
  outputs in the runs.

Measured (GPT, a run with two checkpoints): checkpoint 1 removed 57k characters; the next request was 17,144 tokens uncached
(≈ $0.0015 extra) and every later request carried about 19k tokens less (≈ $0.0002 saved each): break-even
after about 8 requests, and the run went on for 12 more. Checkpoint 2 needed about 9 requests and the run
ended 2 requests later. On Anthropic the ratio of write to read price is larger (12.5:1 vs 10:1).

So checkpoints pay for themselves only when the run goes on for roughly 8–30 more requests. The
**break-even rule** (`midRunBreakEven`, on) skips a checkpoint unless
`pending chars × turns so far ≥ factor × rewrite chars` (OpenAI: factor 13, rewrite = whole context;
Anthropic: factor 16, rewrite = context after the read point the next request would get, or after the
question when no logged entry is trusted, or the whole context with pinning off; other providers: factor
16, rewrite = context from the first eligible output), assuming the run goes on
about as long as it has run so far. Context size is measured in text characters (`src/size.ts`): an image
counts as about 3 characters per token (Anthropic: width × height / 750 tokens), not its base64 length, and a
thinking signature counts at half its length. Counting the base64 once blocked every checkpoint in a long
Claude run with screenshots (rewrite estimated at 2–22M characters for a 150–370k-token context).
In the measured Claude runs (8–14 requests) it never allowed a
checkpoint; in the GPT runs (26–37 requests) it allowed one or two. Turn it off to checkpoint purely for
context room.

## Old exchanges

An omitted exchange comes before the current question, so the first request after it cannot read the
question's cache entry: that prefix contains the edit. `cacheAnchors` handles this like any other edit: the
read point is the latest trusted logged entry before the earliest edited entry, and the question pin is
still placed (it writes a new entry for the requests that follow). Without such an entry, only the tools and
system prompt are read. The break-even estimate (`anthropicRewriteChars`) follows the same rule: with an edit
at or before the question and no trusted read point, the rewrite is the whole context.

Measured (`topics` scenario, Claude Sonnet 5.5, first request of prompt 5 after the first exchange was
omitted at the end of prompt 4 with `exchangeBreakEven: false`): cacheRead 1,760 (tools and system),
cacheWrite 6,280, against cacheRead 12,376 and cacheWrite 438 with the guard off. With the default gate the
omission was deferred and prompt 5 read 11,049 tokens from cache. On OpenAI Codex any edit makes the next
request read at most the 2,560-token stable prefix (see above).

So each omission costs one rewrite of everything after the omitted exchange on the next request (Pi's
default `cacheWarming: "streaming"` keeps the cache warm between prompts that come within the TTL) and saves
the exchange on every request after it. At run end, omissions therefore go through a break-even gate
(`exchangeBreakEven`): their marginal rewrite (beyond what the pass's other edits rewrite anyway) must pay
off over as many later requests as the session has had so far, and they must save at least
`exchangeMinSavingChars` (8,000 characters); otherwise they wait and accumulate. On OpenAI Codex a pass that
edits anything else already costs the whole context, so exchange omissions in that pass are free. Mid-run, exchanges join the checkpoint batch only when the batch with them pays off; their early
position makes the rewrite most of the context, so with factor 16 the batch must reach about
1/16 of the context per turn so far (for example, old exchanges that are half of the context pay off from
about turn 32).

## Cost model

All units are input-token equivalents, with a 5-minute TTL (write 1.25×, read 0.1×).

**Measured, long Claude run, first request after the run:**

| | Read | Write | Cost |
|---|---|---|---|
| With pin | 5,810 × 0.1 | 8,913 × 1.25 | **≈ 11.7k** |
| Without pin | 1,693 × 0.1 | 13,068 × 1.25 | **≈ 16.5k** |

The prompt was the same size in both cases, about 14.7k tokens. The pin moved about 4.1k tokens from write to
read and made that request about 29% cheaper.

**Assumed sizes, to show the trade-off.** System prompt and tools 15k tokens, earlier history 30k, the run's
tool output 60k distilled to 5k:

| Next prompt | Cost |
|---|---|
| Not distilled (full cache hit) | read 105k × 0.1 → **≈ 10.5k** |
| Distilled, question entry hit (pin) | read 45k × 0.1 + write 5k × 1.25 → **≈ 10.8k**; every later request then saves about 5.5k |
| Distilled, only tools and system hit (no pin, long run) | read 15k × 0.1 + write 35k × 1.25 → **≈ 45k** one time; pays back after about 6 requests |

Notes:

- If the user waits longer than the cache TTL before the next prompt, everything is cold anyway, and the
  edit costs nothing extra.
- Jev requests do not touch the main model's cache. They cost about $0.0008 per qualifying run (measured).
- On OpenAI, the one-time cost is the difference between 13,824 and 2,560 cached tokens on one request
  (measured above), against a smaller context on every later request.

## Sources

- Anthropic, prompt caching: <https://docs.claude.com/en/docs/build-with-claude/prompt-caching>
- OpenAI, prompt caching: <https://developers.openai.com/api/docs/guides/prompt-caching>
