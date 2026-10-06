import assert from "node:assert/strict";
import { test } from "node:test";
import { MARKER } from "../../src/render.ts";
import {
	collectRun,
	HISTORY_ASSISTANT_LIMIT,
	HISTORY_FIRST_REQUEST_LIMIT,
	HISTORY_SUMMARY_LIMIT,
	HISTORY_USER_LIMIT,
	hasHistory,
	NO_TEXT_QUESTION,
} from "../../src/run.ts";
import { assistant, entry, lines, toolResult, user } from "./fixtures.ts";

const options = { minResultChars: 100, excludeTools: ["edit", "write"], historyExchanges: 3 };
const big = lines(10);

test("collectRun returns undefined without a user message", () => {
	assert.equal(collectRun([], options), undefined);
	assert.equal(collectRun([assistant("hi"), toolResult("c1", "bash", big)], options), undefined);
});

test("an image-only prompt is the run boundary; no older question is used", () => {
	const entries = [
		user("old text question"),
		assistant("old answer", [{ id: "c0", name: "bash", arguments: {} }]),
		toolResult("c0", "bash", big, "old"),
		entry({ role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] }, "img"),
		assistant("", [{ id: "c1", name: "bash", arguments: {} }]),
		toolResult("c1", "bash", big, "new"),
		assistant("The screenshot shows an error."),
	];
	const run = collectRun(entries, options);
	assert.ok(run);
	assert.equal(run.question, NO_TEXT_QUESTION);
	assert.equal(run.answer, "The screenshot shows an error.");
	assert.deepEqual(
		run.candidates.map((c) => c.entryId),
		["new"],
	);
	const only = collectRun([entry({ role: "user", content: [{ type: "image", data: "x" }] })], options);
	assert.equal(only?.question, NO_TEXT_QUESTION);
});

test("results another extension already edited are skipped", () => {
	const raw = { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: big }], isError: false };
	const edited = { ...raw, content: [{ type: "text", text: `${big}\n[note added by another extension]` }] };
	const entries = [
		user("q"),
		assistant("", [{ id: "c1", name: "bash", arguments: {} }, { id: "c2", name: "bash", arguments: {} }]),
		{ sourceEntry: { id: "edited", type: "message", message: raw }, messages: [edited] },
		toolResult("c2", "bash", big, "plain"),
	];
	const run = collectRun(entries, options);
	assert.ok(run);
	assert.equal(run.toolResults, 2);
	assert.deepEqual(
		run.candidates.map((c) => c.entryId),
		["plain"],
	);
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

test("collectRun includes error results when distillErrors is set", () => {
	const entries = [
		user("q"),
		assistant("", [{ id: "a", name: "bash", arguments: {} }, { id: "b", name: "bash", arguments: {} }]),
		toolResult("a", "bash", big, "failed", { isError: true }),
		toolResult("b", "bash", big, "ok"),
		assistant("done"),
	];
	const run = collectRun(entries, { ...options, distillErrors: true });
	assert.deepEqual(
		run?.candidates.map((c) => [c.entryId, c.isError ?? false]),
		[
			["failed", true],
			["ok", false],
		],
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

// --- history -----------------------------------------------------------------------------------

/** Pi's compaction/branch summary messages carry `summary`, not `content`. */
const summaryEntry = (role: "compactionSummary" | "branchSummary", summary: string) =>
	({ sourceEntry: { id: `s-${role}`, type: role === "compactionSummary" ? "compaction" : "branch_summary" }, messages: [{ role, summary } as never] });

const currentRun = [
	user("current question", "cur"),
	assistant("", [{ id: "cx", name: "bash", arguments: {} }]),
	toolResult("cx", "bash", big, "cur-r"),
	assistant("current answer"),
];

test("history: last N exchanges, oldest first, tool traffic excluded", () => {
	const entries = [
		user("first request"),
		assistant("ack 1"),
		user("second"),
		assistant("looking", [{ id: "c1", name: "bash", arguments: {} }]),
		toolResult("c1", "bash", big),
		assistant("second answer"),
		user("third"),
		assistant("third answer"),
		user("fourth"),
		assistant("", [{ id: "c2", name: "bash", arguments: {} }]),
		toolResult("c2", "bash", big),
		...currentRun,
	];
	const run = collectRun(entries, options);
	assert.ok(run);
	assert.deepEqual(run.history, {
		firstRequest: "first request",
		exchanges: [
			{ user: "second", assistant: "second answer" },
			{ user: "third", assistant: "third answer" },
			{ user: "fourth", assistant: "" },
		],
	});
	assert.equal(run.question, "current question");
	assert.equal(run.answer, "current answer");
	assert.equal(JSON.stringify(run.history).includes("line 1"), false, "no tool output in history");
});

test("history: firstRequest only when not already among the exchanges", () => {
	const entries = [user("first request"), assistant("ok"), user("second"), assistant("ok 2"), ...currentRun];
	const run = collectRun(entries, options);
	assert.deepEqual(run?.history, {
		exchanges: [
			{ user: "first request", assistant: "ok" },
			{ user: "second", assistant: "ok 2" },
		],
	});
	// The first run of a session has no history at all.
	const first = collectRun(currentRun, options);
	assert.deepEqual(first?.history, { exchanges: [] });
	assert.equal(hasHistory(first?.history), false);
});

test("history: latest compaction or branch summary before the run", () => {
	const entries = [
		summaryEntry("compactionSummary", "old compaction summary"),
		user("after compaction"),
		assistant("answer a"),
		summaryEntry("branchSummary", "branch summary"),
		user("on the branch"),
		assistant("answer b"),
		...currentRun,
	];
	const run = collectRun(entries, options);
	assert.equal(run?.history?.summary, "branch summary");
	assert.deepEqual(
		run?.history?.exchanges.map((e) => e.user),
		["after compaction", "on the branch"],
	);
	const onlyCompaction = collectRun([summaryEntry("compactionSummary", "the summary"), ...currentRun], options);
	assert.deepEqual(onlyCompaction?.history, { summary: "the summary", exchanges: [] });
	assert.equal(hasHistory(onlyCompaction?.history), true);
});

test("history: image-only prompts and steering messages", () => {
	const entries = [
		user("first request"),
		assistant("ok"),
		entry({ role: "user", content: [{ type: "image", data: "x" }] }),
		assistant("I see a stack trace", [{ id: "c1", name: "bash", arguments: {} }]),
		toolResult("c1", "bash", big),
		// A steering message mid-run starts a new exchange.
		user("focus on the parser"),
		assistant("the parser fails on line 3"),
		...currentRun,
	];
	const run = collectRun(entries, { ...options, historyExchanges: 2 });
	assert.deepEqual(run?.history, {
		firstRequest: "first request",
		exchanges: [
			{ user: NO_TEXT_QUESTION, assistant: "I see a stack trace" },
			{ user: "focus on the parser", assistant: "the parser fails on line 3" },
		],
	});
	// An image-only first prompt is not repeated as firstRequest.
	const imageFirst = collectRun(
		[entry({ role: "user", content: [{ type: "image", data: "x" }] }), assistant("a"), user("b"), assistant("c"), ...currentRun],
		{ ...options, historyExchanges: 1 },
	);
	assert.deepEqual(imageFirst?.history, { exchanges: [{ user: "b", assistant: "c" }] });
});

test("history: every part is clipped", () => {
	const entries = [
		summaryEntry("compactionSummary", "S".repeat(10_000)),
		user("F".repeat(10_000)),
		assistant("x"),
		user("U".repeat(10_000)),
		assistant("first text"),
		assistant("A".repeat(10_000)),
		...currentRun,
	];
	const history = collectRun(entries, { ...options, historyExchanges: 1 })?.history;
	assert.ok(history?.summary && history.firstRequest);
	const within = (text: string, limit: number) => text.length <= limit + 5 && text.length >= limit && text.includes("\n[…]\n");
	assert.ok(within(history.summary, HISTORY_SUMMARY_LIMIT), `${history.summary.length}`);
	assert.ok(within(history.firstRequest, HISTORY_FIRST_REQUEST_LIMIT));
	assert.ok(within(history.exchanges[0].user, HISTORY_USER_LIMIT));
	assert.ok(within(history.exchanges[0].assistant, HISTORY_ASSISTANT_LIMIT));
	assert.ok(history.exchanges[0].assistant.startsWith("AAA"), "the LAST assistant text of the exchange");
});

test("history: historyExchanges 0 sends nothing, not even the summary", () => {
	const entries = [summaryEntry("compactionSummary", "summary"), user("first"), assistant("a"), user("second"), assistant("b"), ...currentRun];
	const run = collectRun(entries, { ...options, historyExchanges: 0 });
	assert.deepEqual(run?.history, { exchanges: [] });
	assert.equal(hasHistory(run?.history), false);
	assert.equal(run?.candidates.length, 1);
});

test("collectRun skips results judged at a mid-run checkpoint", () => {
	const entries = [
		user("q"),
		assistant("", [{ id: "c1", name: "bash", arguments: {} }]),
		toolResult("c1", "bash", big, "judged"),
		assistant("", [{ id: "c2", name: "bash", arguments: {} }]),
		toolResult("c2", "bash", big, "fresh"),
		assistant("done"),
	];
	const run = collectRun(entries, options, new Set(["judged"]));
	assert.deepEqual(
		run?.candidates.map((c) => c.entryId),
		["fresh"],
	);
	assert.equal(run?.toolResults, 2);
	// Candidates carry only the public fields.
	assert.deepEqual(Object.keys(run?.candidates[0] ?? {}).sort(), ["args", "entryId", "text", "toolName"]);
});
