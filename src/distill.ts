/**
 * Orchestrate one distillation pass over a finished run: chunk every candidate, ask Jev about
 * each segment in parallel within a time budget, and turn the answers into context edits.
 *
 * Pure apart from the injected `classify` function, so it is unit-testable without Pi.
 */
import { type Chunk, chunkOutput, DEFAULT_CHUNK_OPTIONS, segmentChunks } from "./chunk.ts";
import { buildRequest, citedFiles, type DecideThresholds, interpret, type SegmentDecision } from "./decide.ts";
import { renderReplacement, toolLabel } from "./render.ts";
import type { Candidate, RunInfo } from "./run.ts";
import type { ClassifierResponse, ClassifyFn, ContextEditDraft } from "./types.ts";

export interface DistillOptions extends DecideThresholds {
	minRunChars: number;
	maxKeepRatio: number;
	keepCitedFiles: boolean;
	timeoutMs: number;
	concurrency: number;
	maxSegmentChars: number;
	maxChunksPerSegment: number;
}

export type ResultOutcome = "distilled" | "removed" | "kept";

export interface ResultRecord {
	entryId: string;
	tool: string;
	label: string;
	outcome: ResultOutcome;
	/** Why: Jev's reason for keeping, "not-worth" (saving too small), "timeout", "error", … */
	reason: string;
	beforeChars: number;
	afterChars: number;
	keptLines: number;
	totalLines: number;
	chunks: number;
	requests: number;
}

export interface DistillOutcome {
	edits: ContextEditDraft[];
	records: ResultRecord[];
	/** Characters removed from model context by `edits`. */
	savedChars: number;
	requests: number;
	inputTokens: number;
	costUsd: number;
	ms: number;
	timedOut: boolean;
	/** Set when the run was skipped before any Jev request. */
	skipped?: "no-candidates" | "small-run";
}

interface Task {
	candidate: number;
	segment: Chunk[];
	segmentIndex: number;
	segmentCount: number;
	totalLines: number;
	decision?: SegmentDecision;
	response?: ClassifierResponse;
}

/** Run `work` over `items` with at most `limit` in flight; stops starting new items once `signal` aborts. */
async function pool<T>(items: readonly T[], limit: number, signal: AbortSignal, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length && !signal.aborted) {
			const item = items[next++];
			await work(item);
		}
	});
	await Promise.all(runners);
}

export async function distillRun(
	run: RunInfo,
	classify: ClassifyFn,
	options: DistillOptions,
	parentSignal?: AbortSignal,
	now: () => number = Date.now,
): Promise<DistillOutcome> {
	const started = now();
	const outcome: DistillOutcome = { edits: [], records: [], savedChars: 0, requests: 0, inputTokens: 0, costUsd: 0, ms: 0, timedOut: false };
	if (run.candidates.length === 0) return { ...outcome, skipped: "no-candidates" };
	const total = run.candidates.reduce((sum, candidate) => sum + candidate.text.length, 0);
	if (total < options.minRunChars) return { ...outcome, skipped: "small-run" };

	const chunked = run.candidates.map((candidate) => chunkOutput(candidate.text, DEFAULT_CHUNK_OPTIONS));
	const tasks: Task[] = [];
	chunked.forEach((chunks, candidate) => {
		const segments = segmentChunks(chunks, options.maxSegmentChars, options.maxChunksPerSegment);
		const totalLines = chunks.length > 0 ? chunks[chunks.length - 1].end : 0;
		segments.forEach((segment, segmentIndex) =>
			tasks.push({ candidate, segment, segmentIndex, segmentCount: segments.length, totalLines }),
		);
	});

	const budget = new AbortController();
	const timer = setTimeout(() => budget.abort(new Error("context-guard time budget exceeded")), options.timeoutMs);
	const signal = parentSignal ? AbortSignal.any([parentSignal, budget.signal]) : budget.signal;
	try {
		await pool(tasks, options.concurrency, signal, async (task) => {
			const candidate = run.candidates[task.candidate];
			const request = buildRequest(run, candidate, task.segment, task.segmentIndex, task.segmentCount, task.totalLines);
			outcome.requests++;
			try {
				const response = await classify(request, signal);
				task.response = response;
				if (response.usage) {
					outcome.inputTokens += response.usage.input;
					outcome.costUsd += response.usage.cost.total;
				}
				// A request that finished after the budget ran out is still usable.
				task.decision =
					response.stopReason === "aborted"
						? { kind: "keep-all", reason: "error", detail: budget.signal.aborted ? "timeout" : "aborted" }
						: interpret(response, task.segment, options);
			} catch (err) {
				const detail = budget.signal.aborted ? "timeout" : err instanceof Error ? err.message : String(err);
				task.decision = { kind: "keep-all", reason: "error", detail };
			}
		});
	} finally {
		clearTimeout(timer);
	}
	outcome.timedOut = budget.signal.aborted;

	run.candidates.forEach((candidate, index) => {
		const chunks = chunked[index];
		const own = tasks.filter((task) => task.candidate === index);
		const record = decideCandidate(run, candidate, chunks, own, options);
		outcome.records.push(record.record);
		if (record.edit) {
			outcome.edits.push(record.edit);
			outcome.savedChars += record.record.beforeChars - record.record.afterChars;
		}
	});
	outcome.ms = now() - started;
	return outcome;
}

function decideCandidate(
	run: RunInfo,
	candidate: Candidate,
	chunks: Chunk[],
	tasks: Task[],
	options: DistillOptions,
): { record: ResultRecord; edit?: ContextEditDraft } {
	const totalLines = chunks.length > 0 ? chunks[chunks.length - 1].end : 0;
	const record: ResultRecord = {
		entryId: candidate.entryId,
		tool: candidate.toolName,
		label: toolLabel(candidate),
		outcome: "kept",
		reason: "",
		beforeChars: candidate.text.length,
		afterChars: candidate.text.length,
		keptLines: totalLines,
		totalLines,
		chunks: chunks.length,
		requests: tasks.filter((task) => task.response).length,
	};

	const keep = new Set<number>();
	const keepReasons = new Set<string>();
	let sawNone = false;
	for (const task of tasks) {
		const decision: SegmentDecision = task.decision ?? { kind: "keep-all", reason: "error", detail: "timeout" };
		if (decision.kind === "keep-all") {
			for (const chunk of task.segment) keep.add(chunk.index);
			keepReasons.add(decision.detail === "timeout" ? "timeout" : decision.reason);
		} else {
			for (const index of decision.keep) keep.add(index);
			if (decision.reason === "none-needed") sawNone = true;
		}
	}
	if (keep.size === chunks.length) {
		record.reason = [...keepReasons].join(",") || "all-chunks";
		return { record };
	}

	if (options.keepCitedFiles) for (const index of citedFiles(run.answer, chunks)) keep.add(index);

	const keptChars = chunks.filter((chunk) => keep.has(chunk.index)).reduce((sum, chunk) => sum + chunk.text.length + 1, 0);
	if (keptChars > candidate.text.length * options.maxKeepRatio) {
		record.reason = "not-worth";
		return { record };
	}

	const rendered = renderReplacement(candidate, chunks, keep);
	if (rendered.text.length >= candidate.text.length) {
		record.reason = "not-worth";
		return { record };
	}
	record.outcome = keep.size === 0 ? "removed" : "distilled";
	record.reason = keep.size === 0 && sawNone ? "none-needed" : "chunks";
	record.afterChars = rendered.text.length;
	record.keptLines = rendered.keptLines;
	return {
		record,
		edit: { type: "context_edit", targetId: candidate.entryId, replacement: { content: [{ type: "text", text: rendered.text }] } },
	};
}
