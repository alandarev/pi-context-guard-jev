/**
 * Savings shown in the status bar, derived from the session itself so they follow branches,
 * `/tree` navigation, reloads and compaction:
 *
 * - active savings: for every tool result in the current model context whose projected text
 *   is one of our replacements, original length minus replacement length;
 * - Jev usage: summed from our `context-guard` custom entries on the active branch.
 */
import { formatChars, MARKER } from "./render.ts";
import { EXCHANGE_STUB_PREFIX } from "./items.ts";
import { isBranchSteering } from "./run.ts";
import { type MessageLike, type ProjectedEntryLike, textOf } from "./types.ts";

export const CUSTOM_TYPE = "context-guard";

/** Data stored in each `context-guard` custom entry (one per distilled run). */
export interface RunRecordData {
	v: 1;
	/** "mid-run" for checkpoints; a record without it counts as run end. */
	phase?: "mid-run" | "run-end";
	model: string;
	savedChars: number;
	requests: number;
	inputTokens: number;
	costUsd: number;
	ms: number;
	timedOut: boolean;
	results: {
		/** Absent in records that only had large outputs. */
		kind?: "large" | "small" | "exchange";
		/** Omitted exchanges: the entry ids that got `replacement: null`. */
		omitted?: string[];
		entryId: string;
		tool: string;
		label: string;
		outcome: string;
		reason: string;
		beforeChars: number;
		afterChars: number;
		/** Per-segment trace of Jev's answers (see distill.ts traceOf). */
		jev?: string[];
	}[];
}

export interface GuardStats {
	/** Tool results currently distilled or omitted in model context (large and small outputs). */
	distilledResults: number;
	/** Old exchanges currently omitted from model context. */
	omittedExchanges: number;
	/** Characters currently kept out of model context. */
	savedChars: number;
	/** Rough token equivalent (Pi's own estimate: chars / 4). */
	savedTokens: number;
	runs: number;
	/** Mid-run checkpoints among `runs`. */
	checkpoints: number;
	requests: number;
	costUsd: number;
	last?: RunRecordData;
}

export const estimateTokens = (chars: number): number => Math.round(chars / 4);

type StatsBranchEntry = { type?: string; id?: string; customType?: string; data?: unknown; message?: MessageLike };

export function computeStats(projection: readonly ProjectedEntryLike[], branch: readonly StatsBranchEntry[]): GuardStats {
	const stats: GuardStats = { distilledResults: 0, omittedExchanges: 0, savedChars: 0, savedTokens: 0, runs: 0, checkpoints: 0, requests: 0, costUsd: 0 };
	// Pi keeps omitted entries in the projection with `messages: []`: count what the model sees.
	const visibleMessages = new Map(projection.map((entry) => [entry.sourceEntry.id, entry.messages.length]));
	for (const entry of projection) {
		const projected = entry.messages[0];
		const raw = entry.sourceEntry.message;
		if (entry.messages.length === 1 && projected?.role === "user" && raw && textOf(projected).startsWith(EXCHANGE_STUB_PREFIX) && !textOf(raw).startsWith(MARKER)) {
			// An omitted exchange: its raw entries up to the next user message that the model no longer sees.
			const start = branch.findIndex((e) => e.id === entry.sourceEntry.id);
			let before = textOf(raw).length;
			for (let i = start + 1; start >= 0 && i < branch.length; i++) {
				const e = branch[i];
				if (e.type === "message" && e.message?.role === "user" && !isBranchSteering(branch, i)) break;
				if (e.message && e.id && (visibleMessages.get(e.id) ?? 0) === 0) before += textOf(e.message).length;
			}
			stats.omittedExchanges++;
			stats.savedChars += Math.max(0, before - textOf(projected).length);
			continue;
		}
		if (entry.messages.length !== 1 || projected?.role !== "toolResult" || !raw) continue;
		const now = textOf(projected);
		if (!now.startsWith(MARKER)) continue;
		const before = textOf(raw);
		if (before.startsWith(MARKER)) continue;
		stats.distilledResults++;
		stats.savedChars += Math.max(0, before.length - now.length);
	}
	stats.savedTokens = estimateTokens(stats.savedChars);
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		const data = entry.data as Partial<RunRecordData> | undefined;
		if (!data || data.v !== 1) continue;
		stats.runs++;
		if (data.phase === "mid-run") stats.checkpoints++;
		stats.requests += data.requests ?? 0;
		stats.costUsd += data.costUsd ?? 0;
		stats.last = data as RunRecordData;
	}
	return stats;
}

export const formatTokens = (tokens: number): string => formatChars(tokens);

export type StatusState = "off" | "busy" | "ready" | "problem";

/** Theme colouring hook: `ctx.ui.theme.fg` in Pi, identity in tests. */
export type Colorize = (color: "dim" | "accent" | "success" | "warning" | "muted", text: string) => string;

/** Footer text for `ctx.ui.setStatus("context-guard", …)`. */
export function formatStatus(stats: GuardStats, state: StatusState, color: Colorize, problem?: string): string {
	const icon = "🛡";
	if (state === "off") return color("dim", `${icon} guard off`);
	if (state === "busy") return color("accent", `${icon} distilling…`);
	if (state === "problem") return color("warning", `${icon} ${problem ?? "guard unavailable"}`);
	if (stats.savedTokens === 0) return color("dim", `${icon} 0 saved`);
	const count = stats.distilledResults + stats.omittedExchanges;
	// "🛡 −4.2k · 1": ≈ tokens kept out of context · distilled results.
	return `${color("success", `${icon} −${formatTokens(stats.savedTokens)}`)}${color("dim", ` · ${count}`)}`;
}

export const formatCost = (usd: number): string => (usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
