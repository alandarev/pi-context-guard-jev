# Threshold replay on real sessions

November 2026. Tools: [`test/analysis/jev-replay.ts`](../test/analysis/jev-replay.ts) (replay with a
response cache) and [`test/analysis/replay-regret.py`](../test/analysis/replay-regret.py) (savings and
proxy regret).

## Setup

- **64 sessions** from 12 days in which Jev was unavailable (the guard edited nothing, so the agent always
  saw full outputs and its later behaviour is unbiased). They were picked at random, stratified by provider
  (Anthropic, OpenAI Codex), length (40–1,161 requests) and main session vs subagent. About 16k
  main-model requests in total.
- The guard's records and edits were stripped, and each session was replayed at every turn boundary with
  the real gates (mid-run checkpoints and run ends). Every Jev answer was cached, so each threshold set
  below was re-evaluated offline for free.
- **Jev cost: $1.98** for 6,448 requests. The 12 sweeps cost nothing more (requests that a different
  threshold made new, at most 3% of a sweep, count as "keep").

## Proxy for regret

There is no ground truth for "the agent would have needed the removed lines". The proxy uses the
agent's own later behaviour in these unedited sessions:

- the distinctive tokens of an output (paths, identifiers with digits, underscores or camelCase, hashes,
  numbers ≥ 6 characters) that first appeared in the session in that output,
- of which the agent later **wrote** one (in its text or tool-call arguments) before any other output
  brought it in again.

The **use rate** is the share of such tokens the agent later wrote. If Jev removed at random, the removed
part would have the same use rate as the kept part; if it removed only what is never used again, the
removed part's rate would be 0.

## Results

Saved = estimated token × request product (tokens kept out times the requests that carry the smaller
context). Use rates are later-use rates of the distinctive tokens in the removed vs kept part.

| Setting | Saved | Large outputs removed | Use rate removed / kept (large) | Small removed | Use rate removed / kept (small) | Exchanges omitted |
|---|---|---|---|---|---|---|
| **defaults** | 728M | 2,038 / 2,787 | 1.95% / 2.48% | 3,045 / 5,537 | 1.65% / 1.78% | 34 / 207 |
| `chunkKeepThreshold` 0.4 | 397M | 1,052 | 1.50% / 2.49% | | | |
| `chunkKeepThreshold` 0.5 | 569M | 1,623 | 1.81% / 2.51% | | | |
| `chunkKeepThreshold` 0.7 | 809M | 2,237 | 2.04% / 2.37% | | | |
| `keepWholeThreshold` 0.8–0.9 | 729M | +6 | same | | | |
| `maxKeepRatio` 0.8 | 746M | 2,275 | 1.98% / 2.42% | | | |
| `noneThreshold` 0.35 | 733M | 2,040 | 1.96% / 2.47% | | | |
| `smallKeepThreshold` 0.3 | 664M | | | 1,283 | 1.44% / 2.05% | |
| `smallKeepThreshold` 0.6 | 752M | | | 3,417 | 1.83% / 2.16% | |
| `exchangeOmitThreshold` 0.35 | 790M | | | | | 74 (use rate 1.12% vs kept 2.01%) |
| `exchangeOmitThreshold` 0.5 | 934M | | | | | 124 (use rate 1.36% vs kept 1.85%) |

A stricter token filter (paths and identifiers only) gave the same picture (large: 1.55% vs 2.16%).

## Conclusions

1. **Jev's removals are better than random but not sharp.** In the removed part of large outputs the
   agent later used 20–25% fewer of the distinctive tokens than in the kept part. For small outputs the
   difference is small (1.65% vs 1.78%). Most of the saving comes from the bulk of tool output that
   nobody reads again, not from a fine selection.
2. **The chunk thresholds are near a sensible point.** Raising `chunkKeepThreshold` to 0.7 saves 11% more,
   and the removed and kept parts become almost equally useful (2.04% vs 2.37%). Lowering it to 0.4 halves
   the saving. Default kept at 0.6.
3. **`keepWholeThreshold`, `focusWholeThreshold` and `noneThreshold` hardly matter** (±1%).
4. **Exchange omission was too cautious.** At P < 0.2 only 34 of 207 old exchanges were omitted. At 0.35,
   74 were omitted (+8% total saving), and omitted exchanges still had about half the later-use rate of
   kept ones. **Default changed to 0.35.** At 0.5 the gap closes faster (1.36% vs 1.85%), which suggests
   more real regret.
5. **The real regret signal in production is low.** During three weeks of normal use with Jev working, the
   model called `recall` for 4.0% of distilled large outputs and 1.9% of small ones.
   The proxy above counts any later mention, including ones the agent could get elsewhere, so it
   overstates the need.

## Limitations

- One user's sessions, two providers.
- The proxy only sees distinctive tokens; plain-prose needs are invisible to it.
- Edits are not applied during the replay, so later passes see full outputs; in real use, outputs removed
  at a checkpoint are not judged again at run end.
