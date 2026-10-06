import assert from "node:assert/strict";
import { test } from "node:test";
import { countBreakpoints, pinQuestionBreakpoint } from "../../src/cache-pin.ts";

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
