import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkOutput, DEFAULT_CHUNK_OPTIONS } from "../../src/chunk.ts";
import { type DistillOptions, distillRun } from "../../src/distill.ts";
import { MARKER } from "../../src/render.ts";
import type { Candidate, RunInfo } from "../../src/run.ts";
import type { ClassifierAnswer, ClassifierRequest, ClassifierResponse, ClassifyFn } from "../../src/types.ts";
import { grepOutput, lines } from "./fixtures.ts";

const options: DistillOptions = {
	keepWholeThreshold: 0.7,
	focusWholeThreshold: 0.6,
	chunkKeepThreshold: 0.8,
	noneThreshold: 0.5,
	minRunChars: 1_000,
	maxKeepRatio: 0.6,
	keepCitedFiles: true,
	timeoutMs: 2_000,
	concurrency: 4,
	maxSegmentChars: 40_000,
	maxChunksPerSegment: 40,
};

const candidate = (entryId: string, text: string, toolName = "bash", args: Record<string, unknown> = { command: `cmd ${entryId}` }): Candidate => ({
	entryId,
	toolName,
	args,
	text,
});
const runOf = (candidates: Candidate[], answer = "The answer."): RunInfo => ({
	question: "q",
	answer,
	notes: "",
	candidates,
	toolResults: candidates.length,
});

const chunkLabels = (request: ClassifierRequest): string[] => Object.keys(request.state.chunks as Record<string, string>);

/** Answers that keep exactly the chunks `keep` returns (labels), via the per-chunk bools. */
const answer = (request: ClassifierRequest, keep: (labels: string[]) => string[], usage = true): ClassifierResponse => {
	const labels = chunkLabels(request);
	const kept = new Set(keep(labels));
	const answers: Record<string, ClassifierAnswer> = {
		keep_whole: { type: "bool", probability: 0.05 },
		focus:
			kept.size === 0
				? { type: "choice", choice: "none", probabilities: { none: 0.9 }, confidence: 0.9 }
				: { type: "choice", choice: [...kept][0], probabilities: { [[...kept][0]]: 0.9 }, confidence: 0.9 },
	};
	for (const label of labels) answers[label] = { type: "bool", probability: kept.has(label) ? 0.95 : 0.02 };
	return {
		answers,
		stopReason: "stop",
		...(usage ? { usage: { input: 100, output: 1, totalTokens: 101, cost: { total: 0.001 } } } : {}),
	};
};

const keepFirst: ClassifyFn = async (request) => answer(request, (labels) => labels.slice(0, 1));

test("skips runs without candidates or below minRunChars", async () => {
	let calls = 0;
	const classify: ClassifyFn = async (request) => {
		calls++;
		return answer(request, () => []);
	};
	const none = await distillRun(runOf([]), classify, options);
	assert.equal(none.skipped, "no-candidates");
	const small = await distillRun(runOf([candidate("a", "x".repeat(500))]), classify, options);
	assert.equal(small.skipped, "small-run");
	assert.equal(calls, 0);
	assert.deepEqual(small.edits, []);
	assert.equal(small.requests, 0);
});

test("happy path: context_edit drafts with MARKER replacements", async () => {
	const a = candidate("a", lines(200));
	const b = candidate("b", lines(200, "other"));
	const outcome = await distillRun(runOf([a, b]), keepFirst, options);

	assert.equal(outcome.skipped, undefined);
	assert.equal(outcome.timedOut, false);
	assert.equal(outcome.requests, 2);
	assert.equal(outcome.inputTokens, 200);
	assert.ok(Math.abs(outcome.costUsd - 0.002) < 1e-12);
	assert.deepEqual(
		outcome.edits.map((e) => e.targetId),
		["a", "b"],
	);
	for (const edit of outcome.edits) {
		assert.equal(edit.type, "context_edit");
		assert.equal(edit.replacement.content.length, 1);
		assert.equal(edit.replacement.content[0].type, "text");
		assert.ok(edit.replacement.content[0].text.startsWith(MARKER));
	}
	const chunks = chunkOutput(a.text, DEFAULT_CHUNK_OPTIONS);
	assert.ok(outcome.edits[0].replacement.content[0].text.includes(`\n${chunks[0].text}\n[… `));

	assert.deepEqual(
		outcome.records.map((r) => [r.entryId, r.outcome, r.reason, r.requests, r.chunks]),
		[
			["a", "distilled", "chunks", 1, chunks.length],
			["b", "distilled", "chunks", 1, chunkOutput(b.text, DEFAULT_CHUNK_OPTIONS).length],
		],
	);
	const saved = outcome.records.reduce((n, r) => n + r.beforeChars - r.afterChars, 0);
	assert.equal(outcome.savedChars, saved);
	assert.ok(saved > 0);
	assert.equal(outcome.records[0].afterChars, outcome.edits[0].replacement.content[0].text.length);
});

test("nothing needed: result removed with reason none-needed", async () => {
	const outcome = await distillRun(runOf([candidate("a", lines(200))]), async (request) => answer(request, () => []), options);
	assert.equal(outcome.records[0].outcome, "removed");
	assert.equal(outcome.records[0].reason, "none-needed");
	assert.match(outcome.edits[0].replacement.content[0].text, /^\[context-guard\] Removed the output of bash `cmd a`/);
});

test("keeping too much is not worth an edit", async () => {
	const outcome = await distillRun(
		runOf([candidate("a", lines(200))]),
		async (request) => answer(request, (labels) => labels.slice(0, Math.ceil(labels.length * 0.7))),
		options,
	);
	assert.deepEqual(outcome.edits, []);
	assert.equal(outcome.records[0].outcome, "kept");
	assert.equal(outcome.records[0].reason, "not-worth");
	assert.equal(outcome.savedChars, 0);
});

test("keep_whole keeps the result", async () => {
	const outcome = await distillRun(
		runOf([candidate("a", lines(200))]),
		async (request) => {
			const response = answer(request, () => []);
			response.answers.keep_whole = { type: "bool", probability: 0.9 };
			return response;
		},
		options,
	);
	assert.deepEqual(outcome.edits, []);
	assert.equal(outcome.records[0].reason, "whole-needed");
});

test("classify throwing or returning an error keeps the result", async () => {
	const a = candidate("a", lines(200));
	const b = candidate("b", lines(200, "b"));
	const outcome = await distillRun(
		runOf([a, b]),
		async (request) => {
			if ((request.state.tool_arguments as string).includes("cmd a")) throw new Error("network down");
			return { answers: {}, stopReason: "error", errorMessage: "rate limited" };
		},
		options,
	);
	assert.deepEqual(outcome.edits, []);
	assert.equal(outcome.requests, 2);
	assert.deepEqual(
		outcome.records.map((r) => [r.outcome, r.reason]),
		[
			["kept", "error"],
			["kept", "error"],
		],
	);
	// A throwing request has no response.
	assert.equal(outcome.records[0].requests, 0);
	assert.equal(outcome.records[1].requests, 1);
});

/** A fake classifier that only answers after `ms`, and rejects when the signal aborts. */
const slow =
	(ms: number, inner: ClassifyFn = keepFirst): ClassifyFn =>
	(request, signal) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => resolve(inner(request, signal)), ms);
			signal.addEventListener("abort", () => {
				clearTimeout(timer);
				reject(signal.reason);
			});
		});

test("time budget: unfinished segments are kept and timedOut is set", async () => {
	const fast = candidate("fast", lines(200));
	const stuck = candidate("stuck", lines(200, "s"));
	const classify: ClassifyFn = (request, signal) =>
		(request.state.tool_arguments as string).includes("stuck") ? slow(60_000)(request, signal) : keepFirst(request, signal);
	const started = Date.now();
	const outcome = await distillRun(runOf([fast, stuck]), classify, { ...options, timeoutMs: 500 });
	assert.ok(Date.now() - started < 5_000);
	assert.equal(outcome.timedOut, true);
	assert.deepEqual(
		outcome.edits.map((e) => e.targetId),
		["fast"],
	);
	assert.deepEqual(
		outcome.records.map((r) => [r.entryId, r.outcome, r.reason]),
		[
			["fast", "distilled", "chunks"],
			["stuck", "kept", "timeout"],
		],
	);
});

test("time budget: tasks never started are kept as timeout", async () => {
	const candidates = Array.from({ length: 4 }, (_, i) => candidate(`c${i}`, lines(200, `c${i}`)));
	let started = 0;
	const outcome = await distillRun(
		runOf(candidates),
		(request, signal) => {
			started++;
			return slow(60_000)(request, signal);
		},
		{ ...options, timeoutMs: 500, concurrency: 2 },
	);
	assert.equal(outcome.timedOut, true);
	assert.equal(started, 2);
	assert.equal(outcome.requests, 2);
	assert.deepEqual(outcome.edits, []);
	assert.deepEqual(
		outcome.records.map((r) => r.reason),
		["timeout", "timeout", "timeout", "timeout"],
	);
});

test("parent signal abort stops the run without timedOut", async () => {
	const parent = new AbortController();
	setTimeout(() => parent.abort(), 50);
	const outcome = await distillRun(runOf([candidate("a", lines(200))]), slow(60_000), options, parent.signal);
	assert.equal(outcome.timedOut, false);
	assert.deepEqual(outcome.edits, []);
	assert.equal(outcome.records[0].outcome, "kept");
});

test("a late answer with stopReason aborted keeps the result", async () => {
	const outcome = await distillRun(
		runOf([candidate("a", lines(200))]),
		async () => ({ answers: {}, stopReason: "aborted" }),
		options,
	);
	assert.deepEqual(outcome.edits, []);
	assert.equal(outcome.records[0].reason, "error");
});

test("concurrency limit is honoured", async () => {
	const candidates = Array.from({ length: 9 }, (_, i) => candidate(`c${i}`, lines(150, `c${i}`)));
	let inFlight = 0;
	let maxInFlight = 0;
	const classify: ClassifyFn = async (request, signal) => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await new Promise((resolve) => setTimeout(resolve, 10));
		inFlight--;
		return keepFirst(request, signal);
	};
	const outcome = await distillRun(runOf(candidates), classify, { ...options, concurrency: 3 });
	assert.equal(maxInFlight, 3);
	assert.equal(outcome.requests, 9);
	assert.equal(outcome.edits.length, 9);
});

test("a large candidate is split into several segments", async () => {
	const text = lines(1_000);
	const chunks = chunkOutput(text, DEFAULT_CHUNK_OPTIONS);
	const requests: ClassifierRequest[] = [];
	const outcome = await distillRun(
		runOf([candidate("big", text)]),
		async (request) => {
			requests.push(request);
			// Keep the first chunk of the first segment only.
			return answer(request, (labels) => (labels.includes("chunk_1") ? ["chunk_1"] : []));
		},
		{ ...options, maxChunksPerSegment: 5 },
	);
	const segmentCount = Math.ceil(chunks.length / 5);
	assert.ok(segmentCount > 1);
	assert.equal(requests.length, segmentCount);
	assert.equal(requests[1].state.output_size, `1000 lines; this is part 2 of ${segmentCount}`);
	assert.deepEqual(
		requests.map((r) => chunkLabels(r).length),
		Array.from({ length: segmentCount }, (_, i) => Math.min(5, chunks.length - i * 5)),
	);
	assert.deepEqual(chunkLabels(requests[1]).slice(0, 1), ["chunk_6"]);
	assert.equal(outcome.records[0].requests, segmentCount);
	assert.equal(outcome.records[0].outcome, "distilled");
	assert.equal(outcome.records[0].keptLines, chunks[0].end);
	assert.equal(outcome.inputTokens, 100 * segmentCount);
});

test("one failing segment keeps its chunks; the others are still distilled", async () => {
	const text = lines(1_000);
	const chunks = chunkOutput(text, DEFAULT_CHUNK_OPTIONS);
	const outcome = await distillRun(
		runOf([candidate("big", text)]),
		async (request) => {
			if (chunkLabels(request).includes("chunk_1")) return { answers: {}, stopReason: "error", errorMessage: "x" };
			return answer(request, () => []);
		},
		{ ...options, maxChunksPerSegment: Math.ceil(chunks.length / 4) },
	);
	const record = outcome.records[0];
	assert.equal(record.outcome, "distilled");
	const kept = chunks.slice(0, Math.ceil(chunks.length / 4));
	assert.equal(record.keptLines, kept.at(-1)!.end);
});

test("keepCitedFiles adds the chunks of files named in the answer", async () => {
	const files = ["src/alpha.ts", "src/beta.ts", "src/gamma.ts", "src/delta.ts", "src/epsilon.ts"];
	const text = grepOutput(files, 20);
	const chunks = chunkOutput(text, DEFAULT_CHUNK_OPTIONS);
	const gammaChunks = chunks.filter((c) => c.files.includes("src/gamma.ts")).map((c) => c.index);
	assert.ok(gammaChunks.length > 0);
	const classify: ClassifyFn = async (request) => answer(request, (labels) => labels.slice(0, 1));
	const run = runOf([candidate("g", text, "bash", { command: "rg match" })], "The match is in gamma.ts.");

	const withCites = await distillRun(run, classify, options);
	const kept = withCites.edits[0].replacement.content[0].text;
	assert.ok(kept.includes(chunks[0].text));
	for (const index of gammaChunks) assert.ok(kept.includes(chunks[index].text));

	const without = await distillRun(run, classify, { ...options, keepCitedFiles: false });
	const keptWithout = without.edits[0].replacement.content[0].text;
	for (const index of gammaChunks) assert.ok(!keptWithout.includes(chunks[index].text));
});

test("usage and cost are summed; responses without usage count zero", async () => {
	let n = 0;
	const outcome = await distillRun(
		runOf([candidate("a", lines(200)), candidate("b", lines(200, "b")), candidate("c", lines(200, "c"))]),
		async (request) => answer(request, (labels) => labels.slice(0, 1), n++ !== 1),
		{ ...options, concurrency: 1 },
	);
	assert.equal(outcome.requests, 3);
	assert.equal(outcome.inputTokens, 200);
	assert.ok(Math.abs(outcome.costUsd - 0.002) < 1e-12);
});
