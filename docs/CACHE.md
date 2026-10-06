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
  shorter entry that was written separately.
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

1. Find Pi's rolling `cache_control` (the last one in `messages`) and copy it, including `ttl`, so TTL
   ordering stays valid. Without one, do nothing.
2. Skip trailing mid-conversation `system` messages (effort or tool changes). Then find the most recent user
   message with text that is **not** the last message. Tool-result-only user messages do not count. This is
   the run's question during a run, and the previous question on the first request of a new prompt.
3. Put the copied `cache_control` on that message's last text block (string content is converted to one
   text block first). If it already has one, leave it.
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
Pi sends the full input. The server-side continuation is lost for that request, and the prompt cache is reused
only up to the first edited item. This happens once, on the first request after the edit.

### Measured

GPT-6 Luna (openai-codex), badge scenario, turn 2 first request:

| Case | cacheRead |
|---|---|
| Without the guard (control) | 13,824 |
| With the guard | 2,560 (only the stable prefix before the first edited item) |
| With the guard, one earlier run | 0 |

The pin does not apply to OpenAI.

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
