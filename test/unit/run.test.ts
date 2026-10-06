import assert from "node:assert/strict";
import { test } from "node:test";
import { MARKER } from "../../src/render.ts";
import { collectRun } from "../../src/run.ts";
import { assistant, entry, lines, toolResult, user } from "./fixtures.ts";

const options = { minResultChars: 100, excludeTools: ["edit", "write"] };
const big = lines(10);

test("collectRun returns undefined without a user message", () => {
	assert.equal(collectRun([], options), undefined);
	assert.equal(collectRun([assistant("hi"), toolResult("c1", "bash", big)], options), undefined);
	// A user message without text does not start a run.
	assert.equal(collectRun([entry({ role: "user", content: [{ type: "image", data: "x" }] })], options), undefined);
});

test("collectRun extracts question, answer, notes and candidates", () => {
	const entries = [
		user("old question"),
		assistant("old answer"),
		user("Where is foo defined?"),
		assistant("Let me search.", [{ id: "c1", name: "bash", arguments: { command: "rg foo" } }]),
		toolResult("c1", "bash", big, "r1"),
		assistant("Now reading.", [
			{ id: "c2", name: "read", arguments: { path: "src/a.ts" } },
			{ id: "c3", name: "read", arguments: { path: "src/b.ts" } },
		]),
		toolResult("c3", "read", `${big}\nB`, "r3"),
		toolResult("c2", "read", `${big}\nA`, "r2"),
		assistant("foo is defined in src/a.ts."),
	];
	const run = collectRun(entries, options);
	assert.ok(run);
	assert.equal(run.question, "Where is foo defined?");
	assert.equal(run.answer, "foo is defined in src/a.ts.");
	assert.equal(run.notes, "Let me search.\n\nNow reading.");
	assert.equal(run.toolResults, 3);
	assert.deepEqual(
		run.candidates.map((c) => [c.entryId, c.toolName, c.args]),
		[
			["r1", "bash", { command: "rg foo" }],
			["r3", "read", { path: "src/b.ts" }],
			["r2", "read", { path: "src/a.ts" }],
		],
	);
	assert.equal(run.candidates[1].text, `${big}\nB`);
});

test("collectRun skips errors, images, excluded tools, short and distilled results", () => {
	const entries = [
		user("q"),
		assistant("", [
			{ id: "a", name: "bash", arguments: {} },
			{ id: "b", name: "read", arguments: {} },
			{ id: "c", name: "edit", arguments: {} },
			{ id: "d", name: "bash", arguments: {} },
			{ id: "e", name: "bash", arguments: {} },
			{ id: "f", name: "bash", arguments: {} },
		]),
		toolResult("a", "bash", big, "error", { isError: true }),
		entry({ role: "toolResult", toolCallId: "b", toolName: "read", content: [{ type: "text", text: big }, { type: "image", data: "x" }] }, "image"),
		toolResult("c", "edit", big, "excluded"),
		toolResult("d", "bash", "short", "short"),
		toolResult("e", "bash", `${MARKER} Distilled the output of bash\n${big}`, "distilled"),
		toolResult("f", "bash", big, "ok"),
		assistant("done"),
	];
	const run = collectRun(entries, options);
	assert.ok(run);
	assert.equal(run.toolResults, 6);
	assert.deepEqual(
		run.candidates.map((c) => c.entryId),
		["ok"],
	);
});

test("collectRun falls back to the tool call name when the result has no toolName", () => {
	const entries = [
		user("q"),
		assistant("", [{ id: "c1", name: "write", arguments: {} }, { id: "c2", name: "grep", arguments: { pattern: "x" } }]),
		entry({ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: big }], isError: false }, "w"),
		entry({ role: "toolResult", toolCallId: "c2", content: big, isError: false }, "g"),
	];
	const run = collectRun(entries, options);
	assert.ok(run);
	assert.deepEqual(
		run.candidates.map((c) => [c.entryId, c.toolName, c.args]),
		[["g", "grep", { pattern: "x" }]],
	);
	assert.equal(run.answer, "");
});

test("a steering user message mid-run starts a new span", () => {
	const entries = [
		user("first question"),
		assistant("searching", [{ id: "c1", name: "bash", arguments: {} }]),
		toolResult("c1", "bash", big, "before"),
		user("actually, look at bar"),
		assistant("ok", [{ id: "c2", name: "bash", arguments: {} }]),
		toolResult("c2", "bash", big, "after"),
		assistant("bar is in b.ts"),
	];
	const run = collectRun(entries, options);
	assert.ok(run);
	assert.equal(run.question, "actually, look at bar");
	assert.equal(run.answer, "bar is in b.ts");
	assert.equal(run.notes, "ok");
	assert.deepEqual(
		run.candidates.map((c) => c.entryId),
		["after"],
	);
});

test("collectRun ignores entries projected to several messages", () => {
	const merged = {
		sourceEntry: { id: "m", type: "compaction" },
		messages: [
			{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: big },
			{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: big },
		],
	};
	const run = collectRun([user("q"), merged], options);
	assert.ok(run);
	assert.equal(run.toolResults, 0);
	assert.equal(run.candidates.length, 0);
});
