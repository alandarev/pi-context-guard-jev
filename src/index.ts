/**
 * pi-context-guard-jev
 *
 * After a run completes, the Jev classifier (TypeSafe, via OpenRouter by default) decides which
 * parts of the run's large tool outputs the answer still needs. Pi's append-only `context_edit`
 * entries then replace each output with the kept chunks, verbatim. The raw output stays in the
 * session; the `recall` tool returns it. The footer shows how much context is being saved.
 *
 * During long runs, mid-run checkpoints judge older outputs at turn boundaries (turn_end), in
 * batches, with a checkpoint-specific Jev request (docs/DESIGN.md → Mid-run checkpoints).
 *
 * Also places Anthropic cache breakpoints (the previous user question, and after edits a read point
 * before the first edited output), so the distilled history still hits the prompt cache (docs/CACHE.md).
 */
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { markedToolResults, normalizeToolUseId, pinQuestionBreakpoint, placeGuardBreakpoints } from "./cache-pin.ts";
import {
	type CheckpointCandidate,
	collectCheckpoint,
	anthropicRewriteChars,
	BREAK_EVEN_FACTOR,
	CACHE_TTL_MS,
	cacheAnchors,
	exchangeMemo,
	charsFrom,
	contextChars,
	memoFromBranch,
	paysOff,
	pendingEdits,
	refreshOnReadThrough,
	runBaseline,
	type WrittenEntry,
} from "./checkpoint.ts";
import { buildCheckpointRequest } from "./decide.ts";
import { type GuardConfig, loadConfig, parseModelRef, saveConfigPatch } from "./config.ts";
import { omittedIdsFor, originalOutput, recallText } from "./recall.ts";
import { formatChars, MARKER, RECALL_TOOL } from "./render.ts";
import { collectExchanges, collectSmall, type ExchangeItem, type SmallItem, type WorkContext } from "./items.ts";
import { deferExchanges, exchangeOmissions, type ProcessOptions, type ProcessOutcome, processItems } from "./process.ts";
import { collectRun, findRunStart, type RunInfo } from "./run.ts";
import {
	CUSTOM_TYPE,
	type Colorize,
	computeStats,
	formatCost,
	formatStatus,
	formatTokens,
	type GuardStats,
	type RunRecordData,
	type StatusState,
} from "./stats.ts";
import type { ClassifierRequest, ClassifierResponse, ClassifyFn, CustomDraft, ProjectedEntryLike } from "./types.ts";

const STATUS_KEY = "context-guard";

export default function contextGuard(pi: ExtensionAPI) {
	// PI_CONTEXT_GUARD_CONFIG points at another settings file (tests, per-project setups).
	const configPath = process.env.PI_CONTEXT_GUARD_CONFIG || join(getAgentDir(), "context-guard.json");
	let config: GuardConfig = loadConfig(configPath).config;
	let busy = false;
	let problem: string | undefined;
	let warned = new Set<string>();
	// No checkpoint state is kept in memory: the memo and the read point are derived from the entries
	// persisted on the active branch at every boundary and request (checkpoint.ts).
	const branchOf = (ctx: ExtensionContext) => ctx.sessionManager.getBranch() as unknown as Parameters<typeof pendingEdits>[0];
	/**
	 * Cache entries this process wrote: the tool-result breakpoints it saw in the Anthropic requests it
	 * sent (after its own changes). The only source for read points; cleared on session start or reload,
	 * so anything uncertain falls back to the question pin.
	 */
	let written: WrittenEntry[] = [];
	const recordWritten = (branch: ReturnType<typeof branchOf>, payload: unknown, model: string, now: number) => {
		const leafId = branch.at(-1)?.id;
		if (!leafId) return;
		const byToolUseId = new Map<string, string>();
		for (const e of branch) {
			const id = e.message?.role === "toolResult" ? e.message.toolCallId : undefined;
			if (id && e.id) byToolUseId.set(normalizeToolUseId(id), e.id);
		}
		const fresh = written.filter((w) => now - w.time <= CACHE_TTL_MS);
		for (const toolUseId of markedToolResults(payload)) {
			const entryId = byToolUseId.get(toolUseId);
			if (entryId) fresh.push({ entryId, model, time: now, leafId });
		}
		written = fresh.slice(-200);
	};
	const modelKey = (ctx: ExtensionContext) => `${ctx.model?.provider}/${ctx.model?.id}`;
	/** The last Anthropic request this process saw, to match its response in message_end. */
	let lastRequest: { model: string; time: number } | undefined;

	const warnOnce = (ctx: ExtensionContext, key: string, message: string) => {
		if (warned.has(key)) return;
		warned.add(key);
		if (ctx.hasUI) ctx.ui.notify(`context-guard: ${message}`, "warning");
	};

	const stats = (ctx: ExtensionContext): GuardStats =>
		computeStats(
			ctx.sessionManager.buildSessionProjection().entries as unknown as ProjectedEntryLike[],
			ctx.sessionManager.getBranch() as unknown as { type?: string; customType?: string; data?: unknown }[],
		);

	const refreshStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const state: StatusState = !config.enabled ? "off" : busy ? "busy" : problem ? "problem" : "ready";
		const color: Colorize = (c, text) => ctx.ui.theme.fg(c, text);
		try {
			ctx.ui.setStatus(STATUS_KEY, formatStatus(stats(ctx), state, color, problem));
		} catch {
			// Status is cosmetic; never let it break a session event.
		}
	};

	/** Resolve the Jev model and a classify function, or record why it is unavailable. */
	const resolveClassifier = (ctx: ExtensionContext): ClassifyFn | undefined => {
		const ref = parseModelRef(config.model);
		const model = ref ? ctx.modelRegistry.findOfType("classifier", ref.provider, ref.id) : undefined;
		if (!model) {
			problem = "Jev model not found";
			warnOnce(ctx, "model", `classifier model "${config.model}" is not in Pi's catalog; distillation is paused.`);
			return undefined;
		}
		if (!ctx.modelRegistry.hasConfiguredAuth(model as never)) {
			problem = `no ${model.provider} key`;
			warnOnce(ctx, "auth", `no credentials for ${model.provider} (set OPENROUTER_API_KEY or /login); distillation is paused.`);
			return undefined;
		}
		problem = undefined;
		return (request: ClassifierRequest, signal: AbortSignal) =>
			ctx.modelRegistry.classify(model, request as never, {
				signal,
				timeoutMs: config.timeoutMs,
				maxRetries: 1,
			}) as Promise<ClassifierResponse>;
	};

	const reload = (ctx: ExtensionContext) => {
		const loaded = loadConfig(configPath);
		config = loaded.config;
		if (loaded.error) warnOnce(ctx, "config", loaded.error);
	};

	pi.on("session_start", async (_event, ctx) => {
		warned = new Set();
		busy = false;
		reload(ctx);
		written = [];
		if (config.enabled) resolveClassifier(ctx);
		refreshStatus(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => refreshStatus(ctx));
	pi.on("session_compact", async (_event, ctx) => refreshStatus(ctx));
	pi.on("agent_settled", async (_event, ctx) => refreshStatus(ctx));

	/** Process every kind of item with the busy status shown; undefined when distillation could not start. */
	const processWithStatus = async (
		ctx: ExtensionContext,
		run: RunInfo,
		small: SmallItem[],
		exchanges: ExchangeItem[],
		work: WorkContext,
		options: ProcessOptions,
	): Promise<ProcessOutcome | undefined> => {
		const classify = resolveClassifier(ctx);
		if (!classify) {
			refreshStatus(ctx);
			return undefined;
		}
		busy = true;
		refreshStatus(ctx);
		if (ctx.hasUI) ctx.ui.setWorkingMessage("context-guard: distilling old context with Jev…");
		try {
			return await processItems(run, small, exchanges, work, classify, options, ctx.signal);
		} catch (err) {
			warnOnce(ctx, "distill", `distillation failed: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		} finally {
			busy = false;
			if (ctx.hasUI) ctx.ui.setWorkingMessage();
			refreshStatus(ctx);
		}
	};

	const recordOf = (outcome: ProcessOutcome, phase: "mid-run" | "run-end"): CustomDraft => ({
		type: "custom",
		customType: CUSTOM_TYPE,
		data: {
			v: 1,
			phase,
			model: config.model,
			savedChars: outcome.savedChars,
			requests: outcome.requests,
			inputTokens: outcome.inputTokens,
			costUsd: outcome.costUsd,
			ms: outcome.ms,
			timedOut: outcome.timedOut,
			results: outcome.records.map(({ kind, entryId, tool, label, outcome, reason, beforeChars, afterChars, jev, omitted }) => ({
				kind,
				...(omitted ? { omitted } : {}),
				entryId,
				tool,
				label,
				outcome,
				reason,
				beforeChars,
				afterChars,
				jev,
			})),
		} satisfies RunRecordData,
	});

	/** Checkpoint batch size for the current main model (OpenAI Codex loses its whole cache on every edit). */
	const batchCharsFor = (ctx: ExtensionContext): number =>
		ctx.model?.provider === "openai-codex" ? config.midRunBatchCharsOpenAI : config.midRunBatchChars;

	/** Characters the next request would write to the cache again if `ids` (entry ids) were edited. */
	const rewriteCharsFor = (ctx: ExtensionContext, entries: ProjectedEntryLike[], ids: ReadonlySet<string>): number => {
		// OpenAI Codex: the whole context. Anthropic: everything after the read point it would get, or after
		// the question when every edit comes after it, else everything (with pinning off: everything).
		// Other providers: everything from the earliest edited entry.
		if (ctx.model?.provider === "openai-codex") return contextChars(entries);
		if (ctx.model?.api === "anthropic-messages") {
			return config.pinAnthropicCache ? anthropicRewriteChars(entries, branchOf(ctx), written, modelKey(ctx), Date.now(), ids) : contextChars(entries);
		}
		return charsFrom(entries, ids);
	};

	/**
	 * Run-end gate for exchange omissions (checkpoint.ts → paysOff). Their marginal cache cost is the
	 * rewrite with them minus the rewrite the pass's other edits cause anyway (on OpenAI Codex any edit
	 * already costs the whole context, so with other edits the omissions are free). When that is above
	 * zero, they must save at least `exchangeMinSavingChars` and pay off over as many later requests as
	 * the session has had so far.
	 */
	const exchangesPayOff = (ctx: ExtensionContext, entries: ProjectedEntryLike[], outcome: ProcessOutcome): boolean => {
		const { savedChars, ids } = exchangeOmissions(outcome);
		if (ids.size === 0) return true;
		const others = new Set(outcome.edits.map((e) => e.targetId).filter((id) => !ids.has(id)));
		const rewriteWith = rewriteCharsFor(ctx, entries, new Set([...others, ...ids]));
		const rewriteWithout = others.size > 0 ? rewriteCharsFor(ctx, entries, others) : 0;
		const marginal = rewriteWith - rewriteWithout;
		if (marginal <= 0) return true;
		if (savedChars < config.exchangeMinSavingChars) return false;
		const requests = entries.filter((e) => e.messages[0]?.role === "assistant").length;
		const factor = ctx.model?.provider === "openai-codex" ? BREAK_EVEN_FACTOR.full : BREAK_EVEN_FACTOR.prefix;
		return paysOff(savedChars, requests, marginal, factor);
	};

	pi.on("turn_end", async (event, ctx) => {
		if (!config.enabled || !config.midRun || event.outcome !== "completed") return;
		// The final turn of a run (no tool calls) is left to run-end distillation.
		const message = event.message as { role?: string; content?: unknown };
		if (message.role !== "assistant" || !Array.isArray(message.content) || !message.content.some((b: { type?: string }) => b?.type === "toolCall")) return;
		const entries = event.context.contextEntries as unknown as ProjectedEntryLike[];
		const branch = branchOf(ctx);
		const memo = memoFromBranch(branch, CUSTOM_TYPE);
		const info = collectCheckpoint(entries, config, memo);
		if (!info) return;
		const runStart = findRunStart(entries);
		const small = config.smallResultMinChars > 0 ? collectSmall(entries.slice(runStart + 1), config, memo, info.currentTurn - config.midRunMinAgeTurns) : [];
		let exchanges = config.pruneExchanges ? collectExchanges(entries, runStart, config.keepRecentExchanges, exchangeMemo(branch, CUSTOM_TYPE)) : [];
		const outputChars = info.pendingChars + small.reduce((n, item) => n + item.text.length, 0);
		const exchangeChars = exchanges.reduce((n, item) => n + item.chars, 0);
		if (outputChars + exchangeChars < batchCharsFor(ctx)) return;
		// Only checkpoint when the one-time cache rewrite is likely to pay off (checkpoint.ts → paysOff).
		// Old exchanges come early, so they move the rewrite start back; if the whole batch does not pay
		// off, try the tool outputs alone.
		if (config.midRunBreakEven) {
			const factor = ctx.model?.provider === "openai-codex" ? BREAK_EVEN_FACTOR.full : BREAK_EVEN_FACTOR.prefix;
			const outputIds = new Set([...info.candidates.map((c) => c.entryId), ...small.map((s) => s.entryId)]);
			const allIds = new Set([...outputIds, ...exchanges.map((e) => e.entryId)]);
			const turns = info.currentTurn + 1;
			if (!paysOff(outputChars + exchangeChars, turns, rewriteCharsFor(ctx, entries, allIds), factor)) {
				exchanges = [];
				if (outputChars < batchCharsFor(ctx) || !paysOff(outputChars, turns, rewriteCharsFor(ctx, entries, outputIds), factor)) return;
			}
		}

		const run: RunInfo = { question: info.question, answer: "", notes: info.notes, candidates: info.candidates, toolResults: 0, history: info.history };
		const work: WorkContext = { question: info.question, history: info.history, latest: info.latest, notes: info.notes };
		const outcome = await processWithStatus(ctx, run, small, exchanges, work, {
			...config,
			minRunChars: 0,
			chunkKeepThreshold: config.midRunChunkKeepThreshold,
			requestBuilder: (candidate, segment, segmentIndex, segmentCount, totalLines) =>
				buildCheckpointRequest(info, candidate as CheckpointCandidate, segment, segmentIndex, segmentCount, totalLines),
		});
		if (!outcome || outcome.requests === 0) return;

		if (outcome.timedOut) warnOnce(ctx, "timeout", `Jev did not finish within ${config.timeoutMs} ms; some items were left as they are.`);
		// The runner REPLACES the draft list with our return value: keep other extensions' drafts.
		// Never ask for `continue`: the run goes on by itself.
		// The memo only advances once Pi has committed this record to the branch.
		return { entries: [...event.entries, ...(outcome.edits as never[]), recordOf(outcome, "mid-run")] };
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!config.enabled || event.outcome !== "completed") return;
		const entries = event.context.contextEntries as unknown as ProjectedEntryLike[];
		// Outputs kept at a mid-run checkpoint are judged again, now with the final answer; distilled ones
		// carry the marker and are skipped by the candidate rules.
		const run = collectRun(entries, config);
		if (!run) return;
		const largeChars = run.candidates.reduce((sum, c) => sum + c.text.length, 0);
		if (largeChars < config.minRunChars) run.candidates = [];
		const runStart = findRunStart(entries);
		const small = config.smallResultMinChars > 0 ? collectSmall(entries.slice(runStart + 1), config, new Set()) : [];
		const exchanges = config.pruneExchanges ? collectExchanges(entries, runStart, config.keepRecentExchanges, exchangeMemo(branchOf(ctx), CUSTOM_TYPE)) : [];
		if (run.candidates.length === 0 && small.length === 0 && exchanges.length === 0) return;
		const work: WorkContext = { question: run.question, history: run.history ?? { exchanges: [] }, answer: run.answer };

		const outcome = await processWithStatus(ctx, run, small, exchanges, work, config);
		if (!outcome || outcome.requests === 0) return;
		if (config.exchangeBreakEven && !exchangesPayOff(ctx, entries, outcome)) deferExchanges(outcome);
		if (outcome.timedOut) warnOnce(ctx, "timeout", `Jev did not finish within ${config.timeoutMs} ms; some items were left as they are.`);
		// The runner REPLACES the draft list with our return value: keep other extensions' drafts.
		return { entries: [...event.entries, ...(outcome.edits as never[]), recordOf(outcome, "run-end")] };
	});

	// Refresh logged cache entries that the response shows were read through (checkpoint.ts →
	// refreshOnReadThrough). Without a clear hit beyond the system prompt and question, nothing changes.
	pi.on("message_end", async (event, ctx) => {
		const message = event.message as { role?: string; provider?: string; model?: string; usage?: { cacheRead?: number } };
		const request = lastRequest;
		if (message.role !== "assistant" || !request || written.length === 0 || !ctx.sessionManager) return;
		lastRequest = undefined;
		if (`${message.provider}/${message.model}` !== request.model) return;
		const branch = branchOf(ctx);
		const baseline = runBaseline(branch);
		if (baseline === undefined) return;
		const projection = ctx.sessionManager.buildSessionProjection().entries as unknown as ProjectedEntryLike[];
		refreshOnReadThrough(projection, branch, written, request.model, request.time, message.usage?.cacheRead ?? 0, baseline);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!config.enabled || !config.pinAnthropicCache) return;
		if (ctx.model?.api !== "anthropic-messages") return;
		// Mutates in place; returning undefined keeps the payload. The previous question is always pinned
		// (the floor). The first request after edits (checkpoint, run end or another extension) also gets
		// a read point, only at an entry this process saw itself write (`written`), and a write anchor
		// after the first edited batch (checkpoint.ts → cacheAnchors).
		const model = modelKey(ctx);
		const branch = ctx.sessionManager ? branchOf(ctx) : [];
		const now = Date.now();
		lastRequest = { model, time: now };
		const anchors = cacheAnchors(branch, written, model, now);
		if (anchors.read || anchors.write) {
			placeGuardBreakpoints(event.payload, { anchors: anchors.read ? [anchors.read] : [], writeAnchors: anchors.write ? [anchors.write] : [], pinQuestion: true });
		} else pinQuestionBreakpoint(event.payload);
		recordWritten(branch, event.payload, model, now);
	});

	pi.registerTool({
		name: RECALL_TOOL,
		label: "Recall",
		description:
			`Return the original of something context-guard distilled or omitted (its text starts with "${MARKER}"): a tool output, ` +
			"or a whole earlier exchange (prompt, replies, tool calls and results). Pass the entryId from that note. Optionally pass a regex `pattern` to get only matching lines (with line numbers), " +
			"and `offset`/`limit` (1-based) to page through a long output; with a `pattern` they count matching lines.",
		promptSnippet: `recall: fetch the full original of a tool output or earlier exchange marked "${MARKER}"`,
		parameters: Type.Object({
			entryId: Type.String({ description: "Entry id from the context-guard header" }),
			pattern: Type.Optional(Type.String({ description: "JavaScript regex; return only matching lines" })),
			offset: Type.Optional(Type.Number({ description: "First line to return, 1-based (counts matching lines when pattern is set)" })),
			limit: Type.Optional(Type.Number({ description: "Most lines to return (matching lines when pattern is set)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const branch = ctx.sessionManager.getBranch() as never;
			const original = originalOutput(ctx.sessionManager.getEntry(params.entryId) as never, params.entryId, branch, omittedIdsFor(branch, params.entryId, CUSTOM_TYPE));
			const text = recallText(original, params);
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerCommand("guard", {
		description: "Context guard: /guard [status|on|off|reload]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				config.enabled = arg === "on";
				saveConfigPatch(configPath, { enabled: config.enabled });
				if (config.enabled) resolveClassifier(ctx);
			} else if (arg === "reload") {
				warned = new Set();
				reload(ctx);
				if (config.enabled) resolveClassifier(ctx);
			} else if (arg && arg !== "status") {
				ctx.ui.notify("Usage: /guard [status|on|off|reload]", "warning");
				return;
			}
			refreshStatus(ctx);
			ctx.ui.notify(describe(config, stats(ctx), problem), "info");
		},
	});
}

function describe(config: GuardConfig, stats: GuardStats, problem: string | undefined): string {
	const lines = [
		`context-guard is ${config.enabled ? "on" : "off"}${problem && config.enabled ? ` (${problem})` : ""} · model ${config.model}`,
		`Saving ~${formatTokens(stats.savedTokens)} tokens (${formatChars(stats.savedChars)} chars): ${stats.distilledResults} distilled tool output(s), ${stats.omittedExchanges} omitted exchange(s).`,
		`Jev: ${stats.runs - stats.checkpoints} run(s) and ${stats.checkpoints} mid-run checkpoint(s), ${stats.requests} request(s), ${formatCost(stats.costUsd)} on this branch.`,
		`Mid-run checkpoints are ${config.midRun ? `on (outputs ≥ ${config.midRunMinAgeTurns} turns old, batches of ≥ ${formatChars(config.midRunBatchChars)} chars)` : "off"}; old exchanges are ${config.pruneExchanges ? `judged (all but the last ${config.keepRecentExchanges})` : "kept"}.`,
	];
	const last = stats.last;
	if (last) {
		const kinds = ["large", "small", "exchange"].map((kind) => `${last.results.filter((r) => (r.kind ?? "large") === kind).length} ${kind}`).join(", ");
		lines.push(`Last ${last.phase === "mid-run" ? "checkpoint" : "run"} (${(last.ms / 1000).toFixed(1)} s${last.timedOut ? ", timed out" : ""}; ${kinds}):`);
		for (const result of last.results) {
			const sizes = result.outcome === "kept" ? formatChars(result.beforeChars) : `${formatChars(result.beforeChars)} → ${formatChars(result.afterChars)}`;
			lines.push(`  ${result.outcome.padEnd(9)} ${(result.kind ?? "large").padEnd(9)} ${sizes.padEnd(13)} ${result.label}${result.reason ? ` (${result.reason})` : ""}`);
			for (const trace of result.jev ?? []) lines.push(`      jev: ${trace}`);
		}
	}
	return lines.join("\n");
}
