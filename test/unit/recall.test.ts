import assert from "node:assert/strict";
import { test } from "node:test";
import { omittedIdsFor, originalOutput, RECALL_MATCH_CHARS, RECALL_MAX_BYTES, RECALL_MAX_LINES, RECALL_MAX_PATTERN, recallText } from "../../src/recall.ts";

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

test("originalOutput returns the raw tool result text", () => {
	const entry = {
		id: "e1",
		type: "message",
		message: { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
	};
	assert.equal(originalOutput(entry, "e1"), "a\nb");
});

test("originalOutput rejects anything that is not a tool result", () => {
	assert.throws(() => originalOutput(undefined, "nope"), /No tool result or omitted exchange with entry id nope/);
	assert.throws(() => originalOutput({ id: "u", type: "message", message: { role: "user", content: "hi" } }, "u"), /No tool result/);
	assert.throws(() => originalOutput({ id: "c", type: "custom" }, "c"), /\[context-guard\]/);
});

test("recallText without options returns the whole output", () => {
	assert.equal(recallText(numbered(5), {}), numbered(5));
});

test("recallText pattern returns numbered matching lines", () => {
	const text = "alpha\nbeta\ngamma\nalphabet";
	assert.equal(recallText(text, { pattern: "^alpha" }), "1: alpha\n4: alphabet");
	assert.equal(recallText(text, { pattern: "zzz" }), "No line of the original output (4 lines) matches /zzz/.");
	assert.throws(() => recallText(text, { pattern: "(" }), /Invalid pattern/);
});

test("recallText offset/limit pages with a continuation note", () => {
	const text = numbered(10);
	assert.equal(recallText(text, { offset: 3, limit: 2 }), "line 3\nline 4\n\n[Showing lines 3–4 of 10. Use offset=5 to continue.]");
	assert.equal(recallText(text, { offset: 9, limit: 5 }), "line 9\nline 10");
	assert.equal(recallText(text, { offset: 11 }), "Offset 11 is beyond the end (10 lines).");
	assert.equal(
		recallText(text, { pattern: "line [0-9]$", offset: 2, limit: 3 }),
		"2: line 2\n3: line 3\n4: line 4\n\n[Showing matching lines 2–4 of 9. Use offset=5 to continue.]",
	);
});

test("recallText caps lines and bytes", () => {
	const many = recallText(numbered(RECALL_MAX_LINES + 10), {});
	assert.equal(many.split("\n").length, RECALL_MAX_LINES + 2);
	assert.match(many, new RegExp(`\\[Showing lines 1–${RECALL_MAX_LINES} of ${RECALL_MAX_LINES + 10}\\. Use offset=${RECALL_MAX_LINES + 1} to continue\\.\\]$`));

	const wide = Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(1_000, "é")).join("\n");
	const out = recallText(wide, {});
	const shown = out.split("\n\n[Showing")[0];
	assert.ok(Buffer.byteLength(shown, "utf8") <= RECALL_MAX_BYTES);
	assert.match(out, /\[Showing lines 1–(\d+) of 100\. Use offset=\d+ to continue\.\]$/);

});

test("recallText cuts a single line over the byte cap, keeping valid UTF-8", () => {
	const huge = "é".repeat(RECALL_MAX_BYTES); // 2 bytes per character
	const out = recallText(`${huge}\nnext line`, {});
	const [cut, note, blank, paging] = out.split("\n");
	assert.ok(Buffer.byteLength(out.split("\n\n[Showing")[0], "utf8") <= RECALL_MAX_BYTES);
	assert.ok(cut.length > 20_000 && huge.startsWith(cut), "a prefix of the line, whole characters only");
	assert.equal(Buffer.from(cut, "utf8").toString("utf8"), cut);
	assert.ok(!cut.includes("\uFFFD"));
	assert.equal(note, "[line 1 cut at 50KB]");
	assert.equal(blank, "");
	assert.equal(paging, "[Showing lines 1–1 of 2. Use offset=2 to continue.]");

	const later = recallText(`short\n${"x".repeat(RECALL_MAX_BYTES * 2)}`, {});
	assert.equal(later, "short\n\n[Showing lines 1–1 of 2. Use offset=2 to continue.]");
	const paged = recallText(`short\n${"x".repeat(RECALL_MAX_BYTES * 2)}`, { offset: 2 });
	assert.match(paged, /\n\[line 2 cut at 50KB\]$/);
	assert.ok(Buffer.byteLength(paged, "utf8") <= RECALL_MAX_BYTES);

	const matched = recallText(`a\n${"x".repeat(RECALL_MAX_BYTES * 2)}`, { pattern: "^x" });
	assert.ok(matched.startsWith("2: xxx"));
	assert.match(matched, /\n\[line 2 cut at 50KB\]$/);
});

test("recallText interrupts catastrophic backtracking", () => {
	const text = `ok\n${"a".repeat(40)}!\nok`;
	const started = Date.now();
	assert.throws(() => recallText(text, { pattern: "(a+)+$" }), /Pattern took too long .*use a simpler pattern/);
	assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
});

test("recallText limits pattern length and matched line length", () => {
	assert.throws(() => recallText("x", { pattern: "a".repeat(RECALL_MAX_PATTERN + 1) }), /longer than 500 characters/);
	assert.equal(recallText("ax", { pattern: `${"a".repeat(RECALL_MAX_PATTERN - 2)}|x` }), "1: ax");
	const long = `${"y".repeat(RECALL_MATCH_CHARS)}NEEDLE`;
	assert.match(recallText(long, { pattern: "NEEDLE" }), /^No line of the original output/);
	assert.match(recallText(`${"y".repeat(RECALL_MATCH_CHARS - 6)}NEEDLE`, { pattern: "NEEDLE$" }), /^1: y+NEEDLE$/);
});

test("originalOutput on an omitted exchange's prompt returns the whole exchange", () => {
	const branch = [
		{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "Which clients retry?" }] } },
		{ id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Searching." }, { type: "toolCall", name: "bash", arguments: { command: "rg retry" } }] } },
		{ id: "e1", type: "context_edit", targetId: "a1", replacement: null },
		{ id: "r1", type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "src/a.ts:3: retry" }] } },
		{ id: "n1", type: "custom_message", customType: "subagent", content: "worker done" },
		{ id: "a2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "a.ts retries." }] } },
		{ id: "u2", type: "message", message: { role: "user", content: [{ type: "text", text: "next" }] } },
	];
	const text = originalOutput(branch[0] as never, "u1", branch);
	assert.equal(
		text,
		[
			"## user",
			"Which clients retry?",
			"## assistant",
			"Searching.",
			'[tool call] bash {"command":"rg retry"}',
			"## tool result (bash)",
			"src/a.ts:3: retry",
			"## custom message (subagent)",
			"worker done",
			"## assistant",
			"a.ts retries.",
		].join("\n"),
	);
	assert.equal(recallText(text, { pattern: "retr" }), "2: Which clients retry?\n5: [tool call] bash {\"command\":\"rg retry\"}\n7: src/a.ts:3: retry\n11: a.ts retries.");
	// A user entry that is not on the branch: error.
	assert.throws(() => originalOutput(branch[0] as never, "u1", []), /No tool result or omitted exchange/);
});

test("recall of an omitted exchange uses the record's exact list of omitted entries", () => {
	const msg = (id: string, role: string, text: string) => ({ id, type: "message", message: { role, content: [{ type: "text", text }] } });
	const branch: Record<string, unknown>[] = [
		msg("u1", "user", "old prompt"),
		msg("a1", "assistant", "first reply"),
		msg("a2", "assistant", "second reply"),
		{ id: "rec", type: "custom", customType: "context-guard", data: { v: 1, results: [{ kind: "exchange", entryId: "u1", outcome: "removed", omitted: ["a1"] }] } },
		msg("u2", "user", "next"),
	];
	const ids = omittedIdsFor(branch as never, "u1", "context-guard");
	assert.deepEqual(ids, ["a1"]);
	assert.equal(originalOutput(branch[0] as never, "u1", branch as never, ids), "## user\nold prompt\n## assistant\nfirst reply");
	// Without a record: everything up to the next user message.
	assert.equal(originalOutput(branch[0] as never, "u1", branch as never), "## user\nold prompt\n## assistant\nfirst reply\n## assistant\nsecond reply");
	assert.equal(omittedIdsFor(branch as never, "u2", "context-guard"), undefined);
});
