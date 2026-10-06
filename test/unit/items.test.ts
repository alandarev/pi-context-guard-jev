import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import {
	batchItems,
	createLimiter,
	buildExchangeRequest,
	buildSmallRequest,
	collectExchanges,
	collectSmall,
	EXCHANGE_STUB_PREFIX,
	exchangeEdits,
	exchangeLabel,
	exchangeStub,
	itemLabel,
	judgeItems,
	smallStub,
} from "../../src/items.ts";
import { processItems } from "../../src/process.ts";
import { MARKER } from "../../src/render.ts";
import { findRunStart } from "../../src/run.ts";
import type { ClassifierRequest, ClassifierResponse, ClassifyFn, MessageLike } from "../../src/types.ts";
import { assistant, entry, lines, toolResult, user } from "./fixtures.ts";

const options = { ...DEFAULT_CONFIG, minResultChars: 4_000, smallResultMinChars: 400 };
const mid = (n: number) => "m".repeat(n);

test("collectSmall: outputs between smallResultMinChars and minResultChars, same rules, age, memo", () => {
	const span = [
		assistant("", [
			{ id: "a", name: "bash", arguments: { command: "ls" } },
			{ id: "b", name: "read", arguments: { path: "x.ts" } },
		]),
		toolResult("a", "bash", mid(300), "tiny"),
		toolResult("b", "read", mid(1_500), "small1"),
		assistant("", [
			{ id: "c", name: "bash", arguments: { command: "big" } },
			{ id: "d", name: "edit", arguments: { path: "x.ts" } },
			{ id: "e", name: "bash", arguments: { command: "fail" } },
			{ id: "f", name: "bash", arguments: { command: "done" } },
		]),
		toolResult("c", "bash", mid(5_000), "large"),
		toolResult("d", "edit", mid(1_000), "excluded"),
		toolResult("e", "bash", mid(1_000), "error", { isError: true }),
		toolResult("f", "bash", `${MARKER} ${mid(1_000)}`, "marked"),
	];
	assert.deepEqual(
		collectSmall(span, options, new Set()).map((i) => [i.entryId, i.turn]),
		[
			["small1", 0],
			["error", 1],
		],
	);
	assert.deepEqual(
		collectSmall(span, { ...options, distillErrors: false }, new Set()).map((i) => i.entryId),
		["small1"],
	);
	// Age rule: only turns ≤ youngest; memo.
	assert.deepEqual(
		collectSmall(span, options, new Set(), 0).map((i) => i.entryId),
		["small1"],
	);
	assert.deepEqual(
		collectSmall(span, options, new Set(["small1"])).map((i) => i.entryId),
		["error"],
	);
	// Outputs whose stub would not be shorter are skipped.
	const short = [assistant("", [{ id: "g", name: "bash", arguments: { command: "x".repeat(300) } }]), toolResult("g", "bash", mid(150), "g1")];
	assert.deepEqual(collectSmall(short, { ...options, smallResultMinChars: 100 }, new Set()), []);
});

test("smallStub names the call, the size and the recall id", () => {
	const stub = smallStub({ entryId: "e1", toolName: "bash", args: { command: "ls -la" }, text: mid(1_200) });
	assert.equal(stub, `${MARKER} Omitted the output of bash \`ls -la\` (1.2k chars): judged no longer needed. Full output: recall({"entryId":"e1"}).`);
});

const pad = lines(40, "detail");
/** A session: earlier exchanges, then the current run. */
function session() {
	const notice = { sourceEntry: { id: "notice", type: "custom_message" }, messages: [{ role: "custom", content: "subagent finished" } as MessageLike] };
	return [
		{ sourceEntry: { id: "cmp", type: "compaction" }, messages: [{ role: "compactionSummary", content: [], summary: "earlier work" } as MessageLike] },
		user("Which clients retry?", "u1"),
		assistant("Searching.", [{ id: "c1", name: "bash", arguments: { command: "rg retry" } }], "a1"),
		toolResult("c1", "bash", lines(20), "r1"),
		assistant(`jobStatus and orderStatus.\n${pad}`, [], "a1b"),
		notice,
		user("Draft a README paragraph.", "u2"),
		assistant(`Here it is: …\n${pad}`, [], "a2"),
		user("Count the 500s in the log.", "u3"),
		assistant("", [{ id: "c3", name: "bash", arguments: { command: "grep -c 500 log" } }], "a3"),
		toolResult("c3", "bash", "12", "r3"),
		assistant(`12 lines.\n${pad}`, [], "a3b"),
		user("Where is StatusBadge used?", "u4"),
		assistant(`In 5 files.\n${pad}`, [], "a4"),
		user("Back to the retry clients: which also retry on 502?", "u5"),
		assistant("", [{ id: "c5", name: "bash", arguments: { command: "rg 502" } }], "a5"),
		toolResult("c5", "bash", lines(5), "r5"),
	];
}

test("collectExchanges: earlier completed exchanges, without the recent ones and the current run", () => {
	const entries = session();
	const runStart = findRunStart(entries);
	const items = collectExchanges(entries, runStart, 2, new Set());
	assert.deepEqual(
		items.map((x) => x.entryId),
		["u1", "u2"],
	);
	const [first] = items;
	assert.deepEqual(first.omitIds, ["a1", "r1", "a1b", "notice"]);
	assert.equal(first.prompt, "Which clients retry?");
	assert.equal(first.answer, `jobStatus and orderStatus.\n${pad}`);
	assert.deepEqual(first.toolCalls, ["bash `rg retry`"]);
	assert.equal(first.messages, 5);
	assert.ok(first.chars > 1_000);
	// keepRecentExchanges 0: every earlier exchange; never the current run (u5).
	assert.deepEqual(
		collectExchanges(entries, runStart, 0, new Set()).map((x) => x.entryId),
		["u1", "u2", "u3", "u4"],
	);
	// Judged in this run, or already omitted: skipped.
	assert.deepEqual(
		collectExchanges(entries, runStart, 0, new Set(["u2"])).map((x) => x.entryId),
		["u1", "u3", "u4"],
	);
	const omitted = entries.map((e) => (e.sourceEntry.id === "u1" ? { ...e, messages: [{ role: "user", content: `${EXCHANGE_STUB_PREFIX} …` }] } : e));
	assert.deepEqual(
		collectExchanges(omitted, runStart, 0, new Set()).map((x) => x.entryId),
		["u2", "u3", "u4"],
	);
});

test("collectExchanges: an exchange that did not complete (ends with a tool call) is not eligible", () => {
	const entries = [
		user("Fix it", "u1"),
		assistant("", [{ id: "c1", name: "bash", arguments: { command: "npm test" } }], "a1"),
		toolResult("c1", "bash", "fail", "r1"),
		user("steering: look at the parser", "u2"),
		assistant(`done\n${pad}`, [], "a2"),
		user("next", "u3"),
		assistant(`ok\n${pad}`, [], "a3"),
		user("now", "u4"),
	];
	assert.deepEqual(
		collectExchanges(entries, findRunStart(entries), 0, new Set()).map((x) => x.entryId),
		["u2", "u3"],
	);
});

test("exchangeStub and exchangeEdits: stub on the prompt, null for every other entry", () => {
	const [first] = collectExchanges(session(), findRunStart(session()), 2, new Set());
	const stub = exchangeStub(first);
	assert.ok(stub.startsWith(`${EXCHANGE_STUB_PREFIX} judged unrelated to the current work: "Which clients retry?" (5 messages, ~`));
	assert.ok(stub.endsWith(`Full exchange: recall({"entryId":"u1"}).`));
	const long = exchangeStub({ ...first, prompt: `${"word ".repeat(60)}end` });
	assert.match(long, /"(word ){23}word…"/);
	assert.deepEqual(exchangeEdits(first), [
		{ type: "context_edit", targetId: "u1", replacement: { content: [{ type: "text", text: stub }] } },
		{ type: "context_edit", targetId: "a1", replacement: null },
		{ type: "context_edit", targetId: "r1", replacement: null },
		{ type: "context_edit", targetId: "a1b", replacement: null },
		{ type: "context_edit", targetId: "notice", replacement: null },
	]);
});

const work = { question: "Which clients also retry on 502?", history: { exchanges: [] }, latest: "Searching again." };

test("buildExchangeRequest: one bool per exchange; the current work", () => {
	const items = collectExchanges(session(), findRunStart(session()), 0, new Set());
	const request = buildExchangeRequest(work, items);
	assert.deepEqual(Object.keys(request.state), ["situation", "user_question", "agent_progress", "exchanges"]);
	const exchanges = request.state.exchanges as Record<string, Record<string, unknown>>;
	assert.deepEqual(Object.keys(exchanges), ["exchange_1", "exchange_2", "exchange_3", "exchange_4"]);
	assert.deepEqual(Object.keys(exchanges.exchange_1), ["user_prompt", "final_answer", "tool_calls", "size"]);
	assert.deepEqual(Object.keys(request.questions), ["exchange_1", "exchange_2", "exchange_3", "exchange_4"]);
	assert.equal(request.questions.exchange_2.type, "bool");
	assert.match(request.questions.exchange_2.instructions, /^Is exchange_2 still relevant to the current work/);
	// Run end: the final answer instead of progress notes.
	const end = buildExchangeRequest({ question: "q", history: { exchanges: [] }, answer: "a" }, items);
	assert.equal(end.state.final_answer, "a");
	assert.equal("agent_progress" in end.state, false);
	assert.equal(exchangeLabel(0), "exchange_1");
});

test("buildSmallRequest: one bool per item, both phases", () => {
	const items = [
		{ entryId: "s1", toolName: "bash", args: { command: "ls" }, text: mid(800), turn: 0 },
		{ entryId: "s2", toolName: "read", args: { path: "a.ts" }, text: mid(900), turn: 1, isError: true },
	];
	const request = buildSmallRequest(work, items);
	const state = request.state.items as Record<string, Record<string, unknown>>;
	assert.deepEqual(state.item_1, { tool: "bash `ls`", output: mid(800) });
	assert.equal(state.item_2.status, "failed");
	assert.match(request.questions.item_1.instructions, /^To finish user_question, will the agent still need the output in item_1\?/);
	const end = buildSmallRequest({ question: "q", history: { exchanges: [] }, answer: "a" }, items);
	assert.match(end.questions.item_2.instructions, /final_answer relies on/);
	assert.equal(itemLabel(1), "item_2");
});

test("batchItems respects both limits", () => {
	assert.deepEqual(batchItems([5, 5, 5, 5, 5], (n) => n, 10, 10), [[0, 1], [2, 3], [4]]);
	assert.deepEqual(batchItems([1, 1, 1, 1, 1], (n) => n, 100, 2), [[0, 1], [2, 3], [4]]);
	assert.deepEqual(batchItems([50, 1], (n) => n, 10, 10), [[0], [1]]);
	assert.deepEqual(batchItems([], (n: number) => n, 10, 10), []);
});

const bools = (request: ClassifierRequest, p: (label: string) => number): ClassifierResponse => ({
	answers: Object.fromEntries(Object.keys(request.questions).map((k) => [k, { type: "bool" as const, probability: p(k) }])),
	stopReason: "stop",
	usage: { input: 100, output: 1, totalTokens: 101, cost: { total: 0.0001 } },
});

test("judgeItems: batches in parallel, per-item probabilities, failures keep", async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	const classify: ClassifyFn = async (request) => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await new Promise((r) => setTimeout(r, 5));
		inFlight--;
		if (JSON.stringify(request.state).includes("FAIL")) return { answers: {}, stopReason: "error" };
		return bools(request, (k) => (k === "item_1" ? 0.9 : 0.1));
	};
	const items = ["a", "b", "c", "FAIL", "e"];
	const outcome = await judgeItems(items, () => 10, (batch) => ({ state: { batch }, questions: Object.fromEntries(batch.map((_, i) => [itemLabel(i), { type: "bool", instructions: "", criteria: { true: "", false: "" } }])) }), itemLabel, classify, { timeoutMs: 2_000, concurrency: 2, maxRequestChars: 20, maxItemsPerRequest: 2 });
	assert.equal(outcome.requests, 3);
	assert.equal(maxInFlight, 2);
	assert.deepEqual(outcome.probabilities, [0.9, 0.1, undefined, undefined, 0.9]);
	assert.deepEqual([...outcome.failures], [
		[2, "error"],
		[3, "error"],
	]);
	assert.equal(outcome.inputTokens, 200);
});

test("judgeItems: the time budget is enforced", async () => {
	const never: ClassifyFn = () => new Promise(() => {});
	const outcome = await judgeItems(["a"], () => 1, () => ({ state: {}, questions: {} }), itemLabel, never, { timeoutMs: 100, concurrency: 1, maxRequestChars: 10, maxItemsPerRequest: 10 });
	assert.equal(outcome.timedOut, true);
	assert.deepEqual([...outcome.failures], [[0, "timeout"]]);
});

test("processItems: small stubs, exchange omissions and records with kinds", async () => {
	const entries = session();
	const exchanges = collectExchanges(entries, findRunStart(entries), 2, new Set());
	const small = [
		{ entryId: "s1", toolName: "bash", args: { command: "ls" }, text: mid(1_500), turn: 0 },
		{ entryId: "s2", toolName: "read", args: { path: "a.ts" }, text: mid(1_500), turn: 0 },
	];
	const classify: ClassifyFn = async (request) =>
		bools(request, (k) => {
			if (k.startsWith("item_")) return k === "item_1" ? 0.1 : 0.8;
			// exchange_1 (retry clients) relevant, exchange_2 (README) unrelated.
			return k === "exchange_1" ? 0.9 : 0.05;
		});
	const outcome = await processItems({ question: "q", answer: "", notes: "", candidates: [], toolResults: 0 }, small, exchanges, work, classify, {
		...DEFAULT_CONFIG,
		smallKeepThreshold: 0.45,
		exchangeOmitThreshold: 0.2,
	});
	assert.deepEqual(
		outcome.records.map((r) => [r.kind, r.entryId, r.outcome, r.reason]),
		[
			["small", "s1", "removed", "not-needed"],
			["small", "s2", "kept", "needed"],
			["exchange", "u1", "kept", "relevant"],
			["exchange", "u2", "removed", "unrelated"],
		],
	);
	assert.deepEqual(
		outcome.edits.map((e) => [e.targetId, e.replacement === null ? null : "stub"]),
		[
			["s1", "stub"],
			["u2", "stub"],
			["a2", null],
		],
	);
	assert.equal(outcome.requests, 2);
	assert.ok(outcome.savedChars > 1_000);
});

test("collectSmall marks superseded outputs; the request shows it", () => {
	const span = [
		assistant("", [{ id: "a", name: "read", arguments: { path: "src/x.ts" } }]),
		toolResult("a", "read", mid(1_500), "read1"),
		assistant("", [{ id: "b", name: "edit", arguments: { path: "src/x.ts" } }]),
		toolResult("b", "edit", "ok", "edit1"),
	];
	const [item] = collectSmall(span, options, new Set());
	assert.equal(item.superseded, "this file was changed after this read (edit src/x.ts, 1 turn later)");
	const request = buildSmallRequest(work, [item]);
	assert.equal((request.state.items as Record<string, Record<string, unknown>>).item_1.superseded, item.superseded);
	assert.match(request.questions.item_1.instructions, /marked superseded/);
});

// --- recoverability, shapes, limiter --------------------------------------------------------

/** Two old exchanges (u1, u2) and the current run, with no recent exchanges kept (keepRecent 0). */
const twoOld = (first: ReturnType<typeof user>[]) => [
	...first,
	user("Second task", "u2"),
	assistant(`Done.\n${pad}`, [], "a2"),
	user("Current task", "u9"),
];

test("collectExchanges skips exchanges with images or with entries another extension edited", () => {
	const image = twoOld([
		entry({ role: "user", content: [{ type: "text", text: "What is in this screenshot?" }, { type: "image", data: "x", mimeType: "image/png" }] }, "u1"),
		assistant(`A stack trace.\n${pad}`, [], "a1"),
	]);
	assert.deepEqual(
		collectExchanges(image, findRunStart(image), 0, new Set()).map((x) => x.entryId),
		["u2"],
	);
	const imageResult = twoOld([
		user("Show the chart", "u1"),
		assistant("", [{ id: "c1", name: "read", arguments: { path: "chart.png" } }], "a1"),
		entry({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "image", data: "x" }], isError: false }, "r1"),
		assistant(`A bar chart.\n${pad}`, [], "a1b"),
	]);
	assert.deepEqual(
		collectExchanges(imageResult, findRunStart(imageResult), 0, new Set()).map((x) => x.entryId),
		["u2"],
	);
	// The prompt was replaced by another extension (not our marker): skipped.
	const foreign = twoOld([user("Original prompt", "u1"), assistant(`Answer.\n${pad}`, [], "a1")]).map((e) =>
		e.sourceEntry.id === "u1" ? { ...e, messages: [{ role: "user", content: [{ type: "text", text: "Rewritten by another extension" }] }] } : e,
	);
	assert.deepEqual(
		collectExchanges(foreign, findRunStart(foreign), 0, new Set()).map((x) => x.entryId),
		["u2"],
	);
	// An entry of the exchange omitted by someone else (Pi keeps it with no messages): skipped.
	const omitted = twoOld([user("Task", "u1"), assistant("", [{ id: "c1", name: "bash", arguments: {} }], "a1"), toolResult("c1", "bash", "out", "r1"), assistant(`Done.\n${pad}`, [], "a1b")]).map((e) =>
		e.sourceEntry.id === "r1" ? { ...e, messages: [] } : e,
	);
	assert.deepEqual(
		collectExchanges(omitted, findRunStart(omitted), 0, new Set()).map((x) => x.entryId),
		["u2"],
	);
	// Our own distilled output inside an old exchange is fine (recall returns the raw output).
	const ours = twoOld([user("Task", "u1"), assistant("", [{ id: "c1", name: "bash", arguments: {} }], "a1"), toolResult("c1", "bash", "raw output", "r1"), assistant(`Done.\n${pad}`, [], "a1b")]).map((e) =>
		e.sourceEntry.id === "r1" ? { ...e, messages: [{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: `${MARKER} Distilled …` }] }] } : e,
	);
	assert.deepEqual(
		collectExchanges(ours, findRunStart(ours), 0, new Set()).map((x) => x.entryId),
		["u1", "u2"],
	);
});

test("collectExchanges: system messages, ! executions and custom messages; compaction in between", () => {
	const system = { sourceEntry: { id: "sys", type: "message", message: { role: "system", content: "effort" } }, messages: [{ role: "system", content: "effort" }] };
	const bang = { sourceEntry: { id: "bang", type: "message", message: { role: "bashExecution", content: "" } }, messages: [{ role: "bashExecution", content: "" }] };
	const notice = { sourceEntry: { id: "notice", type: "custom_message" }, messages: [{ role: "custom", content: "subagent done" }] };
	const compaction = { sourceEntry: { id: "cmp", type: "compaction" }, messages: [{ role: "compactionSummary", content: [], summary: "earlier work" }] };
	const entries = twoOld([user("Task", "u1"), system, assistant(`Working.\n${pad}`, [], "a1"), bang, notice, compaction] as never) as never as ReturnType<typeof session>;
	const [first] = collectExchanges(entries, findRunStart(entries), 0, new Set());
	// Only editable entries are omitted: the assistant message and the custom message; system, ! and the summary stay.
	assert.equal(first.entryId, "u1");
	assert.deepEqual(first.omitIds, ["a1", "notice"]);
});

test("collectExchanges: tiny exchanges and those whose stub would not be shorter are skipped", () => {
	const tiny = twoOld([user("Hi", "u1"), assistant("Hello!", [], "a1")]);
	assert.deepEqual(
		collectExchanges(tiny, findRunStart(tiny), 0, new Set()).map((x) => x.entryId),
		["u2"],
	);
});

test("createLimiter: one limit across every caller", async () => {
	const limit = createLimiter(2);
	let inFlight = 0;
	let max = 0;
	const task = () =>
		limit(async () => {
			inFlight++;
			max = Math.max(max, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return 1;
		});
	const results = await Promise.all(Array.from({ length: 7 }, task));
	assert.equal(max, 2);
	assert.deepEqual(results, [1, 1, 1, 1, 1, 1, 1]);
	await assert.rejects(() => limit(() => Promise.reject(new Error("boom"))), /boom/);
	assert.equal(await limit(async () => "still works"), "still works");
});

test("processItems: `concurrency` is the total across large outputs, small outputs and exchanges", async () => {
	let inFlight = 0;
	let max = 0;
	const classify: ClassifyFn = async (request) => {
		inFlight++;
		max = Math.max(max, inFlight);
		await new Promise((r) => setTimeout(r, 10));
		inFlight--;
		if (request.state.chunks) return { answers: {}, stopReason: "error" };
		return bools(request, () => 0.9);
	};
	const entries = session();
	const exchanges = collectExchanges(entries, findRunStart(entries), 0, new Set());
	const small = Array.from({ length: 6 }, (_, i) => ({ entryId: `s${i}`, toolName: "bash", args: { command: `c${i}` }, text: mid(3_000), turn: 0 }));
	const candidates = Array.from({ length: 3 }, (_, i) => ({ entryId: `l${i}`, toolName: "bash", args: { command: `big${i}` }, text: lines(300, `big${i}`) }));
	await processItems({ question: "q", answer: "a", notes: "", candidates, toolResults: 3 }, small, exchanges, work, classify, {
		...DEFAULT_CONFIG,
		concurrency: 2,
		maxSegmentChars: 4_000,
		maxChunksPerSegment: 2,
		minRunChars: 0,
		smallKeepThreshold: 0.45,
		exchangeOmitThreshold: 0.2,
	});
	assert.equal(max, 2);
});

test("collectExchanges after a compaction that cut an exchange: the kept tail is never omitted", () => {
	const summary = { sourceEntry: { id: "cmp", type: "compaction" }, messages: [{ role: "compactionSummary", content: [], summary: "earlier" }] };
	// The compaction kept the end of an exchange whose prompt was summarized away.
	const entries = [summary, assistant("", [{ id: "c0", name: "bash", arguments: {} }], "a0"), toolResult("c0", "bash", pad, "r0"), assistant(`Tail answer.\n${pad}`, [], "a0b"), ...twoOld([user("Task", "u1"), assistant(`Done.\n${pad}`, [], "a1")])] as never as ReturnType<typeof session>;
	const items = collectExchanges(entries, findRunStart(entries), 0, new Set());
	assert.deepEqual(
		items.map((x) => x.entryId),
		["u1", "u2"],
	);
	assert.ok(items.every((x) => !x.omitIds.some((id) => ["a0", "r0", "a0b", "cmp"].includes(id))));
});
