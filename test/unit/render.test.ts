import assert from "node:assert/strict";
import { test } from "node:test";
import { type Chunk, chunkOutput } from "../../src/chunk.ts";
import { formatChars, MARKER, renderReplacement, toolLabel } from "../../src/render.ts";
import { grepOutput, lines } from "./fixtures.ts";

const windowed = (text: string): Chunk[] => chunkOutput(text, { maxChunks: 120, minTargetChars: 300, maxTargetChars: 300 });

test("formatChars", () => {
	assert.equal(formatChars(999), "999");
	assert.equal(formatChars(1_500), "1.5k");
	assert.equal(formatChars(2_300_000), "2.3M");
});

test("toolLabel variants", () => {
	assert.equal(toolLabel({ toolName: "bash", args: { command: "rg  -n\n foo   src" } }), "bash `rg -n foo src`");
	assert.equal(toolLabel({ toolName: "shell", args: { cmd: "ls" } }), "shell `ls`");
	assert.equal(toolLabel({ toolName: "read", args: { path: "src/a.ts", offset: 3 } }), "read src/a.ts");
	assert.equal(toolLabel({ toolName: "view", args: { file_path: "b.ts" } }), "view b.ts");
	assert.equal(toolLabel({ toolName: "grep", args: { pattern: "foo|bar" } }), "grep `foo|bar`");
	assert.equal(toolLabel({ toolName: "search", args: { query: "q" } }), "search `q`");
	assert.equal(toolLabel({ toolName: "mystery", args: { n: 1 } }), "mystery");
	assert.equal(toolLabel({ toolName: "mystery", args: undefined }), "mystery");
	const long = toolLabel({ toolName: "bash", args: { command: "x".repeat(200) } });
	assert.equal(long, `bash \`${"x".repeat(79)}…\``);
});

test("renderReplacement keeps chunks verbatim with omission lines", () => {
	const text = lines(30, "row", 40);
	const chunks = windowed(text);
	assert.ok(chunks.length >= 4);
	const keep = new Set([1, chunks.length - 1]);
	const candidate = { entryId: "abc123", toolName: "bash", args: { command: "cat log" }, text };
	const result = renderReplacement(candidate, chunks, keep);
	const [header, ...body] = result.text.split("\n");

	assert.ok(header.startsWith(`${MARKER} Distilled the output of bash \`cat log\`: kept ${result.keptLines} of 30 lines`));
	assert.match(header, /Full output: recall\(\{"entryId":"abc123"\}\)\.$/);
	assert.equal(result.totalLines, 30);
	assert.equal(result.keptLines, chunks[1].end - chunks[1].start + chunks.at(-1)!.end - chunks.at(-1)!.start);

	const first = chunks[0];
	const expected = [
		`[… ${first.end} lines omitted (output lines 1–${first.end}) …]`,
		chunks[1].text,
		`[… ${chunks.at(-2)!.end - chunks[2].start} lines omitted (output lines ${chunks[2].start + 1}–${chunks.at(-2)!.end}) …]`,
		chunks.at(-1)!.text,
	];
	assert.equal(body.join("\n"), expected.join("\n"));
});

test("renderReplacement maps read offsets to file lines", () => {
	const text = lines(30, "row", 40);
	const chunks = windowed(text);
	const candidate = { entryId: "r", toolName: "read", args: { path: "src/big.ts", offset: 101 }, text };
	const result = renderReplacement(candidate, chunks, new Set([0]));
	const omitted = result.text.split("\n").at(-1);
	assert.equal(omitted, `[… ${30 - chunks[0].end} lines omitted (lines ${chunks[0].end + 101}–130 of src/big.ts) …]`);
	assert.match(result.text, /^\[context-guard\] Distilled the output of read src\/big\.ts:/);

	// No offset: lines start at 1.
	const noOffset = renderReplacement({ ...candidate, args: { path: "src/big.ts" } }, chunks, new Set([chunks.length - 1]));
	assert.match(noOffset.text, /\(lines 1–\d+ of src\/big\.ts\)/);
});

test("renderReplacement lists files for omitted grep chunks", () => {
	const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"];
	const text = grepOutput(files, 5, 40);
	const chunks = chunkOutput(text, { maxChunks: 120, minTargetChars: 300, maxTargetChars: 300 });
	assert.equal(chunks.length, files.length);
	const result = renderReplacement({ entryId: "g", toolName: "bash", args: { command: "rg x" }, text }, chunks, new Set([0]));
	const lastLine = result.text.split("\n").at(-1);
	assert.equal(lastLine, "[… 35 lines omitted: matches in b.ts, c.ts, d.ts, e.ts, f.ts and 2 more …]");
});

test("renderReplacement with nothing kept removes the output entirely", () => {
	const text = lines(1, "only", 2_000);
	const chunks = windowed(text);
	const result = renderReplacement({ entryId: "z", toolName: "bash", args: { command: "make" }, text }, chunks, new Set());
	assert.equal(
		result.text,
		`${MARKER} Removed the output of bash \`make\`: 1 line (2.0k chars) judged not needed for the answer. Full output: recall({"entryId":"z"}).`,
	);
	assert.equal(result.keptLines, 0);
	assert.equal(result.totalLines, 1);
});
