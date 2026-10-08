/**
 * One pass over every kind of item (docs/DESIGN.md → Items): large outputs (chunked, `distillRun`),
 * small outputs and old exchanges (whole items, `judgeItems`), all in parallel, merged into one list of
 * edits and one record.
 */
import { type DistillOptions, type DistillOutcome, distillRun, type ResultRecord } from "./distill.ts";
import {
	buildExchangeRequest,
	buildSmallRequest,
	createLimiter,
	type ExchangeItem,
	exchangeEdits,
	exchangeLabel,
	exchangeStub,
	type ItemKind,
	itemLabel,
	judgeItems,

	type SmallItem,
	smallStub,
	type WorkContext,
} from "./items.ts";
import { type ImageItem, imageLabel } from "./images.ts";
import { toolLabel } from "./render.ts";
import type { RunInfo } from "./run.ts";
import type { ClassifyFn, ContextEditDraft, OmitDraft } from "./types.ts";

export interface ProcessOptions extends DistillOptions {
	/** Keep a small output when P(still needed) reaches this. */
	smallKeepThreshold: number;
	/** Omit an exchange only when P(still relevant) is below this. */
	exchangeOmitThreshold: number;
}

export interface ItemRecord extends ResultRecord {
	kind: ItemKind;
	/** Omitted exchanges: the exact entry ids that got `replacement: null` (recall shows exactly these). */
	omitted?: string[];
}

export interface ProcessOutcome {
	edits: (ContextEditDraft | OmitDraft)[];
	records: ItemRecord[];
	savedChars: number;
	requests: number;
	inputTokens: number;
	costUsd: number;
	ms: number;
	timedOut: boolean;
}

const p2 = (p: number | undefined): string => (p === undefined ? "?" : p.toFixed(2).replace(/^0/, ""));

export async function processItems(
	run: RunInfo,
	small: readonly SmallItem[],
	exchanges: readonly ExchangeItem[],
	work: WorkContext,
	classify: ClassifyFn,
	options: ProcessOptions,
	signal?: AbortSignal,
	now: () => number = Date.now,
): Promise<ProcessOutcome> {
	const started = now();
	// One limiter for every kind: `concurrency` is the total number of Jev requests in flight.
	const limit = createLimiter(Math.max(1, options.concurrency));
	const limited: ClassifyFn = (request, s) => limit(() => classify(request, s));
	const judge = { timeoutMs: options.timeoutMs, concurrency: options.concurrency, maxRequestChars: options.maxSegmentChars, maxItemsPerRequest: options.maxChunksPerSegment };
	const empty: DistillOutcome = { edits: [], records: [], savedChars: 0, requests: 0, inputTokens: 0, costUsd: 0, ms: 0, timedOut: false };
	const [large, smallOutcome, exchangeOutcome] = await Promise.all([
		run.candidates.length > 0 ? distillRun(run, limited, options, signal, now) : Promise.resolve(empty),
		judgeItems(small, (i) => Math.min(i.text.length, 4_000) + 200, (batch) => buildSmallRequest(work, batch), itemLabel, limited, judge, signal, now),
		judgeItems(exchanges, (e) => Math.min(e.prompt.length, 600) + Math.min(e.answer.length, 800) + e.toolCalls.length * 60 + 200, (batch) => buildExchangeRequest(work, batch), exchangeLabel, limited, judge, signal, now),
	]);

	const outcome: ProcessOutcome = {
		edits: [...large.edits],
		records: large.records.map((r) => ({ ...r, kind: "large" as const })),
		savedChars: large.savedChars,
		requests: large.requests + smallOutcome.requests + exchangeOutcome.requests,
		inputTokens: large.inputTokens + smallOutcome.inputTokens + exchangeOutcome.inputTokens,
		costUsd: large.costUsd + smallOutcome.costUsd + exchangeOutcome.costUsd,
		ms: 0,
		timedOut: large.timedOut || smallOutcome.timedOut || exchangeOutcome.timedOut,
	};

	small.forEach((item, i) => {
		const p = smallOutcome.probabilities[i];
		const failure = smallOutcome.failures.get(i);
		const drop = p !== undefined && p < options.smallKeepThreshold;
		const stub = smallStub(item);
		const record: ItemRecord = {
			kind: "small",
			entryId: item.entryId,
			tool: item.toolName,
			label: toolLabel(item),
			outcome: drop ? "removed" : "kept",
			reason: failure ?? (drop ? "not-needed" : "needed"),
			beforeChars: item.text.length,
			afterChars: drop ? stub.length : item.text.length,
			keptLines: 0,
			totalLines: 0,
			chunks: 1,
			requests: p === undefined ? 0 : 1,
			jev: [`p${p2(p)}${failure ? ` ${failure}` : ""}`],
		};
		outcome.records.push(record);
		if (drop) {
			outcome.edits.push({ type: "context_edit", targetId: item.entryId, replacement: { content: [{ type: "text", text: stub }] } });
			outcome.savedChars += item.text.length - stub.length;
		}
	});

	exchanges.forEach((item, i) => {
		const p = exchangeOutcome.probabilities[i];
		const failure = exchangeOutcome.failures.get(i);
		const omit = p !== undefined && p < options.exchangeOmitThreshold;
		const stub = exchangeStub(item);
		outcome.records.push({
			kind: "exchange",
			entryId: item.entryId,
			tool: "exchange",
			label: `"${item.prompt.replace(/\s+/g, " ").slice(0, 60)}"`,
			outcome: omit ? "removed" : "kept",
			reason: failure ?? (omit ? "unrelated" : "relevant"),
			beforeChars: item.chars,
			afterChars: omit ? stub.length : item.chars,
			keptLines: 0,
			totalLines: item.messages,
			chunks: 1,
			requests: p === undefined ? 0 : 1,
			jev: [`p${p2(p)}${failure ? ` ${failure}` : ""}`],
		});
		if (omit) {
			outcome.records.at(-1)!.omitted = item.omitIds;
			outcome.edits.push(...exchangeEdits(item));
			outcome.savedChars += item.chars - stub.length;
		}
	});

	outcome.ms = now() - started;
	return outcome;
}



export const emptyOutcome = (): ProcessOutcome => ({ edits: [], records: [], savedChars: 0, requests: 0, inputTokens: 0, costUsd: 0, ms: 0, timedOut: false });

/** Add the removal of old images (no Jev request; images.ts) to `outcome`. */
export function addImages(outcome: ProcessOutcome, items: readonly ImageItem[]): void {
	for (const item of items) {
		outcome.edits.push({ type: "context_edit", targetId: item.entryId, replacement: { content: item.replacement } });
		outcome.records.push({
			kind: "image",
			entryId: item.entryId,
			tool: item.toolName,
			label: imageLabel(item),
			outcome: "removed",
			reason: `${item.age} turns old`,
			beforeChars: item.beforeChars,
			afterChars: item.afterChars,
			keptLines: 0,
			totalLines: 0,
			chunks: 1,
			requests: 0,
			jev: [],
		});
		outcome.savedChars += item.beforeChars - item.afterChars;
	}
}

/** Take image removals for `ids` back out of `outcome` (they stay eligible for a later pass). */
export function dropImages(outcome: ProcessOutcome, ids: ReadonlySet<string>): void {
	if (ids.size === 0) return;
	outcome.edits = outcome.edits.filter((e) => !ids.has(e.targetId));
	outcome.records = outcome.records.filter((r) => {
		if (r.kind !== "image" || !ids.has(r.entryId)) return true;
		outcome.savedChars -= r.beforeChars - r.afterChars;
		return false;
	});
}

/** Net characters the outcome's exchange omissions remove, and the entry ids they edit. */
export function exchangeOmissions(outcome: ProcessOutcome): { savedChars: number; ids: Set<string> } {
	const ids = new Set<string>();
	let savedChars = 0;
	for (const r of outcome.records) {
		if (r.kind !== "exchange" || r.outcome !== "removed") continue;
		savedChars += r.beforeChars - r.afterChars;
		ids.add(r.entryId);
		for (const id of r.omitted ?? []) ids.add(id);
	}
	return { savedChars, ids };
}

/**
 * Take the exchange omissions back out of `outcome` (the break-even gate deferred them): their edits are
 * dropped and their records say `kept` with reason `deferred`, so they stay eligible and are judged again
 * at a later run end, against the work of that run.
 */
export function deferExchanges(outcome: ProcessOutcome): void {
	const { savedChars, ids } = exchangeOmissions(outcome);
	if (ids.size === 0) return;
	outcome.edits = outcome.edits.filter((e) => !ids.has(e.targetId));
	outcome.savedChars -= savedChars;
	for (const r of outcome.records) {
		if (r.kind !== "exchange" || r.outcome !== "removed") continue;
		r.outcome = "kept";
		r.reason = "deferred";
		r.afterChars = r.beforeChars;
		delete r.omitted;
	}
}
