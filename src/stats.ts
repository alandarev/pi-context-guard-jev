/**
 * Savings shown in the status bar, derived from the session itself so they follow branches,
 * `/tree` navigation, reloads and compaction:
 *
 * - active savings: for every tool result in the current model context whose projected text
 *   is one of our replacements, original size minus replacement size (size.ts: images by pixels);
 * - lifetime savings: summed from our `context-guard` records on the active branch. Compaction drops
 *   earlier edits from the context, so after one the footer shows both (`🛡 0 · Σ−79k`);
 * - Jev usage: summed from the same records.
 */
import { imagesRemoved } from "./images.ts";
import { formatChars, MARKER } from "./render.ts";
import { EXCHANGE_STUB_PREFIX } from "./items.ts";
import { isBranchSteering } from "./run.ts";
import { contentChars } from "./size.ts";
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
		kind?: "large" | "small" | "exchange" | "image";
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
	/** Tool results whose images are currently removed from model context. */
	imageResults: number;
	/** Old exchanges currently omitted from model context. */
	omittedExchanges: number;
	/** Characters currently kept out of model context. */
	savedChars: number;
	/** Rough token equivalent (Pi's own estimate: chars / 4). */
	savedTokens: number;
	/** Characters saved by every record on the branch, including edits a compaction has since dropped. */
	lifetimeChars: number;
	lifetimeTokens: number;
	/** A compaction came after a record that saved something: `lifetime` is worth showing. */
	compacted: boolean;
	runs: number;
	/** Mid-run checkpoints among `runs`. */
	checkpoints: number;
	requests: number;
	costUsd: number;
	last?: RunRecordData;
}

export const estimateTokens = (chars: number): number => Math.round(chars / 4);

type StatsBranchEntry = { type?: string; id?: string; customType?: string; data?: unknown; message?: MessageLike };

const messageChars = (message: MessageLike): number => contentChars(message.content);

export function computeStats(projection: readonly ProjectedEntryLike[], branch: readonly StatsBranchEntry[]): GuardStats {
	const stats: GuardStats = {
		distilledResults: 0,
		imageResults: 0,
		omittedExchanges: 0,
		savedChars: 0,
		savedTokens: 0,
		lifetimeChars: 0,
		lifetimeTokens: 0,
		compacted: false,
		runs: 0,
		checkpoints: 0,
		requests: 0,
		costUsd: 0,
	};
	// Pi keeps omitted entries in the projection with `messages: []`: count what the model sees.
	const visibleMessages = new Map(projection.map((entry) => [entry.sourceEntry.id, entry.messages.length]));
	for (const entry of projection) {
		const projected = entry.messages[0];
		const raw = entry.sourceEntry.message;
		if (entry.messages.length === 1 && projected?.role === "user" && raw && textOf(projected).startsWith(EXCHANGE_STUB_PREFIX) && !textOf(raw).startsWith(MARKER)) {
			// An omitted exchange: its raw entries up to the next user message that the model no longer sees.
			const start = branch.findIndex((e) => e.id === entry.sourceEntry.id);
			let before = messageChars(raw);
			for (let i = start + 1; start >= 0 && i < branch.length; i++) {
				const e = branch[i];
				if (e.type === "message" && e.message?.role === "user" && !isBranchSteering(branch, i)) break;
				if (e.message && e.id && (visibleMessages.get(e.id) ?? 0) === 0) before += messageChars(e.message);
			}
			stats.omittedExchanges++;
			stats.savedChars += Math.max(0, before - messageChars(projected));
			continue;
		}
		if (entry.messages.length !== 1 || projected?.role !== "toolResult" || !raw) continue;
		if (!textOf(projected).startsWith(MARKER) || textOf(raw).startsWith(MARKER)) continue;
		if (imagesRemoved(projected, raw)) stats.imageResults++;
		else stats.distilledResults++;
		stats.savedChars += Math.max(0, messageChars(raw) - messageChars(projected));
	}
	stats.savedTokens = estimateTokens(stats.savedChars);
	let saving = false;
	for (const entry of branch) {
		if (entry.type === "compaction" && saving) stats.compacted = true;
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		const data = entry.data as Partial<RunRecordData> | undefined;
		if (!data || data.v !== 1) continue;
		stats.runs++;
		if (data.phase === "mid-run") stats.checkpoints++;
		stats.requests += data.requests ?? 0;
		stats.costUsd += data.costUsd ?? 0;
		stats.lifetimeChars += Math.max(0, data.savedChars ?? 0);
		if ((data.savedChars ?? 0) > 0) saving = true;
		stats.last = data as RunRecordData;
	}
	stats.lifetimeTokens = estimateTokens(stats.lifetimeChars);
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
	// After a compaction dropped earlier edits: "· Σ−79k", every saving of the session so far.
	const lifetime = stats.compacted && stats.lifetimeTokens > stats.savedTokens ? color("dim", ` · Σ−${formatTokens(stats.lifetimeTokens)}`) : "";
	if (stats.savedTokens === 0) return `${color("dim", `${icon} ${lifetime ? "0" : "0 saved"}`)}${lifetime}`;
	const count = stats.distilledResults + stats.imageResults + stats.omittedExchanges;
	// "🛡 −4.2k · 1": ≈ tokens kept out of context · edited items.
	return `${color("success", `${icon} −${formatTokens(stats.savedTokens)}`)}${color("dim", ` · ${count}`)}${lifetime}`;
}

export const formatCost = (usd: number): string => (usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
