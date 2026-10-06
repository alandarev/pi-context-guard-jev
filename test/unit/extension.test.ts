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
	for (const event of ["session_start", "session_tree", "session_compact", "agent_settled", "agent_before_settle", "before_provider_request"]) {
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
