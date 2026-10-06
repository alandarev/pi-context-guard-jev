import assert from "node:assert/strict";
import { test } from "node:test";
import { countBreakpoints, markedToolResults, normalizeToolUseId, pinQuestionBreakpoint, placeGuardBreakpoints } from "../../src/cache-pin.ts";

type Json = Record<string, any>;
const cc = { type: "ephemeral" };
const cc1h = { type: "ephemeral", ttl: "1h" };

const text = (t: string, cache?: Json): Json => ({ type: "text", text: t, ...(cache ? { cache_control: { ...cache } } : {}) });
const toolUse = (id: string): Json => ({ role: "assistant", content: [{ type: "tool_use", id, name: "bash", input: { command: "ls" } }] });
const toolResult = (id: string, cache?: Json): Json => ({
	role: "user",
	content: [{ type: "tool_result", tool_use_id: id, content: "out", ...(cache ? { cache_control: { ...cache } } : {}) }],
});

/** A run in progress: previous question/answer, then the current question and a few tool calls. */
function conversation(rolling: Json = cc): Json[] {
	return [
		{ role: "user", content: [text("first question")] },
		{ role: "assistant", content: [text("first answer")] },
		{ role: "user", content: [text("second question")] },
		toolUse("t1"),
		toolResult("t1"),
		toolUse("t2"),
		toolResult("t2", rolling),
	];
}

const apiKeyPayload = (): Json => ({
	model: "claude",
	system: [text("system prompt", cc)],
	tools: [{ name: "a" }, { name: "b", cache_control: { ...cc } }],
	messages: conversation(),
});

const oauthPayload = (): Json => ({
	model: "claude",
	system: [text("You are Claude Code, Anthropic's official CLI for Claude.", cc), text("system prompt", cc)],
	tools: [{ name: "a", cache_control: { ...cc } }],
	messages: conversation(),
});

test("API-key payload: pins the previous question (3 → 4 breakpoints)", () => {
	const payload = apiKeyPayload();
	assert.equal(countBreakpoints(payload), 3);
	assert.equal(pinQuestionBreakpoint(payload), "pinned");
	assert.equal(countBreakpoints(payload), 4);
	assert.deepEqual(payload.messages[2].content[0].cache_control, cc);
	assert.equal(payload.messages[0].content[0].cache_control, undefined);
	// Pinning again is a no-op.
	assert.equal(pinQuestionBreakpoint(payload), "already");
	assert.equal(countBreakpoints(payload), 4);
});

test("OAuth payload: drops the redundant system[0] breakpoint (stays at 4)", () => {
	const payload = oauthPayload();
	assert.equal(countBreakpoints(payload), 4);
	assert.equal(pinQuestionBreakpoint(payload), "pinned");
	assert.equal(countBreakpoints(payload), 4);
	assert.equal(payload.system[0].cache_control, undefined);
	assert.deepEqual(payload.system[1].cache_control, cc);
	assert.deepEqual(payload.messages[2].content[0].cache_control, cc);
});

test("trailing mid-conversation system messages are skipped; rolling ttl is copied", () => {
	const payload = apiKeyPayload();
	payload.system = [text("system prompt", cc1h)];
	payload.tools = [{ name: "a" }, { name: "b", cache_control: { ...cc1h } }];
	payload.messages = [
		{ role: "user", content: [text("first question")] },
		{ role: "system", content: [], output_config: { effort: "high" } },
		{ role: "assistant", content: [text("first answer")] },
		{ role: "user", content: [text("second question", cc1h)] },
		{ role: "system", content: [], output_config: { effort: "medium" } },
	];
	assert.equal(pinQuestionBreakpoint(payload), "pinned");
	assert.deepEqual(payload.messages[0].content[0].cache_control, cc1h);
	assert.notEqual(payload.messages[0].content[0].cache_control, payload.messages[3].content[0].cache_control);
	assert.equal(countBreakpoints(payload), 4);
});

test("the pin goes on the last text block of a string-content question", () => {
	const payload = apiKeyPayload();
	payload.messages[2] = { role: "user", content: "second question" };
	assert.equal(pinQuestionBreakpoint(payload), "pinned");
	assert.deepEqual(payload.messages[2].content, [{ type: "text", text: "second question", cache_control: cc }]);

	const multi = apiKeyPayload();
	multi.messages[2] = { role: "user", content: [text("question"), { type: "image", source: {} }, text("more"), text("  ")] };
	assert.equal(pinQuestionBreakpoint(multi), "pinned");
	assert.deepEqual(
		multi.messages[2].content.map((b: Json) => b.cache_control),
		[undefined, undefined, cc, undefined],
	);
});

test("tool-result-only user messages are not questions", () => {
	const payload = apiKeyPayload();
	payload.messages = [{ role: "user", content: [text("only question")] }, toolUse("t1"), toolResult("t1", cc)];
	assert.equal(pinQuestionBreakpoint(payload), "pinned");
	assert.ok(payload.messages[0].content[0].cache_control);

	const noQuestion = apiKeyPayload();
	noQuestion.messages = [toolResult("t0"), toolUse("t1"), toolResult("t1", cc)];
	assert.equal(pinQuestionBreakpoint(noQuestion), "no-question");
});

test("no cache_control anywhere: payload unchanged", () => {
	const payload: Json = { system: [text("s")], messages: conversation(undefined as unknown as Json) };
	payload.messages[6] = toolResult("t2");
	const before = structuredClone(payload);
	assert.equal(pinQuestionBreakpoint(payload), "no-cache");
	assert.deepEqual(payload, before);
});

test("only one user message: no pin", () => {
	const payload: Json = { system: [text("s", cc)], messages: [{ role: "user", content: [text("hello", cc)] }] };
	const before = structuredClone(payload);
	assert.equal(pinQuestionBreakpoint(payload), "no-question");
	assert.deepEqual(payload, before);

	const withEffort: Json = {
		messages: [
			{ role: "user", content: [text("hello", cc)] },
			{ role: "system", content: [], output_config: { effort: "high" } },
		],
	};
	assert.equal(pinQuestionBreakpoint(withEffort), "no-question");
	assert.equal(countBreakpoints(withEffort), 1);
});

test("over budget even after dropping system[0]: payload restored", () => {
	const payload = oauthPayload();
	payload.tools = [{ name: "a", cache_control: { ...cc } }, { name: "b", cache_control: { ...cc } }];
	assert.equal(countBreakpoints(payload), 5);
	const before = structuredClone(payload);
	assert.equal(pinQuestionBreakpoint(payload), "over-budget");
	assert.deepEqual(payload, before);
});

test("non-payloads", () => {
	assert.equal(pinQuestionBreakpoint(undefined), "not-anthropic");
	assert.equal(pinQuestionBreakpoint("x"), "not-anthropic");
	assert.equal(pinQuestionBreakpoint({ input: [] }), "no-question");
});

/** question (no cc) → assistant block with `middle` → last user with `rolling`. */
function ttlPayload(head: Json | undefined, middle: Json | undefined, rolling: Json): Json {
	return {
		...(head ? { system: [text("system prompt", head)], tools: [{ name: "a" }] } : {}),
		messages: [
			{ role: "user", content: [text("question")] },
			{ role: "assistant", content: [text("answer", middle)] },
			{ role: "user", content: [text("next question", rolling)] },
		],
	};
}

test("TTL ordering: a 1h breakpoint after the pin forces a 1h pin (rolling is 5m)", () => {
	const payload = ttlPayload(undefined, cc1h, cc);
	assert.equal(pinQuestionBreakpoint(payload), "pinned");
	assert.deepEqual(payload.messages[0].content[0].cache_control, cc1h);

	const with1hHead = ttlPayload(cc1h, cc1h, cc);
	assert.equal(pinQuestionBreakpoint(with1hHead), "pinned");
	assert.deepEqual(with1hHead.messages[0].content[0].cache_control, cc1h);
});

test("TTL ordering: 5m before and 1h after the pin is a conflict", () => {
	const payload = ttlPayload(cc, cc1h, cc);
	const before = structuredClone(payload);
	assert.equal(pinQuestionBreakpoint(payload), "ttl-conflict");
	assert.deepEqual(payload, before);
});

test("TTL ordering: all-1h pins 1h, all-5m pins 5m", () => {
	const allLong = ttlPayload(cc1h, cc1h, cc1h);
	assert.equal(pinQuestionBreakpoint(allLong), "pinned");
	assert.deepEqual(allLong.messages[0].content[0].cache_control, cc1h);

	const allShort = ttlPayload(cc, cc, cc);
	assert.equal(pinQuestionBreakpoint(allShort), "pinned");
	assert.deepEqual(allShort.messages[0].content[0].cache_control, cc);
});

test("TTL ordering: a 1h rolling breakpoint after a 5m prefix is a conflict", () => {
	// 5m system then 1h rolling is itself invalid for Anthropic, but the pin must not add to it:
	// before = [5m, 5m] needs pin ≤ 5m, after = [1h] needs pin ≥ 1h → conflict.
	assert.equal(pinQuestionBreakpoint(ttlPayload(cc, undefined, cc1h)), "ttl-conflict");
	// With nothing before it, a 1h rolling breakpoint gives a 1h pin.
	const payload = ttlPayload(undefined, undefined, cc1h);
	assert.equal(pinQuestionBreakpoint(payload), "pinned");
	assert.deepEqual(payload.messages[0].content[0].cache_control, cc1h);
});

// --- read and write anchors (placeGuardBreakpoints) ---------------------------------------------

/** A long run: question, then turns t1…tN each with one tool call; rolling breakpoint on the last result. */
function longRun(turns: number, rolling: Json = cc): Json[] {
	const messages: Json[] = [
		{ role: "user", content: [text("first question")] },
		{ role: "assistant", content: [text("first answer")] },
		{ role: "user", content: [text("run question")] },
	];
	for (let i = 1; i <= turns; i++) messages.push(toolUse(`t${i}`), toolResult(`t${i}`, i === turns ? rolling : undefined));
	return messages;
}
const resultBlock = (payload: Json, id: string): Json =>
	payload.messages.flatMap((m: Json) => (Array.isArray(m.content) ? m.content : [])).find((b: Json) => b.tool_use_id === id);

test("anchors: the question is pinned first; a read anchor takes the next slot (API key)", () => {
	const payload: Json = { ...apiKeyPayload(), messages: longRun(8) };
	const result = placeGuardBreakpoints(payload, { anchors: ["t4"], pinQuestion: true });
	assert.deepEqual(result, { anchored: ["t4"], skipped: [], question: "pinned", removed: ["tools"] });
	assert.deepEqual(payload.messages[2].content[0].cache_control, cc);
	assert.deepEqual(resultBlock(payload, "t4").cache_control, cc);
	assert.equal(countBreakpoints(payload), 4);
	assert.deepEqual(markedToolResults(payload), ["t4", "t8"]);
});

test("anchors: question > read > write when the budget is tight (OAuth)", () => {
	const payload: Json = { ...oauthPayload(), messages: longRun(10) };
	const result = placeGuardBreakpoints(payload, { anchors: ["t3"], writeAnchors: ["t6"], pinQuestion: true });
	assert.equal(result.question, "pinned");
	assert.deepEqual(result.anchored, ["t3"]);
	assert.deepEqual(result.skipped, [{ id: "t6", reason: "over-budget" }]);
	assert.deepEqual(result.removed, ["system[0]", "tools"]);
	assert.equal(countBreakpoints(payload), 4);
	// Without a read anchor, the write anchor fits.
	const write: Json = { ...oauthPayload(), messages: longRun(10) };
	assert.deepEqual(placeGuardBreakpoints(write, { anchors: [], writeAnchors: ["t6"], pinQuestion: true }).anchored, ["t6"]);
	assert.equal(countBreakpoints(write), 4);
});

test("anchors: the question survives when another breakpoint leaves no room for anchors", () => {
	// No system breakpoint: the tools breakpoint cannot be dropped; an extra one sits on message 1.
	const payload: Json = { tools: [{ name: "a", cache_control: { ...cc } }], system: [text("s")], messages: longRun(10) };
	payload.messages[1].content[0].cache_control = { ...cc };
	const result = placeGuardBreakpoints(payload, { anchors: ["t3"], writeAnchors: ["t6"], pinQuestion: true });
	assert.equal(result.question, "pinned");
	assert.deepEqual(result.anchored, []);
	assert.deepEqual(result.skipped, [
		{ id: "t6", reason: "over-budget" },
		{ id: "t3", reason: "over-budget" },
	]);
	assert.deepEqual(markedToolResults(payload), ["t10"]);
	assert.equal(countBreakpoints(payload), 4);
});

test("anchors: not found, in the last message, already marked, normalized ids", () => {
	const payload = { ...apiKeyPayload(), messages: longRun(3) };
	resultBlock(payload, "t1").cache_control = { ...cc };
	const result = placeGuardBreakpoints(payload, { anchors: ["zz", "t3", "t1"], pinQuestion: false });
	assert.deepEqual(result.skipped, [
		{ id: "zz", reason: "not-found" },
		{ id: "t3", reason: "in-last-message" },
		{ id: "t1", reason: "already" },
	]);
	// Pi's Anthropic provider rewrites ids such as OpenAI's "call_1|fc_2".
	const normalized = { ...apiKeyPayload(), messages: longRun(4) };
	resultBlock(normalized, "t2").tool_use_id = normalizeToolUseId("call_1|fc_2");
	assert.deepEqual(placeGuardBreakpoints(normalized, { anchors: ["call_1|fc_2"], pinQuestion: false }).anchored, ["call_1|fc_2"]);
	assert.equal(normalizeToolUseId("call_1|fc_2"), "call_1_fc_2");
});

test("anchors: TTLs follow the rolling breakpoint and never break the order", () => {
	const payload: Json = { ...apiKeyPayload(), messages: longRun(6, cc1h) };
	payload.system[0].cache_control = { ...cc1h };
	payload.tools[1].cache_control = { ...cc1h };
	const result = placeGuardBreakpoints(payload, { anchors: [], writeAnchors: ["t2"], pinQuestion: true });
	assert.deepEqual(result.anchored, ["t2"]);
	assert.deepEqual(resultBlock(payload, "t2").cache_control, cc1h);
	assert.deepEqual(payload.messages[2].content[0].cache_control, cc1h);
	// A 5m system prompt before a 1h rolling breakpoint: nothing fits in between.
	const conflict = { ...apiKeyPayload(), messages: longRun(6, cc1h) };
	const skipped = placeGuardBreakpoints(conflict, { anchors: [], writeAnchors: ["t2"], pinQuestion: true });
	assert.deepEqual(skipped.skipped, [{ id: "t2", reason: "ttl-conflict" }]);
	assert.equal(skipped.question, "ttl-conflict");
	assert.equal(resultBlock(conflict, "t2").cache_control, undefined);
});

test("anchors: payloads without caching or messages are left alone", () => {
	const payload: Json = { messages: longRun(4, undefined as unknown as Json) };
	payload.messages[payload.messages.length - 1] = toolResult("t4");
	const before = structuredClone(payload);
	assert.equal(placeGuardBreakpoints(payload, { anchors: ["t2"], pinQuestion: true }).question, "no-cache");
	assert.deepEqual(payload, before);
	assert.equal(placeGuardBreakpoints(undefined, { anchors: [], pinQuestion: true }).question, "not-anthropic");
	assert.deepEqual(markedToolResults(undefined), []);
});

test("anchors: a read point inside a batch of consecutive tool_result blocks", () => {
	const payload: Json = { ...apiKeyPayload(), messages: longRun(4) };
	// One Anthropic user message holding the results of two parallel calls.
	payload.messages.splice(3, 2, { role: "assistant", content: [{ type: "tool_use", id: "p1" }, { type: "tool_use", id: "p2" }] }, {
		role: "user",
		content: [
			{ type: "tool_result", tool_use_id: "p1", content: "a" },
			{ type: "tool_result", tool_use_id: "p2", content: "b" },
		],
	});
	const result = placeGuardBreakpoints(payload, { anchors: ["p2"], pinQuestion: true });
	assert.deepEqual(result.anchored, ["p2"]);
	assert.deepEqual(payload.messages[4].content.map((b: Json) => Boolean(b.cache_control)), [false, true]);
	assert.equal(countBreakpoints(payload), 4);
});
