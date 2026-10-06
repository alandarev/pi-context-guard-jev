import assert from "node:assert/strict";
import { test } from "node:test";
import { type Chunk, type ChunkOptions, chunkOutput, grepFile, isGrepLike, segmentChunks } from "../../src/chunk.ts";
import { grepOutput, lines } from "./fixtures.ts";

/** Chunks are contiguous, cover every line exactly once, and `text` is the joined lines. */
function assertCovers(text: string, chunks: readonly Chunk[]) {
	const all = text.split("\n");
	assert.ok(chunks.length > 0);
	let next = 0;
	chunks.forEach((chunk, i) => {
		assert.equal(chunk.index, i);
		assert.equal(chunk.start, next, `chunk ${i} starts where the previous ended`);
		assert.ok(chunk.end > chunk.start, `chunk ${i} is not empty`);
		assert.equal(chunk.text, all.slice(chunk.start, chunk.end).join("\n"));
		next = chunk.end;
	});
	assert.equal(next, all.length);
	assert.equal(chunks.map((c) => c.text).join("\n"), text);
}

test("grepFile recognises rg match and context lines", () => {
	assert.equal(grepFile("src/a.ts:12:const a = 1;"), "src/a.ts");
	assert.equal(grepFile("src/a.ts-13-const b = 2;"), "src/a.ts");
	assert.equal(grepFile("src/my-file.ts:3:x"), "src/my-file.ts");
	assert.equal(grepFile("src/my-file.ts-4-x"), "src/my-file.ts");
	assert.equal(grepFile("docs/2024-05-01-post.md:3:hello"), "docs/2024-05-01-post.md");
	assert.equal(grepFile("--"), "");
	assert.equal(grepFile("plain text line"), undefined);
	assert.equal(grepFile(" indented:1:x"), undefined);
	assert.equal(grepFile(""), undefined);
});

test("isGrepLike needs at least three lines and 60% matches", () => {
	assert.equal(isGrepLike(["a.ts:1:x", "a.ts:2:y"]), false);
	assert.equal(isGrepLike(["a.ts:1:x", "a.ts-2-y", "--", "b.ts:9:z", ""]), true);
	assert.equal(isGrepLike(["a.ts:1:x", "b.ts:2:y", "hello", "world", "again"]), false);
	assert.equal(isGrepLike(["a.ts:1:x", "b.ts:2:y", "c.ts:3:z", "note", "more"]), true);
	assert.equal(isGrepLike(lines(10).split("\n")), false);
});

test("grep output is grouped by file", () => {
	// 3 files × 12 matches ≈ 0.9k chars per file: each group is between target/4 and 1.5 × target.
	const files = ["src/alpha.ts", "src/my-beta.ts", "docs/2024-05-01-post.md"];
	const text = grepOutput(files, 12);
	const chunks = chunkOutput(text, { maxChunks: 120, minTargetChars: 1_000, maxTargetChars: 4_000 });
	assertCovers(text, chunks);
	assert.deepEqual(
		chunks.map((c) => c.files),
		files.map((f) => [f]),
	);
	assert.deepEqual(
		chunks.map((c) => [c.start, c.end]),
		[
			[0, 12],
			[12, 24],
			[24, 36],
		],
	);
});

test("context lines and -- separators stay with their file", () => {
	const block = (file: string, n: number) => [
		`${file}-${n - 1}-before`.padEnd(70, "."),
		`${file}:${n}:match`.padEnd(70, "."),
		`${file}-${n + 1}-after`.padEnd(70, "."),
		"--",
	];
	const text = [...block("src/a-b.ts", 10), ...block("src/a-b.ts", 30), ...block("lib/c.ts", 5), ...block("lib/c.ts", 50)].join("\n");
	const chunks = chunkOutput(text, { maxChunks: 120, minTargetChars: 600, maxTargetChars: 600 });
	assertCovers(text, chunks);
	assert.deepEqual(
		chunks.map((c) => c.files),
		[["src/a-b.ts"], ["lib/c.ts"]],
	);
	assert.equal(chunks[0].end, 8);
});

test("context lines of files named with -digits- resolve to the matched file", () => {
	const known = new Set(["docs/2024-05-01-post.md", "docs/2024"]);
	assert.equal(grepFile("docs/2024-05-01-post.md-4-context", known), "docs/2024-05-01-post.md");
	assert.equal(grepFile("docs/2024-05-01-post.md-4-context"), "docs/2024");
	const block = (file: string, n: number) => [
		`${file}-${n - 1}-before`.padEnd(70, "."),
		`${file}:${n}:match`.padEnd(70, "."),
		`${file}-${n + 1}-after`.padEnd(70, "."),
		"--",
	];
	const text = [...block("docs/2024-05-01-a.md", 10), ...block("docs/2024-05-01-a.md", 30), ...block("docs/2024-06-02-b.md", 5)].join("\n");
	const chunks = chunkOutput(text, { maxChunks: 120, minTargetChars: 500, maxTargetChars: 500 });
	assertCovers(text, chunks);
	assert.deepEqual(
		chunks.map((c) => [c.start, c.end, c.files]),
		[
			[0, 8, ["docs/2024-05-01-a.md"]],
			[8, 12, ["docs/2024-06-02-b.md"]],
		],
	);
});

test("big grep groups are split, all pieces naming the file", () => {
	const text = grepOutput(["src/huge.ts", "src/small.ts"], 100);
	const options: ChunkOptions = { maxChunks: 120, minTargetChars: 1_000, maxTargetChars: 1_000 };
	const chunks = chunkOutput(text, options);
	assertCovers(text, chunks);
	assert.ok(chunks.length > 4);
	for (const chunk of chunks) {
		assert.equal(chunk.files.length, 1);
		assert.ok(chunk.text.length <= 1_000, `chunk ${chunk.index} is ${chunk.text.length} chars`);
	}
	assert.ok(chunks.some((c) => c.files[0] === "src/small.ts"));
	// A split never mixes files.
	for (const chunk of chunks) assert.ok(chunk.text.split("\n").every((line) => line.startsWith(`${chunk.files[0]}:`)));
});

test("tiny grep groups are merged up to half the target", () => {
	const files = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
	const text = grepOutput(files, 1, 20); // ~30 chars per file
	const chunks = chunkOutput(text, { maxChunks: 120, minTargetChars: 800, maxTargetChars: 800 });
	assertCovers(text, chunks);
	assert.ok(chunks.length < files.length);
	assert.ok(chunks.length >= 3);
	for (const chunk of chunks) assert.ok(chunk.text.length + 1 <= 400);
	assert.deepEqual(
		chunks.flatMap((c) => c.files),
		files,
	);
});

test("plain text is cut into windows, preferring blank lines", () => {
	const paragraph = (n: number) => lines(8, `p${n}`, 50);
	const text = Array.from({ length: 10 }, (_, i) => paragraph(i)).join("\n\n");
	const chunks = chunkOutput(text, { maxChunks: 120, minTargetChars: 1_000, maxTargetChars: 1_000 });
	assertCovers(text, chunks);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) {
		assert.deepEqual(chunk.files, []);
		assert.ok(chunk.text.length <= 1_000);
	}
	// Every chunk but the last ends right after a blank line.
	for (const chunk of chunks.slice(0, -1)) assert.equal(text.split("\n")[chunk.end - 1], "", `chunk ${chunk.index} ends on a blank line`);
});

test("chunk size grows to respect maxChunks", () => {
	const text = lines(2_000);
	const chunks = chunkOutput(text, { maxChunks: 10, minTargetChars: 100, maxTargetChars: 500 });
	assertCovers(text, chunks);
	assert.ok(chunks.length <= 11, `${chunks.length} chunks`);
});

test("a single very long line becomes its own chunk", () => {
	const text = `short\n${"z".repeat(10_000)}\nshort again`;
	const chunks = chunkOutput(text, { maxChunks: 120, minTargetChars: 800, maxTargetChars: 800 });
	assertCovers(text, chunks);
	assert.ok(chunks.some((c) => c.text === "z".repeat(10_000)));
});

test("default options chunk a typical output", () => {
	const text = lines(1_000);
	const chunks = chunkOutput(text);
	assertCovers(text, chunks);
	assert.ok(chunks.length <= 121);
});

test("segmentChunks respects both limits", () => {
	const chunks = chunkOutput(lines(400), { maxChunks: 120, minTargetChars: 500, maxTargetChars: 500 });
	assert.ok(chunks.length > 20);

	const byChars = segmentChunks(chunks, 2_000, 100);
	const byCount = segmentChunks(chunks, 1_000_000, 7);
	for (const [segments, maxChars, maxCount] of [
		[byChars, 2_000, 100],
		[byCount, 1_000_000, 7],
	] as const) {
		assert.deepEqual(segments.flat(), chunks);
		for (const segment of segments) {
			assert.ok(segment.length >= 1 && segment.length <= maxCount);
			assert.ok(segment.reduce((n, c) => n + c.text.length + 1, 0) <= maxChars);
		}
	}
	assert.ok(byChars.length > 1);
	assert.equal(byCount.length, Math.ceil(chunks.length / 7));
	assert.deepEqual(segmentChunks([], 100, 10), []);
});

test("segmentChunks puts an oversized chunk in its own segment", () => {
	const chunks = chunkOutput(`a\n${"z".repeat(5_000)}\nb`, { maxChunks: 120, minTargetChars: 100, maxTargetChars: 100 });
	const segments = segmentChunks(chunks, 1_000, 10);
	assert.deepEqual(segments.flat(), chunks);
	assert.ok(segments.some((s) => s.length === 1 && s[0].text.length === 5_000));
});
