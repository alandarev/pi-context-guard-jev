# pi-context-guard-jev

**Status: design notes plus a draft.** Checked so far:

- `src/index.ts` loads through Pi's `loadExtensions` with no errors and registers
  `agent_before_settle`, `before_provider_request`, the `recall` tool and the `/guard` command.
- The question-breakpoint pin works on a synthetic OAuth-shaped payload: the question
  gets a breakpoint, `system[0]` loses its breakpoint, and the total stays at 4.
- The pruner has **never run in a real session**, and the decision prompt is untuned.

A Pi extension that tidies the context window after each agent run. When a run has
pulled in a lot of tool output (grep/read/bash dumps while answering e.g.
*"what pieces of the system use UI element X"*), a cheap decision model reduces each
tool result to the lines that support the answer. Pi's append-only `context_edit`
entries then replace the raw dumps, so later turns carry the answer plus its evidence
instead of everything that was searched. The raw output stays in the session file.

## Layout

| Path | Content |
|---|---|
| `docs/DESIGN.md` | Goal, Pi mechanisms used, algorithm, pitfalls, open questions, verification plan |
| `docs/CACHE.md` | Effect on Anthropic prompt caching, cost model, the question-breakpoint fix |
| `src/index.ts` | **Untested draft**: the pruner (`agent_before_settle`), question-breakpoint pin (`before_provider_request`), `/guard` toggle |
| `package.json` | Pi package manifest (host packages as `peerDependencies`) |

## Try the draft (once reviewed)

```bash
pi -e ~/projects/pi/pi-context-guard-jev/src/index.ts
```

Test through Pi's own loader (`pi -e`), not a plain `node` import. Plain Node imports of
`@earendil-works/pi-coding-agent` can fail with `ERR_PACKAGE_PATH_NOT_EXPORTED` even
though Pi loads the same code without problems.

## Next steps

1. Review `src/index.ts` against `docs/DESIGN.md` → *Open questions*.
2. Add the `recall(entryId)` tool so the main model can recover a pruned result.
3. Run a grep-heavy prompt and inspect the session `.jsonl` for `context_edit` entries.
4. Check the cache numbers on the next prompt (`docs/CACHE.md` → *Verify*).
5. Move the settings in `CONFIG` into Pi settings or flags.

## Reference

Written against **Pi 1.0.3**
(`~/.asdf/installs/nodejs/25.9.0/lib/node_modules/@earendil-works/pi-coding-agent`).
Pi file references in the docs are relative to that install.
