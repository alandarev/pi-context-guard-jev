# Prompt-cache impact (Anthropic)

**Pruning the run that just finished causes a one-time partial cache miss on the next
prompt. The system prompt and tools always stay cached. Pinning a breakpoint at the
user's question keeps the conversation history cached as well.**

Pi facts below were checked in the Pi 1.0.3 source. Anthropic facts are from Anthropic's
prompt-caching documentation as remembered on 2026-10-06. **Re-check them against the
current docs before relying on the numbers.**

## How the TTL works

- Default TTL is **5 minutes**, and it is **sliding**: each request that reads an entry
  refreshes it. A long run with a request at least every few minutes stays warm, so
  what matters is the gap between requests, not how long the run takes.
- With `PI_CACHE_RETENTION=long`, Pi sends `ttl: "1h"` where the model supports it.
  Writes then cost 2× base input instead of 1.25×.
- Pi's `cacheWarming` setting defaults to `"streaming"`
  (`dist/core/cache-warmer.js`). During a run it re-sends the **latest** request with
  `maxTokens: 1` at about 90% of the TTL, but only if the expected saving is at least $0.05.
  It keeps the *newest, unpruned* entry warm, not the shorter prefix pruning needs.
- Pricing relative to base input: cache read 0.1×, 5-minute write 1.25×, 1-hour write 2×.

## Where Pi puts cache breakpoints

From `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`:

| Breakpoint | Where |
|---|---|
| tools | last tool definition |
| system | the system prompt block; with **OAuth**, also the `"You are Claude Code…"` block, so 2 in total |
| messages | **last** user/tool-result message only (rolling) |

API key: 3 breakpoints. OAuth: 4, which is Anthropic's maximum.

## The problem

Pruning changes the context starting at the run's first tool result. The next request
can only reuse the prefix that ends at the user's question. The run's first request wrote
a cache entry exactly there, because the question was the last message then. Two things
can still stop the next request from reusing it:

1. **Lookback limit:** Anthropic checks only about 20 content blocks back from a breakpoint
   for an older entry. A run with 10+ tool calls puts the question further back than that,
   so the entry isn't found even while it's alive.
2. **Refresh is unclear:** later requests in the run read longer entries. It's undocumented
   whether that also refreshes the shorter entry at the question. If not, it expires after
   about 5 minutes of run time.

In both cases only the system prompt and tools hit the cache, and the conversation
history is written to the cache again.

## Cost model

Example sizes: system prompt + tools **S = 15k** tokens, earlier history **H = 30k**,
the run's tool output **60k** pruned to **5k**. Units are input-token equivalents.

| Next prompt | Cost |
|---|---|
| No pruning (cache hit) | read 105k × 0.1 → **~10.5k** |
| Pruned, question entry hit | read 45k × 0.1 + write 5k × 1.25 → **~10.8k** (about even; each later turn saves ~5.5k) |
| Pruned, only system prompt and tools hit | read 15k × 0.1 + write 35k × 1.25 → **~45k** (one-time; pays back in about 6 turns) |

- If the user waits longer than the TTL before the next prompt, everything is cold anyway,
  so pruning costs nothing extra.
- The decision model's own call uses `cacheRetention: "none"` and never touches the main
  model's cache.
- Pruning older runs later would invalidate everything after them, which is much more
  expensive. Only prune the run that just finished.
- Don't prune from a `context` hook: if its output varies between requests, every request
  misses the cache.

## Fix: pin a breakpoint at the question

In `before_provider_request`, add `cache_control: { type: "ephemeral" }` to the last
text block of the last user message that contains text. That is the question; tool results
are `tool_result` blocks. Skip it when the question is already the last message.

- Every request in the run then **reads that entry directly**. It stays refreshed and is
  found without relying on lookback.
- Stay within 4 breakpoints. With OAuth, remove `cache_control` from `system[0]`, the tiny
  Claude Code identity block: the breakpoint on `system[1]` covers that prefix too.
- Moving breakpoints doesn't change the cached content, so existing entries stay valid.
- If the run uses a 1-hour TTL, use the same `ttl` on the pinned breakpoint. Anthropic
  requires longer-TTL breakpoints to come before shorter ones.
- Unknown: whether cache-warming replays go through this hook (`DESIGN.md` → *Open questions*).

## Verify

Check `usage` on the **first assistant message after a pruned run**, in the session
`.jsonl` or `/session`:

| Result | `cacheRead` | `cacheWrite` |
|---|---|---|
| Hit at the question (expected with the pin) | ≈ S + H | ≈ pruned tail + new prompt |
| Miss (system prompt and tools only) | ≈ S | ≈ H + pruned tail + new prompt |

Compare one long run (>5 min, 10+ tool calls) with the pin and one without.
