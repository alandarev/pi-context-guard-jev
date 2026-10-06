import assert from "node:assert/strict";
import { test } from "node:test";
import type { Chunk } from "../../src/chunk.ts";
import { buildRequest, chunkLabel, citedFiles, interpret } from "../../src/decide.ts";
import type { Candidate } from "../../src/run.ts";
import type { ClassifierAnswer, ClassifierResponse } from "../../src/types.ts";

const chunk = (index: number, files: string[] = [], text = `text of chunk ${index}`): Chunk => ({
	index,
	start: index * 10,
	end: index * 10 + 10,
	text,
	files,
});
const segment = [chunk(0, ["src/a.ts"]), chunk(1, ["src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]), chunk(2)];
const candidate: Candidate = { entryId: "r1", toolName: "bash", args: { command: "rg foo" }, text: "x" };
const run = { question: "Where is foo?", answer: "In src/a.ts.", notes: "" };
const thresholds = { keepWholeThreshold: 0.7, focusWholeThreshold: 0.6, chunkKeepThreshold: 0.8, noneThreshold: 0.5 };

const bool = (probability: number): ClassifierAnswer => ({ type: "bool", probability });
const focus = (choice: string, probabilities: Record<string, number> = { [choice]: 0.9 }): ClassifierAnswer => ({
	type: "choice",
	choice,
	probabilities,
	confidence: probabilities[choice] ?? 0,
});
const response = (answers: Record<string, ClassifierAnswer>, stopReason: ClassifierResponse["stopReason"] = "stop"): ClassifierResponse => ({
	answers,
	stopReason,
});

test("buildRequest: state and one bool question per chunk", () => {
	const request = buildRequest(run, candidate, segment, 0, 1, 30);
	assert.deepEqual(Object.keys(request.state), ["situation", "user_question", "final_answer", "tool", "tool_arguments", "output_size", "chunks"]);
	assert.equal(request.state.user_question, "Where is foo?");
	assert.equal(request.state.final_answer, "In src/a.ts.");
	assert.equal(request.state.tool, "bash");
	assert.equal(request.state.tool_arguments, JSON.stringify({ command: "rg foo" }));
	assert.equal(request.state.output_size, "30 lines");
	assert.deepEqual(request.state.chunks, { chunk_1: "text of chunk 0", chunk_2: "text of chunk 1", chunk_3: "text of chunk 2" });

	assert.deepEqual(Object.keys(request.questions), ["keep_whole", "focus", "chunk_1", "chunk_2", "chunk_3"]);
	assert.equal(request.questions.keep_whole.type, "bool");
	for (const label of ["chunk_1", "chunk_2", "chunk_3"]) assert.equal(request.questions[label].type, "bool");
	const focusQuestion = request.questions.focus;
	assert.equal(focusQuestion.type, "choice");
	assert.ok(focusQuestion.type === "choice");
	assert.deepEqual(Object.keys(focusQuestion.criteria), ["whole", "none", "chunk_1", "chunk_2", "chunk_3"]);
	assert.equal(focusQuestion.criteria.chunk_1, "A few chunks are needed; chunk_1 is the most important of them");
	assert.equal(focusQuestion.criteria.chunk_3, "A few chunks are needed; chunk_3 is the most important of them");
	assert.equal(focusQuestion.criteria.whole, "Most of the tool output is needed: the answer draws on many of its chunks");
	assert.equal(focusQuestion.criteria.none, "Nothing in the tool output is needed any more");
	assert.equal(
		focusQuestion.instructions,
		"Does final_answer draw on most of the tool output, or does it rest on a few chunks? If a few, pick the most important chunk. If nothing in it matters any more, pick none.",
	);
	assert.doesNotMatch(JSON.stringify(request), /part \d of/);
});

test("buildRequest: notes, clipping, no args, segment wording", () => {
	const longAnswer = "A".repeat(10_000);
	const request = buildRequest({ question: "q", answer: longAnswer, notes: "thinking" }, { ...candidate, args: undefined }, segment.slice(1), 1, 3, 300);
	assert.equal(request.state.agent_notes_during_the_run, "thinking");
	assert.equal("tool_arguments" in request.state, false);
	assert.ok((request.state.final_answer as string).length < 6_100);
	assert.match(request.state.final_answer as string, /\[…\]/);
	assert.equal(request.state.output_size, "300 lines; this is part 2 of 3");
	assert.deepEqual(Object.keys(request.questions), ["keep_whole", "focus", "chunk_2", "chunk_3"]);
	assert.match(request.questions.keep_whole.instructions, /this part of the tool output/);
	const focusQuestion = request.questions.focus;
	assert.ok(focusQuestion.type === "choice");
	assert.equal(focusQuestion.criteria.none, "Nothing in this part of the tool output is needed any more");
	assert.equal(focusQuestion.criteria.whole, "Most of this part of the tool output is needed: the answer draws on many of its chunks");
	assert.match(focusQuestion.instructions, /draw on most of this part of the tool output/);
	assert.equal(chunkLabel(segment[2]), "chunk_3");
});

test("interpret: error stop reasons keep everything", () => {
	assert.deepEqual(interpret({ answers: {}, stopReason: "error", errorMessage: "boom" }, segment, thresholds), {
		kind: "keep-all",
		reason: "error",
		detail: "boom",
	});
	assert.equal(interpret(response({}, "aborted"), segment, thresholds).kind, "keep-all");
});

test("interpret: missing answers keep everything", () => {
	assert.deepEqual(interpret(response({ focus: focus("none") }), segment, thresholds), { kind: "keep-all", reason: "no-answer" });
	assert.deepEqual(interpret(response({ keep_whole: bool(0.1) }), segment, thresholds), { kind: "keep-all", reason: "no-answer" });
	assert.deepEqual(interpret(response({ keep_whole: bool(0.1), focus: bool(0.5) }), segment, thresholds), {
		kind: "keep-all",
		reason: "no-answer",
	});
});

test("interpret: keep_whole at the threshold keeps everything", () => {
	assert.deepEqual(interpret(response({ keep_whole: bool(0.7), focus: focus("chunk_1") }), segment, thresholds), {
		kind: "keep-all",
		reason: "whole-needed",
	});
});

test("interpret: focus=whole keeps everything", () => {
	assert.deepEqual(interpret(response({ keep_whole: bool(0.2), focus: focus("whole") }), segment, thresholds), {
		kind: "keep-all",
		reason: "whole-chosen",
	});
});

test("interpret: a weak focus=whole falls through to the per-chunk answers", () => {
	const decision = interpret(
		response({ keep_whole: bool(0.2), focus: focus("whole", { whole: 0.43, chunk_2: 0.41 }), chunk_1: bool(0.1), chunk_2: bool(0.96), chunk_3: bool(0.2) }),
		segment,
		thresholds,
	);
	assert.deepEqual(decision, { kind: "select", keep: new Set([1]), reason: "chunks" });
});

test("interpret: a weak focus=whole with no passing chunk keeps everything", () => {
	const decision = interpret(response({ keep_whole: bool(0.2), focus: focus("whole", { whole: 0.45, chunk_1: 0.4 }), chunk_1: bool(0.3) }), segment, thresholds);
	assert.deepEqual(decision, { kind: "keep-all", reason: "whole-chosen" });
});

test("interpret: focus chunk plus chunks passing their bool question", () => {
	const decision = interpret(
		response({ keep_whole: bool(0.2), focus: focus("chunk_1"), chunk_1: bool(0.1), chunk_2: bool(0.79), chunk_3: bool(0.8) }),
		segment,
		thresholds,
	);
	assert.deepEqual(decision, { kind: "select", keep: new Set([0, 2]), reason: "chunks" });
});

test("interpret: confident none with no chunk kept removes everything", () => {
	const decision = interpret(
		response({ keep_whole: bool(0.1), focus: focus("none", { none: 0.6, chunk_2: 0.3 }), chunk_1: bool(0.2), chunk_2: bool(0.3) }),
		segment,
		thresholds,
	);
	assert.deepEqual(decision, { kind: "select", keep: new Set(), reason: "none-needed" });
});

test("interpret: none with a passing chunk keeps that chunk", () => {
	const decision = interpret(response({ keep_whole: bool(0.1), focus: focus("none", { none: 0.9 }), chunk_3: bool(0.95) }), segment, thresholds);
	assert.deepEqual(decision, { kind: "select", keep: new Set([2]), reason: "chunks" });
});

test("interpret: unconfident none keeps the best chunk", () => {
	const decision = interpret(
		response({ keep_whole: bool(0.1), focus: focus("none", { none: 0.4, chunk_1: 0.1, chunk_2: 0.35, whole: 0.15 }) }),
		segment,
		thresholds,
	);
	assert.deepEqual(decision, { kind: "select", keep: new Set([1]), reason: "chunks" });
});

test("citedFiles matches paths and basenames", () => {
	const chunks = [chunk(0, ["src/core/session.ts"]), chunk(1, ["lib/util.ts"]), chunk(2, ["a.ts"]), chunk(3, [])];
	assert.deepEqual(citedFiles("See src/core/session.ts for details.", chunks), new Set([0]));
	assert.deepEqual(citedFiles("It is in `util.ts`.", chunks), new Set([1]));
	assert.deepEqual(citedFiles("util.ts and session.ts", chunks), new Set([0, 1]));
	assert.deepEqual(citedFiles("Look at /abs/path/lib/util.ts:12", chunks), new Set([1]));
	assert.deepEqual(citedFiles("nothing here", chunks), new Set());
});

test("citedFiles ignores substrings of other names", () => {
	const chunks = [chunk(0, ["src/util.ts"]), chunk(1, ["src/session.ts"]), chunk(2, ["a.ts"])];
	assert.deepEqual(citedFiles("myutil.ts", chunks), new Set());
	assert.deepEqual(citedFiles("util.tsx", chunks), new Set());
	assert.deepEqual(citedFiles("src/util.tsx", chunks), new Set());
	assert.deepEqual(citedFiles("old-session.ts", chunks), new Set());
	assert.deepEqual(citedFiles("data.ts", chunks), new Set());
	// Sentence punctuation after a name still counts.
	assert.deepEqual(citedFiles("See session.ts.", chunks), new Set([1]));
	// Basenames shorter than 4 characters only match as paths.
	assert.deepEqual(citedFiles("x.c is short", [chunk(0, ["src/x.c"])]), new Set());
	assert.deepEqual(citedFiles("in src/x.c", [chunk(0, ["src/x.c"])]), new Set([0]));
});
