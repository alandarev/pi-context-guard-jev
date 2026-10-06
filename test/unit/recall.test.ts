import assert from "node:assert/strict";
import { test } from "node:test";
import { originalOutput, RECALL_MAX_BYTES, RECALL_MAX_LINES, recallText } from "../../src/recall.ts";

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
	assert.throws(() => originalOutput(undefined, "nope"), /No tool result with entry id nope/);
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

	// A single line longer than the byte cap is still returned.
	const huge = "x".repeat(RECALL_MAX_BYTES * 2);
	assert.equal(recallText(huge, {}), huge);
});
