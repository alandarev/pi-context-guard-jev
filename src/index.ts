/**
 * pi-context-guard-jev
 *
 * After a run completes, the Jev classifier (TypeSafe, via OpenRouter by default) decides which
 * parts of the run's large tool outputs the answer still needs. Pi's append-only `context_edit`
 * entries then replace each output with the kept chunks, verbatim. The raw output stays in the
 * session; the `recall` tool returns it. The footer shows how much context is being saved.
 *
 * Also pins an Anthropic cache breakpoint at the previous user question, so the distilled
 * history still hits the prompt cache (docs/CACHE.md).
 */
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { pinQuestionBreakpoint } from "./cache-pin.ts";
import { type GuardConfig, loadConfig, parseModelRef, saveConfigPatch } from "./config.ts";
import { type DistillOutcome, distillRun } from "./distill.ts";
import { originalOutput, recallText } from "./recall.ts";
import { formatChars, MARKER } from "./render.ts";
import { collectRun } from "./run.ts";
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
	const configPath = join(getAgentDir(), "context-guard.json");
	let config: GuardConfig = loadConfig(configPath).config;
	let busy = false;
	let problem: string | undefined;
	let warned = new Set<string>();

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
		if (config.enabled) resolveClassifier(ctx);
		refreshStatus(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => refreshStatus(ctx));
	pi.on("session_compact", async (_event, ctx) => refreshStatus(ctx));
	pi.on("agent_settled", async (_event, ctx) => refreshStatus(ctx));

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!config.enabled || event.outcome !== "completed") return;
		const run = collectRun(event.context.contextEntries as unknown as ProjectedEntryLike[], config);
		if (!run || run.candidates.length === 0) return;
		if (run.candidates.reduce((sum, c) => sum + c.text.length, 0) < config.minRunChars) return;

		const classify = resolveClassifier(ctx);
		if (!classify) {
			refreshStatus(ctx);
			return;
		}

		busy = true;
		refreshStatus(ctx);
		if (ctx.hasUI) ctx.ui.setWorkingMessage("context-guard: distilling tool output with Jev…");
		let outcome: DistillOutcome;
		try {
			outcome = await distillRun(run, classify, config, ctx.signal);
		} catch (err) {
			warnOnce(ctx, "distill", `distillation failed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		} finally {
			busy = false;
			if (ctx.hasUI) ctx.ui.setWorkingMessage();
			refreshStatus(ctx);
		}
		if (outcome.requests === 0) return;

		const record: CustomDraft = {
			type: "custom",
			customType: CUSTOM_TYPE,
			data: {
				v: 1,
				model: config.model,
				savedChars: outcome.savedChars,
				requests: outcome.requests,
				inputTokens: outcome.inputTokens,
				costUsd: outcome.costUsd,
				ms: outcome.ms,
				timedOut: outcome.timedOut,
				results: outcome.records.map(({ entryId, tool, label, outcome, reason, beforeChars, afterChars }) => ({
					entryId,
					tool,
					label,
					outcome,
					reason,
					beforeChars,
					afterChars,
				})),
			} satisfies RunRecordData,
		};
		if (outcome.timedOut) warnOnce(ctx, "timeout", `Jev did not finish within ${config.timeoutMs} ms; some results were left as they are.`);
		// The runner REPLACES the draft list with our return value: keep other extensions' drafts.
		return { entries: [...event.entries, ...outcome.edits, record] };
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!config.enabled || !config.pinAnthropicCache) return;
		if (ctx.model?.api !== "anthropic-messages") return;
		pinQuestionBreakpoint(event.payload); // mutates in place; returning undefined keeps the payload
	});

	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			`Return the original output of a tool result that context-guard distilled (its text starts with "${MARKER}"). ` +
			"Pass the entryId from that header. Optionally pass a regex `pattern` to get only matching lines (with line numbers), " +
			"or `offset`/`limit` (1-based lines) to page through a long output.",
		promptSnippet: `recall: fetch the full original output of a tool result marked "${MARKER}"`,
		parameters: Type.Object({
			entryId: Type.String({ description: "Entry id from the context-guard header" }),
			pattern: Type.Optional(Type.String({ description: "JavaScript regex; return only matching lines" })),
			offset: Type.Optional(Type.Number({ description: "First line to return, 1-based" })),
			limit: Type.Optional(Type.Number({ description: "Most lines to return" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const original = originalOutput(ctx.sessionManager.getEntry(params.entryId) as never, params.entryId);
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
		`Saving ~${formatTokens(stats.savedTokens)} tokens (${formatChars(stats.savedChars)} chars) across ${stats.distilledResults} distilled tool result(s).`,
		`Jev: ${stats.runs} run(s), ${stats.requests} request(s), ${formatCost(stats.costUsd)} on this branch.`,
	];
	const last = stats.last;
	if (last) {
		lines.push(`Last run (${(last.ms / 1000).toFixed(1)} s${last.timedOut ? ", timed out" : ""}):`);
		for (const result of last.results) {
			const sizes = result.outcome === "kept" ? formatChars(result.beforeChars) : `${formatChars(result.beforeChars)} → ${formatChars(result.afterChars)}`;
			lines.push(`  ${result.outcome.padEnd(9)} ${sizes.padEnd(13)} ${result.label}${result.reason ? ` (${result.reason})` : ""}`);
		}
	}
	return lines.join("\n");
}
