/**
 * Loads src/index.ts through Pi's own extension loader (jiti, with Pi's module aliases) from the
 * devDependency copy, then drives its handlers with a fake ctx. No network, no model calls.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { MARKER } from "../../src/render.ts";
import type { ClassifierAnswer, ClassifierRequest, ClassifierResponse } from "../../src/types.ts";
import { assistant, lines, toolResult, user } from "./fixtures.ts";

// Pi's getAgentDir() honours PI_CODING_AGENT_DIR; never touch the real ~/.pi/agent.
const agentDir = mkdtempSync(join(tmpdir(), "context-guard-agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
// PI_CONTEXT_GUARD_CONFIG wins over the agent dir; point it at the temp file too, so a value
// inherited from the shell can never make the tests write a real config.
const configFile = join(agentDir, "context-guard.json");
const previousConfig = process.env.PI_CONTEXT_GUARD_CONFIG;
process.env.PI_CONTEXT_GUARD_CONFIG = configFile;

const repo = resolve(import.meta.dirname, "../..");
const loaderPath = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");

type Handler = (event: unknown, ctx: unknown) => unknown;
interface LoadedExtension {
	handlers: Map<string, Handler[]>;
	tools: Map<string, { definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> } }>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
}

let extension: LoadedExtension;

before(async () => {
	writeFileSync(configFile, JSON.stringify({ timeoutMs: 5_000 }));
	const { loadExtensions } = (await import(pathToFileURL(loaderPath).href)) as {
		loadExtensions: (paths: string[], cwd: string) => Promise<{ extensions: LoadedExtension[]; errors: { path: string; error: string }[] }>;
	};
	const result = await loadExtensions([join(repo, "src/index.ts")], repo);
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	extension = result.extensions[0];
});

after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousConfig === undefined) delete process.env.PI_CONTEXT_GUARD_CONFIG;
	else process.env.PI_CONTEXT_GUARD_CONFIG = previousConfig;
	rmSync(agentDir, { recursive: true, force: true });
});

const handler = (event: string): Handler => {
	const list = extension.handlers.get(event);
	assert.ok(list && list.length === 1, `one ${event} handler`);
	return list[0];
};

/** Keep chunk_1 of every request; drop the rest. */
const fakeAnswers = (request: ClassifierRequest): ClassifierResponse => {
	const labels = Object.keys(request.state.chunks as Record<string, string>);
	const answers: Record<string, ClassifierAnswer> = {
		keep_whole: { type: "bool", probability: 0.02 },
		focus: { type: "choice", choice: "chunk_1", probabilities: { chunk_1: 0.9 }, confidence: 0.9 },
	};
	for (const label of labels) answers[label] = { type: "bool", probability: label === "chunk_1" ? 0.95 : 0.01 };
	return { answers, stopReason: "stop", usage: { input: 1_000, output: 1, totalTokens: 1_001, cost: { total: 0.0005 } } };
};

function fakeCtx(overrides: { model?: unknown } = {}) {
	const calls: { model: unknown; request: ClassifierRequest; options: { signal?: AbortSignal } }[] = [];
	const ctx = {
		hasUI: false,
		signal: undefined,
		modelRegistry: {
			findOfType: (type: string, provider: string, id: string) => {
				assert.deepEqual([type, provider, id], ["classifier", "openrouter", "~typesafe/jev-latest"]);
				return "model" in overrides ? overrides.model : { provider, id };
			},
			hasConfiguredAuth: () => true,
			classify: async (model: unknown, request: ClassifierRequest, options: { signal?: AbortSignal }) => {
				calls.push({ model, request, options });
				return fakeAnswers(request);
			},
		},
		sessionManager: { buildSessionProjection: () => ({ entries: [] }), getBranch: () => [], getEntry: () => undefined },
		ui: { notify(_message: string, _level?: string) {}, setStatus() {}, setWorkingMessage() {}, theme: { fg: (_c: string, t: string) => t } },
	};
	return { ctx, calls };
}

const contextEntries = () => [
	user("old question", "u0"),
	assistant("old answer", [], "a0"),
	user("Where is foo used?", "u1"),
	assistant("Searching.", [
		{ id: "c1", name: "bash", arguments: { command: "cat big.log" } },
		{ id: "c2", name: "read", arguments: { path: "src/big.ts" } },
		{ id: "c3", name: "edit", arguments: { path: "src/x.ts" } },
	], "a1"),
	toolResult("c1", "bash", lines(300, "log"), "r1"),
	toolResult("c2", "read", lines(300, "src"), "r2"),
	toolResult("c3", "edit", lines(300, "edit"), "r3"),
	assistant("foo is used in log line 1.", [], "a2"),
];

const settleEvent = (outcome = "completed") => ({
	type: "agent_before_settle",
	outcome,
	entries: [{ type: "custom", customType: "other", data: 1 }],
	context: { contextEntries: contextEntries() },
});

test("registers handlers, the recall tool and the guard command", () => {
	for (const event of ["session_start", "session_tree", "session_compact", "agent_settled", "turn_end", "agent_before_settle", "before_provider_request"]) {
		assert.ok(extension.handlers.has(event), event);
	}
	assert.deepEqual([...extension.tools.keys()], ["recall"]);
	assert.deepEqual([...extension.commands.keys()], ["guard"]);
});

test("agent_before_settle appends context edits and a run record after other drafts", async () => {
	const { ctx, calls } = fakeCtx();
	await handler("session_start")({ type: "session_start" }, ctx);
	const result = (await handler("agent_before_settle")(settleEvent(), ctx)) as { entries: Record<string, any>[] };
	assert.ok(result);
	const { entries } = result;

	assert.deepEqual(entries[0], { type: "custom", customType: "other", data: 1 });
	const edits = entries.slice(1, -1);
	assert.deepEqual(
		edits.map((e) => [e.type, e.targetId]),
		[
			["context_edit", "r1"],
			["context_edit", "r2"],
		],
	);
	for (const edit of edits) assert.ok(edit.replacement.content[0].text.startsWith(MARKER));
	assert.match(edits[1].replacement.content[0].text, /lines \d+–300 of src\/big\.ts/);

	const record = entries.at(-1)!;
	assert.equal(record.type, "custom");
	assert.equal(record.customType, "context-guard");
	assert.equal(record.data.v, 1);
	assert.equal(record.data.model, "openrouter/~typesafe/jev-latest");
	assert.equal(record.data.requests, calls.length);
	assert.equal(record.data.inputTokens, 1_000 * calls.length);
	assert.equal(record.data.timedOut, false);
	assert.deepEqual(
		record.data.results.map((r: Record<string, unknown>) => [r.entryId, r.outcome]),
		[
			["r1", "distilled"],
			["r2", "distilled"],
		],
	);

	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0].model, { provider: "openrouter", id: "~typesafe/jev-latest" });
	assert.ok(calls[0].options.signal instanceof AbortSignal);
	assert.equal(calls[0].request.state.user_question, "Where is foo used?");
	assert.equal(calls[0].request.state.final_answer, "foo is used in log line 1.");
	// Default historyExchanges (3): the earlier exchange goes to Jev as earlier_conversation.
	assert.deepEqual(calls[0].request.state.earlier_conversation, { recent_exchanges: [{ user: "old question", assistant: "old answer" }] });
});

test("agent_before_settle ignores runs that did not complete", async () => {
	const { ctx, calls } = fakeCtx();
	assert.equal(await handler("agent_before_settle")(settleEvent("aborted"), ctx), undefined);
	assert.equal(calls.length, 0);
});

test("agent_before_settle does nothing when the classifier model is missing", async () => {
	const { ctx, calls } = fakeCtx({ model: undefined });
	assert.equal(await handler("agent_before_settle")(settleEvent(), ctx), undefined);
	assert.equal(calls.length, 0);
});

test("before_provider_request pins only for anthropic-messages models", () => {
	const payload = () => ({
		system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "q1" }] },
			{ role: "assistant", content: [{ type: "text", text: "a1" }] },
			{ role: "user", content: [{ type: "text", text: "q2", cache_control: { type: "ephemeral" } }] },
		],
	});
	const anthropic = payload();
	assert.equal(handler("before_provider_request")({ type: "before_provider_request", payload: anthropic }, { model: { api: "anthropic-messages" } }), undefined);
	assert.deepEqual((anthropic.messages[0].content[0] as Record<string, unknown>).cache_control, { type: "ephemeral" });

	const other = payload();
	handler("before_provider_request")({ type: "before_provider_request", payload: other }, { model: { api: "openai-responses" } });
	assert.deepEqual(other, payload());
});

test("recall tool returns the original output", async () => {
	const tool = extension.tools.get("recall")!.definition;
	const raw = { id: "r1", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "a\nfoo\nb" }] } };
	const ctx = { sessionManager: { getEntry: (id: string) => (id === "r1" ? raw : undefined) } };
	const result = (await tool.execute("call", { entryId: "r1", pattern: "foo" }, undefined, undefined, ctx)) as { content: { text: string }[] };
	assert.equal(result.content[0].text, "2: foo");
	await assert.rejects(() => tool.execute("call", { entryId: "zz" }, undefined, undefined, ctx), /No tool result with entry id zz/);
});

test("/guard off|on persists to the temp agent dir and pauses distillation", async () => {
	const { ctx, calls } = fakeCtx();
	const notes: string[] = [];
	ctx.ui.notify = (message: string) => {
		notes.push(message);
	};
	const guard = extension.commands.get("guard")!;

	await guard.handler("off", ctx);
	assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), { timeoutMs: 5_000, enabled: false });
	assert.match(notes.at(-1) ?? "", /^context-guard is off/);
	assert.equal(await handler("agent_before_settle")(settleEvent(), ctx), undefined);
	assert.equal(calls.length, 0);

	await guard.handler("on", ctx);
	assert.equal(JSON.parse(readFileSync(configFile, "utf8")).enabled, true);
	assert.match(notes.at(-1) ?? "", /^context-guard is on · model openrouter\/~typesafe\/jev-latest/);
	await guard.handler("bogus", ctx);
	assert.equal(notes.at(-1), "Usage: /guard [status|on|off|reload]");
});

// --- mid-run checkpoints (turn_end) --------------------------------------------------------------

/** A run where turn i calls bash `step i`; turn 0's output is short, the others ~18k chars each. */
function longRunEntries(turns: number) {
	const entries = [user("earlier", "u0"), assistant("ok", [], "a0"), user("Fix all failing tests.", "u1")];
	for (let i = 0; i < turns; i++) {
		entries.push(assistant(i === turns - 1 ? "Still fixing." : "", [{ id: `c${i}`, name: "bash", arguments: { command: `step ${i}` } }], `t${i}`));
		entries.push(toolResult(`c${i}`, "bash", i === 0 ? "short" : lines(300, `out${i}`), `r${i}`));
	}
	return entries;
}
const turnEndEvent = (entries: ReturnType<typeof longRunEntries>) => ({
	type: "turn_end",
	outcome: "completed",
	turnIndex: 0,
	message: entries.at(-2)?.messages[0],
	toolResults: [],
	messageEntryId: "x",
	toolResultEntryIds: [],
	entries: [{ type: "custom", customType: "other", data: 1 }],
	context: { contextEntries: entries },
});

test("turn_end: the break-even rule skips a checkpoint that would not pay off", async () => {
	const { ctx, calls } = fakeCtx();
	await handler("session_start")({ type: "session_start" }, ctx);
	// 72k pending chars after 9 turns vs. ~144k chars the cache would have to rewrite.
	assert.equal(await handler("turn_end")(turnEndEvent(longRunEntries(9)), ctx), undefined);
	assert.equal(calls.length, 0);
});

type Json = Record<string, any>;

/**
 * A fake session: the branch of persisted entries, drafts committed as Pi commits them, and the
 * projection (context edits applied). Lets the tests decide whether a boundary's drafts are committed.
 */
function fakeSession(projected: ReturnType<typeof longRunEntries>) {
	const branch: Json[] = projected.map((e) => e.sourceEntry);
	let n = 0;
	const session = {
		branch,
		commit(drafts: Json[]) {
			for (const d of drafts) {
				if (d.type === "context_edit") branch.push({ type: "context_edit", id: `edit${++n}`, targetId: d.targetId, replacement: d.replacement });
				else if (d.type === "custom") branch.push({ type: "custom", id: `rec${++n}`, customType: d.customType, data: d.data });
			}
		},
		append(entries: ReturnType<typeof longRunEntries>) {
			for (const e of entries) branch.push(e.sourceEntry);
		},
		projection() {
			const edits = new Map(branch.filter((e) => e.type === "context_edit").map((e) => [e.targetId, e.replacement]));
			return branch
				.filter((e) => e.type === "message")
				.map((e) => {
					const replacement = edits.get(e.id);
					return { sourceEntry: e, messages: [replacement ? { ...e.message, content: replacement.content } : e.message] };
				});
		},
	};
	return session;
}

/** fakeCtx whose sessionManager reads the fake session. */
function sessionCtx(session: ReturnType<typeof fakeSession>, answers?: (request: ClassifierRequest) => ClassifierResponse) {
	const { ctx, calls } = fakeCtx();
	ctx.sessionManager.getBranch = () => session.branch as never;
	ctx.sessionManager.buildSessionProjection = () => ({ entries: session.projection() }) as never;
	if (answers) {
		ctx.modelRegistry.classify = async (model: unknown, request: ClassifierRequest, options: { signal?: AbortSignal }) => {
			calls.push({ model, request, options });
			return answers(request);
		};
	}
	return { ctx, calls };
}

const turnEndOf = (session: ReturnType<typeof fakeSession>) => {
	const entries = session.projection();
	return { ...turnEndEvent(entries as never), message: entries.filter((e) => e.messages[0].role === "assistant").at(-1)?.messages[0] };
};
const stepsAsked = (calls: { request: ClassifierRequest }[]) => calls.map((c) => JSON.parse(c.request.state.tool_arguments as string).command);

/** Anthropic payload for the fake session (pi-claude-auth shape: system prompt moved into the first user message). */
function claudeAuthPayload(turns: number): Json {
	const messages: Json[] = [
		{ role: "user", content: [{ type: "text", text: "earlier" }] },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		{ role: "user", content: [{ type: "text", text: "You are an expert coding assistant…" }, { type: "text", text: "Fix all failing tests." }] },
		{ role: "system", content: [], output_config: { effort: "high" } },
	];
	for (let i = 0; i < turns; i++) {
		messages.push({ role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "bash", input: {} }] });
		messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: "x", ...(i === turns - 1 ? { cache_control: { type: "ephemeral" } } : {}) }] });
		messages.push({ role: "system", content: [], output_config: { effort: "high" } });
	}
	return {
		system: [{ type: "text", text: "x-anthropic-billing-header: …" }, { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } }],
		tools: [{ name: "a" }, { name: "b", cache_control: { type: "ephemeral" } }],
		messages,
	};
}
const marks = (payload: Json): string[] =>
	payload.messages.flatMap((m: Json, i: number) =>
		(Array.isArray(m.content) ? m.content : []).flatMap((b: Json, j: number) => (b.cache_control ? [b.tool_use_id ?? `messages[${i}].content[${j}]`] : [])),
	);
const countMarks = (payload: Json) => JSON.stringify(payload).split('"cache_control"').length - 1;
const providerRequest = (payload: Json, ctx: Json) => handler("before_provider_request")({ type: "before_provider_request", payload }, { ...ctx, model: { api: "anthropic-messages" } });

test("turn_end: batches, the persisted memo, the read point and run end", async () => {
	writeFileSync(configFile, JSON.stringify({ timeoutMs: 5_000, midRunBreakEven: false }));
	const session = fakeSession(longRunEntries(7));
	// out1 is "needed whole" (kept); everything else keeps only chunk_1.
	const answers = (request: ClassifierRequest) => {
		const response = fakeAnswers(request);
		if (JSON.stringify(request.state.chunks).includes("out1 ")) response.answers.keep_whole = { type: "bool", probability: 0.95 };
		return response;
	};
	const { ctx, calls } = sessionCtx(session, answers);
	await handler("session_start")({ type: "session_start" }, ctx);
	const turnEnd = handler("turn_end");

	// Final turn of a run (no tool call): left to run-end distillation.
	assert.equal(await turnEnd({ ...turnEndOf(session), message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, ctx), undefined);
	// Turn 6: outputs of turns ≤ 2 are old enough (r1, r2 ≈ 36k chars), below the 60k batch.
	assert.equal(await turnEnd(turnEndOf(session), ctx), undefined);
	assert.equal(calls.length, 0);

	// Turn 8: r1…r4 (≈ 72k chars) → one checkpoint.
	session.append([assistant("", [{ id: "c7", name: "bash", arguments: { command: "step 7" } }], "t7"), toolResult("c7", "bash", lines(300, "out7"), "r7")]);
	session.append([assistant("Still fixing.", [{ id: "c8", name: "bash", arguments: { command: "step 8" } }], "t8"), toolResult("c8", "bash", lines(300, "out8"), "r8")]);
	const result = (await turnEnd(turnEndOf(session), ctx)) as { entries: Json[]; continue?: boolean };
	assert.equal(result.continue, undefined);
	assert.deepEqual(result.entries[0], { type: "custom", customType: "other", data: 1 });
	assert.deepEqual(
		result.entries.slice(1, -1).map((e) => e.targetId),
		["r2", "r3", "r4"],
	);
	const record = result.entries.at(-1)!;
	assert.equal(record.data.phase, "mid-run");
	assert.deepEqual(
		record.data.results.map((r: Json) => [r.entryId, r.outcome, r.reason]),
		[
			["r1", "kept", "whole-needed"],
			["r2", "distilled", "chunks"],
			["r3", "distilled", "chunks"],
			["r4", "distilled", "chunks"],
		],
	);
	assert.deepEqual(stepsAsked(calls), ["step 1", "step 2", "step 3", "step 4"]);
	session.commit(result.entries);

	// Committed: the same turn again asks nothing.
	assert.equal(await turnEnd(turnEndOf(session), ctx), undefined);
	assert.equal(calls.length, 4);

	// First request after the edits: no read point (this process sent no request yet, so it knows of no
	// cache entry), the question pin as the floor, and a write anchor at c2 (the end of the first edited
	// batch). A warming replay gets the same breakpoints.
	for (let i = 0; i < 2; i++) {
		const payload = claudeAuthPayload(9);
		providerRequest(payload, ctx);
		assert.deepEqual(marks(payload), ["messages[2].content[1]", "c2", "c8"]);
		assert.equal(payload.tools[1].cache_control, undefined);
		assert.equal(countMarks(payload), 4);
	}
	// Once a request after the edits has been answered: the question pin again.
	session.append([assistant("Running the suite.", [{ id: "c9", name: "bash", arguments: { command: "step 9" } }], "t9")]);
	const later = claudeAuthPayload(9);
	providerRequest(later, ctx);
	assert.deepEqual(marks(later), ["messages[2].content[1]", "c8"]);

	// Run end: r1 (kept mid-run) is judged again with the final answer; r2…r4 carry the marker.
	session.append([toolResult("c9", "bash", lines(300, "out9"), "r9"), assistant("All green.", [], "end")]);
	const settled = (await handler("agent_before_settle")(
		{ type: "agent_before_settle", outcome: "completed", entries: [], context: { contextEntries: session.projection() } },
		ctx,
	)) as { entries: Json[] };
	assert.deepEqual(stepsAsked(calls.slice(4)), ["step 1", "step 5", "step 6", "step 7", "step 8", "step 9"]);
	assert.equal(settled.entries.at(-1)!.data.phase, "run-end");
	session.commit(settled.entries);

	// Next prompt after the run-end edits (r5 first): read at c2, which the first request after the
	// checkpoint wrote (seen in its payload); the question stays pinned; the write anchor at c5 does not fit.
	session.append([user("Thanks. One more thing?", "u2")]);
	const next = claudeAuthPayload(10);
	next.messages.push({ role: "assistant", content: [{ type: "text", text: "All green." }] }, { role: "user", content: [{ type: "text", text: "Thanks. One more thing?", cache_control: { type: "ephemeral" } }] });
	for (const m of next.messages) for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === "tool_result") delete b.cache_control;
	providerRequest(next, ctx);
	assert.deepEqual(marks(next), ["messages[2].content[1]", "c2", "messages[35].content[0]"]);
	writeFileSync(configFile, JSON.stringify({ timeoutMs: 5_000 }));
});

test("turn_end: drafts that another handler drops or Pi rejects are judged again", async () => {
	writeFileSync(configFile, JSON.stringify({ timeoutMs: 5_000, midRunBreakEven: false }));
	const session = fakeSession(longRunEntries(9));
	const { ctx, calls } = sessionCtx(session);
	await handler("session_start")({ type: "session_start" }, ctx);
	const first = (await handler("turn_end")(turnEndOf(session), ctx)) as { entries: Json[] };
	assert.equal(first.entries.filter((e) => e.type === "context_edit").length, 4);
	// Not committed (a later handler returned other drafts, or one invalid draft discarded the list).
	const again = (await handler("turn_end")(turnEndOf(session), ctx)) as { entries: Json[] };
	assert.deepEqual(
		again.entries.filter((e) => e.type === "context_edit").map((e) => e.targetId),
		["r1", "r2", "r3", "r4"],
	);
	assert.deepEqual(stepsAsked(calls), ["step 1", "step 2", "step 3", "step 4", "step 1", "step 2", "step 3", "step 4"]);
	// No pending edits on the branch: no read point.
	const payload = claudeAuthPayload(9);
	providerRequest(payload, ctx);
	assert.deepEqual(marks(payload), ["messages[2].content[1]", "c8"]);
	writeFileSync(configFile, JSON.stringify({ timeoutMs: 5_000 }));
});

test("turn_end: unanswered outputs (error) are asked again at the next checkpoint", async () => {
	writeFileSync(configFile, JSON.stringify({ timeoutMs: 5_000, midRunBreakEven: false, midRunBatchChars: 1 }));
	const session = fakeSession(longRunEntries(9));
	let fail = true;
	const answers = (request: ClassifierRequest): ClassifierResponse =>
		fail && JSON.stringify(request.state.chunks).includes("out2 ") ? { answers: {}, stopReason: "error", errorMessage: "rate limited" } : fakeAnswers(request);
	const { ctx, calls } = sessionCtx(session, answers);
	await handler("session_start")({ type: "session_start" }, ctx);
	const first = (await handler("turn_end")(turnEndOf(session), ctx)) as { entries: Json[] };
	assert.deepEqual(
		first.entries.at(-1)!.data.results.map((r: Json) => [r.entryId, r.reason]),
		[
			["r1", "chunks"],
			["r2", "error"],
			["r3", "chunks"],
			["r4", "chunks"],
		],
	);
	session.commit(first.entries);
	fail = false;
	const second = (await handler("turn_end")(turnEndOf(session), ctx)) as { entries: Json[] };
	assert.deepEqual(stepsAsked(calls.slice(4)), ["step 2"]);
	assert.deepEqual(
		second.entries.filter((e) => e.type === "context_edit").map((e) => e.targetId),
		["r2"],
	);
	writeFileSync(configFile, JSON.stringify({ timeoutMs: 5_000 }));
});

test("turn_end: the memo follows the branch (/tree back before a checkpoint)", async () => {
	writeFileSync(configFile, JSON.stringify({ timeoutMs: 5_000, midRunBreakEven: false }));
	const session = fakeSession(longRunEntries(9));
	const { ctx, calls } = sessionCtx(session);
	await handler("session_start")({ type: "session_start" }, ctx);
	const before = session.branch.length;
	session.commit(((await handler("turn_end")(turnEndOf(session), ctx)) as { entries: Json[] }).entries);
	assert.equal(await handler("turn_end")(turnEndOf(session), ctx), undefined);
	// /tree to the entry before the checkpoint: its record and edits are no longer on the branch.
	session.branch.splice(before);
	await handler("session_tree")({ type: "session_tree" }, ctx);
	const result = (await handler("turn_end")(turnEndOf(session), ctx)) as { entries: Json[] };
	assert.equal(result.entries.filter((e) => e.type === "context_edit").length, 4);
	assert.equal(calls.length, 8);
	writeFileSync(configFile, JSON.stringify({ timeoutMs: 5_000 }));
});

test("before_provider_request: an edit of the run's first output falls back to the question pin", () => {
	const session = fakeSession(longRunEntries(5));
	session.commit([{ type: "context_edit", targetId: "r0", replacement: { content: [{ type: "text", text: "[context-guard] …" }] } }]);
	const { ctx } = sessionCtx(session);
	const payload = claudeAuthPayload(5);
	providerRequest(payload, ctx);
	// The question block (behind the relocated system prompt) is pinned, so its cache entry is read; c0
	// gets a write anchor for the next checkpoint.
	handler("session_start")({ type: "session_start" }, ctx);
	assert.deepEqual(marks(payload), ["messages[2].content[1]", "c0", "c4"]);
	assert.equal(countMarks(payload), 4);
});

test("turn_end: midRun off and other outcomes do nothing", async () => {
	const session = fakeSession(longRunEntries(9));
	const { ctx, calls } = sessionCtx(session);
	writeFileSync(configFile, JSON.stringify({ timeoutMs: 5_000, midRunBreakEven: false, midRun: false }));
	await handler("session_start")({ type: "session_start" }, ctx);
	assert.equal(await handler("turn_end")(turnEndOf(session), ctx), undefined);
	writeFileSync(configFile, JSON.stringify({ timeoutMs: 5_000, midRunBreakEven: false }));
	await handler("session_start")({ type: "session_start" }, ctx);
	assert.equal(await handler("turn_end")({ ...turnEndOf(session), outcome: "aborted" }, ctx), undefined);
	assert.equal(calls.length, 0);
	writeFileSync(configFile, JSON.stringify({ timeoutMs: 5_000 }));
	await handler("session_start")({ type: "session_start" }, ctx);
});

test("before_provider_request: read points only from entries this process placed (model, TTL, reload, budget)", async (t) => {
	const session = fakeSession(longRunEntries(6));
	const { ctx } = sessionCtx(session);
	await handler("session_start")({ type: "session_start" }, ctx);
	const sonnet = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-5-5" };
	const opus = { api: "anthropic-messages", provider: "anthropic", id: "claude-opus-5-5" };
	const send = (payload: Json, model = sonnet) => handler("before_provider_request")({ type: "before_provider_request", payload }, { ...ctx, model });
	const edited = () => {
		session.commit([{ type: "context_edit", targetId: "r4", replacement: { content: [{ type: "text", text: "[context-guard] …" }] } }]);
		return claudeAuthPayload(6);
	};
	let now = 1_000_000;
	t.mock.method(Date, "now", () => now);

	// A request at turn 4 wrote its rolling entry at c3; the next turns follow.
	const atTurn4 = claudeAuthPayload(4);
	send(atTurn4);
	assert.deepEqual(marks(atTurn4), ["messages[2].content[1]", "c3"]);
	session.append([assistant("", [{ id: "c6", name: "bash", arguments: { command: "step 6" } }], "t6")]);

	// Edit of r4 a minute later: read at c3 (same model, within the TTL, untouched).
	now += 60_000;
	const p1 = edited();
	send(p1);
	assert.deepEqual(marks(p1), ["messages[2].content[1]", "c3", "c5"]);

	// Another model: its cache has no such entry.
	const p2 = claudeAuthPayload(6);
	send(p2, opus);
	assert.deepEqual(marks(p2), ["messages[2].content[1]", "c4", "c5"]);

	// After the TTL: not trusted.
	now += 5 * 60_000 + 1;
	const p3 = claudeAuthPayload(6);
	send(p3);
	assert.deepEqual(marks(p3), ["messages[2].content[1]", "c4", "c5"]);

	// After a reload (session_start): the log is empty.
	now -= 5 * 60_000 + 1;
	await handler("session_start")({ type: "session_start" }, ctx);
	const p4 = claudeAuthPayload(6);
	send(p4);
	assert.deepEqual(marks(p4), ["messages[2].content[1]", "c4", "c5"]);
});

test("before_provider_request: an anchor dropped for the budget, or pinning off, is never logged as written", async () => {
	const session = fakeSession(longRunEntries(6));
	const { ctx } = sessionCtx(session);
	await handler("session_start")({ type: "session_start" }, ctx);
	session.commit([{ type: "context_edit", targetId: "r3", replacement: { content: [{ type: "text", text: "[context-guard] …" }] } }]);
	// Another extension added a breakpoint on the first message; the write anchor at c3 does not fit.
	const crowded = claudeAuthPayload(6);
	crowded.messages[0].content[0].cache_control = { type: "ephemeral" };
	providerRequest(crowded, ctx);
	assert.deepEqual(marks(crowded), ["messages[0].content[0]", "messages[2].content[1]", "c5"]);
	session.append([assistant("", [{ id: "c6", name: "bash", arguments: { command: "step 6" } }], "t6")]);
	// The next edit (r5) must not read at c3: it was never sent.
	session.commit([{ type: "context_edit", targetId: "r5", replacement: { content: [{ type: "text", text: "[context-guard] …" }] } }]);
	const next = claudeAuthPayload(6);
	providerRequest(next, ctx);
	assert.equal(marks(next).includes("c3"), false);

	// History made with pinning off leaves no log entries either.
	writeFileSync(configFile, JSON.stringify({ timeoutMs: 5_000, pinAnthropicCache: false }));
	await handler("session_start")({ type: "session_start" }, ctx);
	const off = claudeAuthPayload(6);
	providerRequest(off, ctx);
	assert.deepEqual(marks(off), ["c5"]);
	writeFileSync(configFile, JSON.stringify({ timeoutMs: 5_000 }));
	await handler("session_start")({ type: "session_start" }, ctx);
	session.commit([{ type: "context_edit", targetId: "r1", replacement: { content: [{ type: "text", text: "[context-guard] …" }] } }]);
	const on = claudeAuthPayload(6);
	providerRequest(on, ctx);
	assert.deepEqual(marks(on), ["messages[2].content[1]", "c1", "c5"]);
});

test("message_end: a response that read through a logged entry keeps it trusted past 5 minutes", async (t) => {
	const session = fakeSession(longRunEntries(6));
	// The run's first response: system prompt, tools and question ≈ 5.8k tokens.
	(session.branch.find((e) => e.id === "t0") as Json).message.usage = { input: 4, cacheRead: 1_431, cacheWrite: 4_400 };
	const { ctx } = sessionCtx(session);
	await handler("session_start")({ type: "session_start" }, ctx);
	const sonnet = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-5-5" };
	const send = (payload: Json, model = sonnet) => handler("before_provider_request")({ type: "before_provider_request", payload }, { ...ctx, model });
	const answer = (cacheRead: number, model = "claude-sonnet-5-5") =>
		handler("message_end")({ type: "message_end", message: { role: "assistant", provider: "anthropic", model, content: [], usage: { cacheRead } } }, { ...ctx, model: sonnet });
	let now = 1_000_000;
	t.mock.method(Date, "now", () => now);

	// A request at turn 4 writes its rolling entry at c3.
	send(claudeAuthPayload(4));
	// Four minutes later a request reads 60k tokens: far beyond c3 (≈ 5.8k + 4 × 18k chars / 1.5 ≈ 54k).
	now += 4 * 60_000;
	send(claudeAuthPayload(6));
	await answer(60_000);
	// Another four minutes (8 minutes after the write): an edit of r4 still reads at c3.
	now += 4 * 60_000;
	session.commit([{ type: "context_edit", targetId: "r4", replacement: { content: [{ type: "text", text: "[context-guard] …" }] } }]);
	const p1 = claudeAuthPayload(6);
	send(p1);
	assert.deepEqual(marks(p1), ["messages[2].content[1]", "c3", "c5"]);
});

test("message_end: no refresh from a short read or another model's response", async (t) => {
	const session = fakeSession(longRunEntries(6));
	(session.branch.find((e) => e.id === "t0") as Json).message.usage = { input: 4, cacheRead: 1_431, cacheWrite: 4_400 };
	const { ctx } = sessionCtx(session);
	await handler("session_start")({ type: "session_start" }, ctx);
	const sonnet = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-5-5" };
	const send = (payload: Json) => handler("before_provider_request")({ type: "before_provider_request", payload }, { ...ctx, model: sonnet });
	const answer = (cacheRead: number, model = "claude-sonnet-5-5") =>
		handler("message_end")({ type: "message_end", message: { role: "assistant", provider: "anthropic", model, content: [], usage: { cacheRead } } }, { ...ctx, model: sonnet });
	let now = 1_000_000;
	t.mock.method(Date, "now", () => now);
	send(claudeAuthPayload(4));
	now += 4 * 60_000;
	send(claudeAuthPayload(6));
	await answer(5_835); // only the system prompt and question
	send(claudeAuthPayload(6));
	await answer(60_000, "claude-opus-5-5"); // a response from another model
	now += 4 * 60_000;
	session.commit([{ type: "context_edit", targetId: "r4", replacement: { content: [{ type: "text", text: "[context-guard] …" }] } }]);
	const p1 = claudeAuthPayload(6);
	send(p1);
	assert.deepEqual(marks(p1), ["messages[2].content[1]", "c4", "c5"]);
});
