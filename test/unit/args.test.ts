import assert from "node:assert/strict";
import { test } from "node:test";
import { ARG_MARKER, argsElided, argsLabel, collectArgs, elidedCalls, elideString, originalCalls } from "../../src/args.ts";
import { collectExchanges, exchangeEdits } from "../../src/items.ts";
import { addArgs, dropOutputs, dropRuleEdits, emptyOutcome, outputEdits, ruleEdits } from "../../src/process.ts";
import { originalContent } from "../../src/recall.ts";
import { MARKER } from "../../src/render.ts";
import { contentChars } from "../../src/size.ts";
import { computeStats, formatStatus } from "../../src/stats.ts";
import type { Block, ProjectedEntryLike } from "../../src/types.ts";
import { assistant, entry, lines, toolResult, user } from "./fixtures.ts";

const file = lines(100, "row", 40); // 100 lines, ~4k chars
const script = `cat <<'EOF' > gen.py\n${lines(120, "code", 40)}\nEOF\npython3 gen.py`;

/** A run: a write, a long bash heredoc, a recall, a failed write, a short bash, an edit, then 4 more turns. */
const writeRun = (): ProjectedEntryLike[] => [
	user("Generate the files", "u1"),
	entry(
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Write the file first.", thinkingSignature: "sig".repeat(100) },
				{ type: "text", text: "Writing." },
				{ type: "toolCall", id: "c1", name: "write", arguments: { path: "src/a.txt", content: file } },
				{ type: "toolCall", id: "c2", name: "bash", arguments: { command: script, timeout: 30 } },
			],
		},
		"a1",
	),
	toolResult("c1", "write", "Successfully wrote", "r1"),
	toolResult("c2", "bash", "ok", "r2"),
	assistant("", [{ id: "c3", name: "recall", arguments: { entryId: "x".repeat(3_000) } }], "a2"),
	toolResult("c3", "recall", "original", "r3"),
	assistant("", [{ id: "c4", name: "write", arguments: { path: "/root/b.txt", content: file } }], "a3"),
	toolResult("c4", "write", "EACCES", "r4", { isError: true }),
	assistant("", [{ id: "c5", name: "bash", arguments: { command: "ls" } }], "a4"),
	toolResult("c5", "bash", "a.txt", "r5"),
	assistant("", [{ id: "c6", name: "edit", arguments: { path: "src/x.ts", edits: [{ oldText: lines(80, "old"), newText: lines(80, "new") }, { oldText: "a", newText: "b" }] } }], "a5"),
	toolResult("c6", "edit", "Applied", "r6"),
	assistant("", [{ id: "c7", name: "write", arguments: { path: "src/late.txt", content: file } }], "a6"),
	toolResult("c7", "write", "Successfully wrote", "r7"),
	assistant("one", [], "a7"),
	assistant("two", [], "a8"),
	assistant("Done.", [], "a9"),
];

const toolCalls = (content: Block[]) => content.filter((b) => b.type === "toolCall");

test("elideString keeps head and tail lines around one marker line", () => {
	const short = elideString(file, "a1", 2_000)!;
	const kept = short.split("\n");
	assert.deepEqual(kept.slice(0, 12), file.split("\n").slice(0, 12));
	assert.deepEqual(kept.slice(-6), file.split("\n").slice(-6));
	assert.equal(kept.length, 19);
	assert.match(kept[12], /^\[context-guard: 3\.\dk chars \/ 82 lines omitted here afterwards to save context; the call ran with the full value and succeeded\. recall\(\{"entryId":"a1"\}\) shows it\]$/);
	assert.equal(elideString(file, "a1", file.length), undefined, "saving below the minimum");
	assert.equal(elideString(short, "a1", 100), undefined, "already shortened");
	// One long line: characters, not lines.
	const oneLine = elideString("y".repeat(5_000), "a1", 2_000)!;
	assert.ok(oneLine.startsWith(`${"y".repeat(600)}\n${ARG_MARKER}3.8k chars omitted`), oneLine.slice(590, 640));
	assert.ok(oneLine.endsWith(`]\n${"y".repeat(600)}`));
});

test("collectArgs: long arguments of successful calls at least keepTurns old", () => {
	const items = collectArgs(writeRun(), 4, 2_000);
	// a1: 8 assistant messages after it; a2 is recall; a3 failed; a4 is short; a5: 4 after; a6: 3 after.
	assert.deepEqual(
		items.map((i) => [i.entryId, i.age, i.calls, i.strings, argsLabel(i)]),
		[
			["a1", 8, 2, 2, "write src/a.txt +1 call (2 args)"],
			["a5", 4, 1, 2, "edit src/x.ts (2 args)"],
		],
	);
	assert.equal(collectArgs(writeRun(), 0, 2_000).length, 0, "0 turns it off");
	assert.deepEqual(
		collectArgs(writeRun(), 3, 2_000).map((i) => i.entryId),
		["a1", "a5", "a6"],
	);
	assert.deepEqual(
		collectArgs(writeRun(), 4, 10_000).map((i) => i.entryId),
		[],
		"nothing saves 10k",
	);
});

test("collectArgs: the replacement keeps thinking, signature, text, ids, names, keys and short values", () => {
	const run = writeRun();
	const [a1, a5] = collectArgs(run, 4, 2_000);
	const original = run[1].messages[0].content as Block[];
	assert.equal(a1.replacement.length, original.length);
	assert.deepEqual(a1.replacement.slice(0, 2), original.slice(0, 2), "thinking with its signature and text unchanged");
	const [write, bash] = toolCalls(a1.replacement);
	assert.deepEqual([write.id, write.name, bash.id, bash.name], ["c1", "write", "c2", "bash"]);
	const writeArgs = write.arguments as Record<string, unknown>;
	const bashArgs = bash.arguments as Record<string, unknown>;
	assert.equal(writeArgs.path, "src/a.txt");
	assert.equal(writeArgs.content, elideString(file, "a1", 2_000));
	assert.equal(bashArgs.timeout, 30);
	assert.ok(String(bashArgs.command).startsWith("cat <<'EOF' > gen.py\n"));
	assert.ok(String(bashArgs.command).endsWith("EOF\npython3 gen.py"));
	assert.equal(a1.beforeChars, contentChars(original));
	assert.equal(a1.afterChars, contentChars(a1.replacement));
	assert.ok(a1.beforeChars - a1.afterChars > 5_000);
	// The raw message is not mutated.
	assert.equal((toolCalls(original)[0].arguments as Record<string, unknown>).content, file);
	// Structured values keep their structure; only long string leaves shrink.
	const edits = (toolCalls(a5.replacement)[0].arguments as { edits: { oldText: string; newText: string }[] }).edits;
	assert.equal(edits.length, 2);
	assert.ok(edits[0].oldText.includes(ARG_MARKER) && edits[0].newText.includes(ARG_MARKER));
	assert.deepEqual(edits[1], { oldText: "a", newText: "b" });
});

test("collectArgs: shortened, foreign-edited and omitted messages are skipped", () => {
	const run = writeRun();
	const [a1] = collectArgs(run, 4, 2_000);
	const edit = (id: string, content: Block[] | null) =>
		run.map((e) => (e.sourceEntry.id === id ? { ...e, messages: content === null ? [] : [{ ...e.messages[0], content }] } : e));
	// Shortened by us: the model sees our marker lines.
	const ours = edit("a1", a1.replacement);
	assert.ok(argsElided(ours[1].messages[0], ours[1].sourceEntry.message));
	assert.equal(elidedCalls(ours[1].messages[0]), 2);
	assert.deepEqual(
		collectArgs(ours, 4, 2_000).map((i) => i.entryId),
		["a5"],
	);
	// Another extension changed it: left alone.
	const foreign = edit("a1", [{ type: "text", text: "redacted" }, ...(run[1].messages[0].content as Block[]).slice(2)]);
	assert.ok(!argsElided(foreign[1].messages[0], foreign[1].sourceEntry.message));
	assert.deepEqual(
		collectArgs(foreign, 4, 2_000).map((i) => i.entryId),
		["a5"],
	);
	// Omitted (an exchange omission).
	assert.deepEqual(
		collectArgs(edit("a1", null), 4, 2_000).map((i) => i.entryId),
		["a5"],
	);
});

test("addArgs: one edit per assistant entry with its whole content; an exchange omission wins", () => {
	const items = collectArgs(writeRun(), 4, 2_000);
	const outcome = emptyOutcome();
	outcome.edits.push({ type: "context_edit", targetId: "a5", replacement: null });
	addArgs(outcome, items);
	assert.deepEqual(
		outcome.edits.map((e) => [e.targetId, e.replacement === null ? null : e.replacement.content.length]),
		[
			["a5", null],
			["a1", 4],
		],
	);
	assert.deepEqual(
		outcome.records.map((r) => [r.kind, r.entryId, r.outcome, r.reason, r.label, r.requests]),
		[["args", "a1", "removed", "8 turns old", "write src/a.txt +1 call (2 args)", 0]],
	);
	assert.equal(outcome.savedChars, items[0].beforeChars - items[0].afterChars);
	// Gates: argument edits count as output edits only when listed; they can be dropped like images.
	assert.deepEqual([...outputEdits(outcome, new Set()).ids], []);
	assert.deepEqual([...outputEdits(outcome, new Set(["a1"])).ids], ["a1"]);
	const dropped = structuredClone(outcome);
	dropOutputs(dropped, new Set(["a1"]));
	assert.deepEqual([dropped.records.length, dropped.savedChars, dropped.edits.length], [0, 0, 1]);
	// The early gate drops only the rule edits: the exchange omission of a5 stays.
	assert.deepEqual([...ruleEdits(outcome, new Set(["a1", "a5"])).ids], ["a1"]);
	dropRuleEdits(outcome, new Set(["a1", "a5"]));
	assert.deepEqual([outcome.records.length, outcome.savedChars], [0, 0]);
	assert.deepEqual(outcome.edits, [{ type: "context_edit", targetId: "a5", replacement: null }]);
});

test("exchanges: our shortened arguments keep an exchange eligible, and its omission covers them", () => {
	const old = writeRun();
	const later = [user("next question", "u2"), assistant("answer", [], "b1"), user("current", "u3"), assistant("working", [], "c1x")];
	const [a1] = collectArgs(old, 4, 2_000);
	const shortened = old.map((e) => (e.sourceEntry.id === "a1" ? { ...e, messages: [{ ...e.messages[0], content: a1.replacement }] } : e));
	const entries = [...shortened, ...later];
	const runStart = entries.findIndex((e) => e.sourceEntry.id === "u3");
	const [item] = collectExchanges(entries, runStart, 1, new Set());
	assert.equal(item?.entryId, "u1");
	assert.ok(item.omitIds.includes("a1"));
	assert.ok(exchangeEdits(item).some((e) => e.targetId === "a1" && e.replacement === null));
	// A foreign edit of the same message still blocks it.
	const foreign = [...old.map((e) => (e.sourceEntry.id === "a1" ? { ...e, messages: [{ ...e.messages[0], content: [{ type: "text", text: "x" }] }] } : e)), ...later];
	assert.deepEqual(collectExchanges(foreign, runStart, 1, new Set()), []);
});

test("computeStats counts shortened tool calls and their saving; the footer counts them", () => {
	const run = writeRun();
	const [a1] = collectArgs(run, 4, 2_000);
	const projection = run.map((e) => (e.sourceEntry.id === "a1" ? { ...e, messages: [{ ...e.messages[0], content: a1.replacement }] } : e));
	const stats = computeStats(projection, []);
	assert.equal(stats.argCalls, 2);
	assert.equal(stats.distilledResults, 0);
	assert.equal(stats.savedChars, a1.beforeChars - a1.afterChars);
	assert.match(formatStatus(stats, "ready", (_c, t) => t), / · 2$/);
});

test("recall of an assistant entry returns its original tool calls", () => {
	const run = writeRun();
	const { text, images } = originalContent(run[1].sourceEntry, "a1");
	assert.deepEqual(images, []);
	assert.equal(text, originalCalls(run[1].sourceEntry.message!));
	assert.ok(text.startsWith(`[tool call] write\n--- path ---\nsrc/a.txt\n--- content ---\n${file}\n\n[tool call] bash\n--- command ---\n${script}\n--- timeout ---\n30`));
	assert.ok(!text.includes(MARKER));
	const edit = originalContent(run[10].sourceEntry, "a5").text;
	assert.ok(edit.includes('--- edits ---\n[\n  {\n    "oldText": "old 1'));
	assert.throws(() => originalContent(run[15].sourceEntry, "a8"), /No tool result or omitted exchange/);
});
