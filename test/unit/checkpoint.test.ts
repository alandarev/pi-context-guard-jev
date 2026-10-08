import assert from "node:assert/strict";
import { test } from "node:test";
import {
	anthropicRewriteChars,
	BREAK_EVEN_FACTOR,
	cacheAnchors,
	exchangeMemo,
	type WrittenEntry,
	charsFrom,
	collectCheckpoint,
	contextChars,
	laterCallsFor,
	memoFromBranch,
	normalizeCommand,
	paysOff,
	pendingEdits,
	refreshOnReadThrough,
	runBaseline,
	recentNotes,
	supersededBy,
	wasJudged,
} from "../../src/checkpoint.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { MARKER } from "../../src/render.ts";
import { collectSmall } from "../../src/items.ts";
import type { ToolCallInfo } from "../../src/run.ts";
import { assistant, lines, toolResult, user } from "./fixtures.ts";

const options = { ...DEFAULT_CONFIG, minResultChars: 100, midRunMinAgeTurns: 2 };
const big = lines(20);

/** A run with one tool call per turn: turn i calls `calls[i]`, result id `r<i>`. */
function run(calls: { name: string; args: Record<string, unknown>; text?: string; note?: string }[], question = "Fix the tests") {
	return [
		user("earlier question", "u0"),
		assistant("earlier answer", [], "a0"),
		user(question, "u1"),
		...calls.flatMap((call, i) => [
			assistant(call.note ?? "", [{ id: `c${i}`, name: call.name, arguments: call.args }], `a${i + 1}`),
			toolResult(`c${i}`, call.name, call.text ?? big, `r${i}`),
		]),
	];
}

test("collectCheckpoint: only outputs at least midRunMinAgeTurns old are eligible", () => {
	const entries = run([
		{ name: "bash", args: { command: "npm test" } },
		{ name: "read", args: { path: "src/a.js" } },
		{ name: "bash", args: { command: "rg foo" } },
		{ name: "bash", args: { command: "ls" }, text: "short" },
	]);
	const info = collectCheckpoint(entries, options, new Set());
	assert.ok(info);
	assert.equal(info.currentTurn, 3);
	// Turns 0 and 1 are ≥ 2 turns older than turn 3; turn 2 is too young.
	assert.deepEqual(
		info.candidates.map((c) => [c.entryId, c.turn]),
		[
			["r0", 0],
			["r1", 1],
		],
	);
	assert.equal(info.pendingChars, big.length * 2);
	assert.equal(info.question, "Fix the tests");
	assert.deepEqual(info.history.exchanges, [{ user: "earlier question", assistant: "earlier answer" }]);
});

test("collectCheckpoint: the memo, candidate rules and already-distilled results", () => {
	const entries = run([
		{ name: "bash", args: { command: "a" } },
		{ name: "edit", args: { path: "x" } },
		{ name: "bash", args: { command: "b" }, text: `${MARKER} distilled\n${big}` },
		{ name: "bash", args: { command: "c" } },
		{ name: "bash", args: { command: "d" } },
		{ name: "bash", args: { command: "e" } },
	]);
	const info = collectCheckpoint(entries, options, new Set(["r0"]));
	assert.deepEqual(
		info?.candidates.map((c) => c.entryId),
		["r3"],
	);
	assert.equal(collectCheckpoint([], options, new Set()), undefined);
});

test("collectCheckpoint: later calls, notes and superseded outputs", () => {
	const entries = run([
		{ name: "bash", args: { command: "npm  test" }, note: "Running the suite." },
		{ name: "read", args: { path: "./src/a.js" } },
		{ name: "edit", args: { path: "src/a.js" }, note: "Fixing a.js." },
		{ name: "bash", args: { command: "npm test" } },
		{ name: "bash", args: { command: "git diff" }, note: "Checking the diff." },
	]);
	const info = collectCheckpoint(entries, options, new Set());
	assert.ok(info);
	assert.equal(info.latest, "Checking the diff.");
	assert.equal(info.notes, "Running the suite.\n\nFixing a.js.");
	const [log, read] = info.candidates;
	assert.equal(log.superseded, "the same command ran again later (3 turns later)");
	assert.equal(read.superseded, "this file was changed after this read (edit src/a.js, 1 turn later)");
	assert.deepEqual(log.laterCalls, ["read ./src/a.js", "edit src/a.js", "bash `npm test`", "bash `git diff`"]);
});

test("supersededBy: reads, commands, other tools", () => {
	const call = (name: string, args: Record<string, unknown>, turn: number): ToolCallInfo => ({ name, args, turn });
	const read = { toolName: "read", args: { path: "a.ts", offset: 1, limit: 100 }, turn: 1 };
	assert.equal(supersededBy(read, [call("read", { path: "a.ts", offset: 101, limit: 100 }, 2)]), undefined);
	assert.equal(supersededBy(read, [call("read", { path: "./a.ts", offset: 1, limit: 100 }, 3)]), "the same file range was read again later (read ./a.ts, 2 turns later)");
	assert.equal(supersededBy(read, [call("write", { path: "a.ts" }, 2)]), "this file was changed after this read (write a.ts, 1 turn later)");
	// Calls in the same or earlier turns do not count.
	assert.equal(supersededBy(read, [call("edit", { path: "a.ts" }, 1), call("edit", { path: "a.ts" }, 0)]), undefined);
	const bash = { toolName: "bash", args: { command: "npm test 2>&1" }, turn: 0 };
	assert.equal(supersededBy(bash, [call("bash", { command: "npm  test" }, 4)]), "the same command ran again later (4 turns later)");
	assert.equal(supersededBy(bash, [call("bash", { command: "npm test | head" }, 4)]), undefined);
	const grep = { toolName: "grep", args: { pattern: "x" }, turn: 0 };
	assert.equal(supersededBy(grep, [call("grep", { pattern: "x" }, 2)]), "the same grep call ran again later (2 turns later)");
	assert.equal(normalizeCommand("  npm   test 2>&1 "), "npm test");
});

test("laterCallsFor: oldest first, long lists keep both ends", () => {
	const calls = Array.from({ length: 40 }, (_, i): ToolCallInfo => ({ name: "bash", args: { command: `c${i}` }, turn: i }));
	assert.deepEqual(laterCallsFor(37, calls), ["bash `c38`", "bash `c39`"]);
	const all = laterCallsFor(-1, calls, 6);
	assert.deepEqual(all, ["bash `c0`", "bash `c1`", "bash `c2`", "[… 34 more calls …]", "bash `c37`", "bash `c38`", "bash `c39`"]);
});

/** Session entries of a run (as on the branch), plus helpers to append edits. */
const branchOf = (entries: ReturnType<typeof run>): Record<string, any>[] => entries.map((e) => e.sourceEntry);
const edit = (targetId: string) => ({ type: "context_edit", targetId });

const MODEL = "anthropic/claude-sonnet-5-5";
const NOW = 1_000_000;
/** A log entry: the request sent when `leafId` was the last branch entry wrote an entry at `entryId`. */
const wrote = (entryId: string, leafId: string, extra: Partial<WrittenEntry> = {}): WrittenEntry => ({ entryId, leafId, model: MODEL, time: NOW - 60_000, ...extra });
const fourTurns = () =>
	branchOf(
		run([
			{ name: "bash", args: { command: "a" } },
			{ name: "bash", args: { command: "b" } },
			{ name: "bash", args: { command: "c" } },
			{ name: "bash", args: { command: "d" } },
		]),
	);

test("cacheAnchors: no pending edits returns at once", () => {
	assert.deepEqual(cacheAnchors(fourTurns(), [wrote("r1", "r1")], MODEL, NOW), {});
	assert.deepEqual(cacheAnchors([], [], MODEL, NOW), {});
});

test("cacheAnchors: read only at an entry this process wrote; write at the first edited batch", () => {
	const branch = [...fourTurns(), edit("r2"), edit("r1")];
	// Empty log (pinning was off, another process, or a reload): no read point, the question pin is the floor.
	assert.deepEqual(cacheAnchors(branch, [], MODEL, NOW), { write: "c1" });
	// Logged rolling entries: the latest one before the first edit (r1) is r0.
	assert.deepEqual(cacheAnchors(branch, [wrote("r0", "r0"), wrote("r2", "r2")], MODEL, NOW), { read: "c0", write: "c1" });
	// The run's first output edited: nothing before it can be read.
	assert.deepEqual(cacheAnchors([...fourTurns(), edit("r0")], [wrote("r0", "r0")], MODEL, NOW), { write: "c0" });
});

test("cacheAnchors: a log entry is trusted only for the same model, within the TTL, still on the branch", () => {
	const branch = [...fourTurns(), edit("r2")];
	assert.deepEqual(cacheAnchors(branch, [wrote("r1", "r1", { model: "anthropic/claude-opus-5-5" })], MODEL, NOW), { write: "c2" });
	assert.deepEqual(cacheAnchors(branch, [wrote("r1", "r1", { time: NOW - 5 * 60_000 - 1 })], MODEL, NOW), { write: "c2" });
	assert.deepEqual(cacheAnchors(branch, [wrote("r1", "r1", { time: NOW - 5 * 60_000 })], MODEL, NOW), { read: "c1", write: "c2" });
	// Written on another branch (/tree): the entry or the leaf at write time is gone.
	assert.deepEqual(cacheAnchors(branch, [wrote("rX", "r1"), wrote("r1", "leafX")], MODEL, NOW), { write: "c2" });
});

test("cacheAnchors: later edits at or before the prefix, and compaction, invalidate a log entry", () => {
	// r1's entry was written at leaf r1; afterwards a checkpoint edited r0 (inside the prefix).
	const branch = [...fourTurns().slice(0, 7), edit("r0"), ...fourTurns().slice(7), edit("r2")];
	assert.deepEqual(cacheAnchors(branch, [wrote("r1", "r1")], MODEL, NOW), { write: "c2" });
	// An edit after the prefix does not touch it.
	const after = [...fourTurns(), edit("r3"), { type: "message", id: "a9", message: { role: "assistant" } }, edit("r2")];
	assert.deepEqual(cacheAnchors(after, [wrote("r1", "r1")], MODEL, NOW), { read: "c1", write: "c2" });
	// Compaction since the write: never trusted.
	const compacted = [...fourTurns().slice(0, 7), { type: "compaction", id: "cmp" }, ...fourTurns().slice(7), edit("r2")];
	assert.deepEqual(cacheAnchors(compacted, [wrote("r1", "r1")], MODEL, NOW), { write: "c2" });
});

test("cacheAnchors: a batch of parallel tool results is never split", () => {
	const entries = [
		user("q", "u1"),
		assistant("", [{ id: "p1", name: "bash", arguments: {} }, { id: "p2", name: "bash", arguments: {} }], "a1"),
		toolResult("p1", "bash", big, "rp1"),
		toolResult("p2", "bash", big, "rp2"),
		assistant("", [{ id: "q1", name: "read", arguments: {} }, { id: "q2", name: "read", arguments: {} }], "a2"),
		toolResult("q1", "read", big, "rq1"),
		toolResult("q2", "read", big, "rq2"),
		assistant("", [{ id: "z1", name: "read", arguments: {} }], "a3"),
		toolResult("z1", "read", big, "rz1"),
	];
	const branch = entries.map((e) => e.sourceEntry as Record<string, any>);
	assert.deepEqual(cacheAnchors([...branch, edit("rq1")], [wrote("rp2", "rp2")], MODEL, NOW), { read: "p2", write: "q2" });
});

test("pendingEdits: edits after the last answered request only", () => {
	const msg = (role: string, stopReason?: string) => ({ type: "message", message: { role, ...(stopReason ? { stopReason } : {}) } });
	const edit = (targetId: string) => ({ type: "context_edit", targetId });
	assert.deepEqual([...pendingEdits([msg("user"), msg("assistant"), edit("r1"), edit("r2"), { type: "custom" }])], ["r2", "r1"]);
	// Run-end edits followed by the next prompt.
	assert.deepEqual([...pendingEdits([msg("assistant"), edit("r1"), msg("user")])], ["r1"]);
	// Once a request after them was answered, they are no longer pending.
	assert.deepEqual([...pendingEdits([edit("r1"), msg("assistant")])], []);
	// A failed response does not count: the retry repeats the request.
	assert.deepEqual([...pendingEdits([msg("assistant"), edit("r1"), msg("assistant", "error")])], ["r1"]);
	assert.deepEqual([...pendingEdits([])], []);
});

test("memoFromBranch: mid-run records only; unanswered results are asked again", () => {
	const record = (phase: string | undefined, results: { entryId: string; reason: string }[]) => ({
		type: "custom",
		customType: "context-guard",
		data: { v: 1, ...(phase ? { phase } : {}), results },
	});
	const judged = memoFromBranch(
		[
			record("mid-run", [{ entryId: "a", reason: "chunks" }, { entryId: "b", reason: "timeout" }, { entryId: "c", reason: "whole-needed" }]),
			record(undefined, [{ entryId: "d", reason: "chunks" }]),
			record("run-end", [{ entryId: "e", reason: "chunks" }]),
			{ type: "custom", customType: "other", data: { v: 1, phase: "mid-run", results: [{ entryId: "f", reason: "chunks" }] } },
			record("mid-run", [{ entryId: "g", reason: "error" }, { entryId: "h", reason: "not-worth" }]),
		],
		"context-guard",
	);
	assert.deepEqual([...judged], ["a", "c", "h"]);
	assert.equal(wasJudged({ reason: "not-worth" }), true);
	assert.equal(wasJudged({ reason: "error,timeout" }), false);
});

test("recentNotes keeps the end", () => {
	assert.equal(recentNotes("short", 10), "short");
	const clipped = recentNotes("a".repeat(50) + "END", 20);
	assert.ok(clipped.startsWith("[…]\n") && clipped.endsWith("END"));
	assert.ok(clipped.length <= 20);
});

test("break-even rule and context size", () => {
	// 60k pending after 20 turns = 1.2M ≥ 13 × 90k (OpenAI, whole context) but < 16 × 90k (Anthropic).
	assert.equal(paysOff(60_000, 20, 90_000, BREAK_EVEN_FACTOR.full), true);
	assert.equal(paysOff(60_000, 20, 90_000, BREAK_EVEN_FACTOR.prefix), false);
	assert.equal(paysOff(60_000, 0, 1_000, BREAK_EVEN_FACTOR.prefix), true);
	const entries = run([
		{ name: "bash", args: { command: "a" }, text: "x".repeat(100) },
		{ name: "bash", args: { command: "b" }, text: "y".repeat(200) },
	]);
	const total = contextChars(entries);
	assert.ok(total > 300);
	const fromR1 = charsFrom(entries, new Set(["r1"]));
	assert.ok(fromR1 >= 200 && fromR1 < total);
	assert.equal(charsFrom(entries, new Set(["nope"])), 0);
	// Compaction and branch summaries are model-visible too.
	const summary = { sourceEntry: { id: "s", type: "compaction" }, messages: [{ role: "compactionSummary", summary: "z".repeat(500) } as never] };
	assert.equal(contextChars([summary, ...entries]), total + 500);
});

// --- refresh on read-through, rewrite estimate -------------------------------------------------

/** A run with outputs of known size: turn i's result is `size` chars. */
const sized = (turns: number, size = 4_000) =>
	run(Array.from({ length: turns }, (_, i) => ({ name: "bash", args: { command: `c${i}` }, text: "x".repeat(size) })));

test("refreshOnReadThrough: a read clearly beyond the entry refreshes it, and it is trusted after 5 minutes", () => {
	const entries = sized(6);
	const branch = branchOf(entries);
	// r1's entry, written 4 minutes before the request; the request read 30k tokens.
	const log = [wrote("r1", "r1", { time: NOW - 4 * 60_000 })];
	// Prefix from the question to r1: two 4k outputs plus calls ≈ 8.2k chars → 8.2k / 1.5 ≈ 5.5k tokens.
	assert.deepEqual(refreshOnReadThrough(entries, branch, log, MODEL, NOW, 30_000, 6_000), ["r1"]);
	assert.equal(log[0].time, NOW);
	// Six minutes after the original write, the refreshed entry is still trusted.
	const later = [...branch, edit("r3")];
	assert.deepEqual(cacheAnchors(later, log, MODEL, NOW + 2 * 60_000), { read: "c1", write: "c3" });
	assert.deepEqual(cacheAnchors(later, [wrote("r1", "r1", { time: NOW - 4 * 60_000 })], MODEL, NOW + 2 * 60_000), { write: "c3" });
});

test("refreshOnReadThrough: no refresh for another model, a miss, a read that stops short, or a changed prefix", () => {
	const entries = sized(6);
	const branch = branchOf(entries);
	const fresh = () => [wrote("r1", "r1", { time: NOW - 4 * 60_000 })];
	assert.deepEqual(refreshOnReadThrough(entries, branch, fresh(), "anthropic/claude-opus-5-5", NOW, 30_000, 6_000), []);
	assert.deepEqual(refreshOnReadThrough(entries, branch, fresh(), MODEL, NOW, 0, 6_000), []);
	// Only the system prompt and question were read (cacheRead ≤ baseline).
	assert.deepEqual(refreshOnReadThrough(entries, branch, fresh(), MODEL, NOW, 6_000, 6_000), []);
	// Read beyond the baseline, but not as far as the entry with the safety margin.
	assert.deepEqual(refreshOnReadThrough(entries, branch, fresh(), MODEL, NOW, 9_000, 6_000), []);
	// No baseline yet (the run's first response is not on the branch): no refresh.
	assert.deepEqual(refreshOnReadThrough(entries, branch, fresh(), MODEL, NOW, 30_000, 0), []);
	// An edit at or before the entry since it was logged.
	assert.deepEqual(refreshOnReadThrough(entries, [...branch, edit("r0")], fresh(), MODEL, NOW, 30_000, 6_000), []);
	// A compaction since it was logged.
	assert.deepEqual(refreshOnReadThrough(entries, [...branch, { type: "compaction", id: "cmp" }], fresh(), MODEL, NOW, 30_000, 6_000), []);
	// An edit after the entry does not matter.
	assert.deepEqual(refreshOnReadThrough(entries, [...branch, edit("r4")], fresh(), MODEL, NOW, 30_000, 6_000), ["r1"]);
});

test("runBaseline: the full input of the run's first answered request", () => {
	const usage = (input: number, cacheRead: number, cacheWrite: number) => ({ input, cacheRead, cacheWrite });
	const branch = [
		{ type: "message", id: "u1", message: { role: "user" } },
		{ type: "message", id: "a1", message: { role: "assistant", usage: usage(4, 1_431, 4_400) } },
		{ type: "message", id: "a2", message: { role: "assistant", usage: usage(2, 9_000, 100) } },
	];
	assert.equal(runBaseline(branch), 5_835);
	assert.equal(runBaseline(branch.slice(0, 1)), undefined);
	assert.equal(runBaseline([]), undefined);
});

test("anthropicRewriteChars: from the trusted read point, else from the question", () => {
	const entries = sized(6);
	const branch = branchOf(entries);
	const candidates = new Set(["r3", "r4"]);
	const afterQuestion = contextChars(entries.slice(3));
	// No trusted entry: the rewrite starts after the question (the floor), not at the first candidate.
	assert.equal(anthropicRewriteChars(entries, branch, [], MODEL, NOW, candidates), afterQuestion);
	assert.ok(afterQuestion > charsFrom(entries, candidates));
	// A trusted entry at r2: the rewrite starts after it.
	const fromR2 = anthropicRewriteChars(entries, branch, [wrote("r2", "r2")], MODEL, NOW, candidates);
	assert.equal(fromR2, contextChars(entries.slice(entries.findIndex((e) => e.sourceEntry.id === "r2") + 1)));
	assert.ok(fromR2 < afterQuestion);
	// The same entry from another model, or expired: back to the question.
	assert.equal(anthropicRewriteChars(entries, branch, [wrote("r2", "r2", { model: "x/y" })], MODEL, NOW, candidates), afterQuestion);
	assert.equal(anthropicRewriteChars(entries, branch, [wrote("r2", "r2", { time: NOW - 10 * 60_000 })], MODEL, NOW, candidates), afterQuestion);
});

test("collectCheckpoint and collectSmall (mid-run): recall outputs are never eligible", () => {
	const entries = run([
		{ name: "recall", args: { entryId: "x" } },
		{ name: "recall", args: { entryId: "y" }, text: "z".repeat(1_000) },
		{ name: "bash", args: { command: "a" } },
		{ name: "bash", args: { command: "b" } },
		{ name: "bash", args: { command: "c" } },
	]);
	const info = collectCheckpoint(entries, options, new Set());
	assert.ok(info);
	assert.deepEqual(
		info.candidates.map((c) => c.entryId),
		["r2"],
	);
	const span = entries.slice(3);
	const small = { ...options, minResultChars: 1_000_000, smallResultMinChars: 10 };
	assert.deepEqual(
		collectSmall(span, small, new Set(), 2).map((s) => s.entryId),
		["r2"],
	);
	// At run end they are judged like any other output.
	assert.deepEqual(
		collectSmall(span, small, new Set()).map((s) => s.entryId),
		["r0", "r1", "r2", "r3", "r4"],
	);
});

/** `sized(6)` with a steering message after r2 (before a3). */
const steered = () => {
	const entries = sized(6);
	const at = entries.findIndex((e) => e.sourceEntry.id === "a3");
	return [...entries.slice(0, at), user("also check the parser", "s1"), ...entries.slice(at)];
};

test("collectCheckpoint: outputs from before a steering message stay eligible; the question has both messages", () => {
	const entries = steered();
	const info = collectCheckpoint(entries, options, new Set());
	assert.ok(info);
	assert.deepEqual(
		info.candidates.map((c) => c.entryId),
		["r0", "r1", "r2", "r3"],
	);
	assert.equal(info.currentTurn, 5);
	assert.match(info.question, /^Fix the tests\n\n\[The user added during the run\] also check the parser$/);
});

test("anthropicRewriteChars: the pin is on the steering message, so earlier edits rewrite everything", () => {
	const entries = steered();
	const branch = branchOf(entries);
	const pin = entries.findIndex((e) => e.sourceEntry.id === "s1");
	// After the steering message only: from the pin.
	assert.equal(anthropicRewriteChars(entries, branch, [], MODEL, NOW, new Set(["r3", "r4"])), contextChars(entries.slice(pin + 1)));
	// An output before it: no readable pin, everything.
	assert.equal(anthropicRewriteChars(entries, branch, [], MODEL, NOW, new Set(["r1", "r4"])), contextChars(entries));
	// A trusted read point before the output still applies.
	const fromR0 = anthropicRewriteChars(entries, branch, [wrote("r0", "r0")], MODEL, NOW, new Set(["r1"]));
	assert.equal(fromR0, contextChars(entries.slice(entries.findIndex((e) => e.sourceEntry.id === "r0") + 1)));
});

test("exchangeMemo: a steering message does not reset the run's memo", () => {
	const record = (results: Record<string, unknown>[]) => ({ type: "custom", customType: "context-guard", data: { v: 1, phase: "mid-run", results } });
	const branch = [
		{ type: "message", id: "u1", message: { role: "user" } },
		{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1" }] } },
		{ type: "message", id: "r1", message: { role: "toolResult" } },
		record([{ kind: "exchange", entryId: "x1", reason: "relevant" }]),
		{ type: "context_edit", targetId: "r1" },
		{ type: "message", id: "s1", message: { role: "user" } },
		{ type: "message", id: "a2", message: { role: "assistant", content: [{ type: "toolCall", id: "c2" }] } },
		{ type: "message", id: "s2", message: { role: "user" } },
	];
	assert.deepEqual([...exchangeMemo(branch, "context-guard")], ["x1"]);
	// After an answer, the next user message starts a new run.
	const next = [...branch, { type: "message", id: "a3", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, { type: "message", id: "u2", message: { role: "user" } }];
	assert.deepEqual([...exchangeMemo(next, "context-guard")], []);
});

test("exchangeMemo: exchange results of the current run only; memoFromBranch ignores exchanges", () => {
	const record = (results: Record<string, unknown>[], phase = "run-end") => ({ type: "custom", customType: "context-guard", data: { v: 1, phase, results } });
	const branch = [
		{ type: "message", id: "u1", message: { role: "user" } },
		record([{ kind: "exchange", entryId: "x1", reason: "relevant" }]),
		{ type: "message", id: "u2", message: { role: "user" } },
		record([{ kind: "exchange", entryId: "x2", reason: "unrelated" }, { kind: "exchange", entryId: "x3", reason: "timeout" }], "mid-run"),
		record([{ kind: "small", entryId: "s1", reason: "needed" }], "mid-run"),
	];
	assert.deepEqual([...exchangeMemo(branch, "context-guard")], ["x2"]);
	assert.deepEqual([...memoFromBranch(branch, "context-guard")], ["s1"]);
});

test("anthropicRewriteChars: an edit before the question rewrites everything without a trusted read point", () => {
	const entries = [user("old task", "u0"), assistant("old answer", [], "a0"), ...sized(4)];
	const branch = branchOf(entries as never);
	// u0 (an old exchange) comes before the current question: the question pin cannot be read.
	assert.equal(anthropicRewriteChars(entries, branch, [], MODEL, NOW, new Set(["u0", "r2"])), contextChars(entries));
	// Only outputs after the question: from the question.
	assert.ok(anthropicRewriteChars(entries, branch, [], MODEL, NOW, new Set(["r2"])) < contextChars(entries));
	// cacheAnchors with an edit before the question: no read point, write anchor only for tool results.
	assert.deepEqual(cacheAnchors([...branch, edit("u0")], [wrote("r1", "r1")], MODEL, NOW), {});
});
