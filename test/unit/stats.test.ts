import assert from "node:assert/strict";
import { test } from "node:test";
import { MARKER } from "../../src/render.ts";
import { EXCHANGE_STUB_PREFIX } from "../../src/items.ts";
import { type Colorize, CUSTOM_TYPE, computeStats, formatCost, formatStatus, type GuardStats } from "../../src/stats.ts";
import type { MessageLike, ProjectedEntryLike } from "../../src/types.ts";

const tool = (text: string): MessageLike => ({ role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text }] });
const projected = (id: string, raw: MessageLike, now: MessageLike[]): ProjectedEntryLike => ({
	sourceEntry: { id, type: "message", message: raw },
	messages: now,
});

test("computeStats counts only results distilled in the current projection", () => {
	const raw = "x".repeat(1_000);
	const projection = [
		projected("distilled", tool(raw), [tool(`${MARKER} kept 1 line`)]),
		projected("untouched", tool(raw), [tool(raw)]),
		// Raw output that itself starts with the marker (e.g. an output quoting a replacement).
		projected("raw-marker", tool(`${MARKER} raw`), [tool(`${MARKER} raw`)]),
		// A user message mentioning the marker.
		projected("user", { role: "user", content: `${MARKER} hi` }, [{ role: "user", content: `${MARKER} hi` }]),
		{ sourceEntry: { id: "compaction", type: "compaction" }, messages: [tool(`${MARKER} x`)] },
		projected("multi", tool(raw), [tool(`${MARKER} a`), tool(`${MARKER} b`)]),
	];
	const stats = computeStats(projection, []);
	assert.equal(stats.distilledResults, 1);
	assert.equal(stats.savedChars, 1_000 - `${MARKER} kept 1 line`.length);
	assert.equal(stats.savedTokens, Math.round(stats.savedChars / 4));
	assert.equal(stats.runs, 0);
	assert.equal(stats.last, undefined);
});

test("computeStats sums context-guard custom entries", () => {
	const record = (requests: number, costUsd: number) => ({ v: 1, requests, costUsd, model: "m", results: [] });
	const branch = [
		{ type: "custom", customType: CUSTOM_TYPE, data: record(2, 0.01) },
		{ type: "custom", customType: "other", data: record(50, 5) },
		{ type: "message" },
		{ type: "custom", customType: CUSTOM_TYPE, data: { v: 2, requests: 9 } },
		{ type: "custom", customType: CUSTOM_TYPE },
		{ type: "custom", customType: CUSTOM_TYPE, data: record(3, 0.02) },
	];
	const stats = computeStats([], branch);
	assert.equal(stats.runs, 2);
	assert.equal(stats.requests, 5);
	assert.ok(Math.abs(stats.costUsd - 0.03) < 1e-12);
	assert.equal(stats.last?.requests, 3);
});

const identity: Colorize = (_color, text) => text;
const empty: GuardStats = {
	distilledResults: 0,
	imageResults: 0,
	omittedExchanges: 0,
	savedChars: 0,
	savedTokens: 0,
	lifetimeChars: 0,
	lifetimeTokens: 0,
	compacted: false,
	runs: 0,
	checkpoints: 0,
	requests: 0,
	costUsd: 0,
};

test("formatStatus for each state", () => {
	assert.equal(formatStatus(empty, "off", identity), "🛡 guard off");
	assert.equal(formatStatus(empty, "busy", identity), "🛡 distilling…");
	assert.equal(formatStatus(empty, "problem", identity, "no openrouter key"), "🛡 no openrouter key");
	assert.equal(formatStatus(empty, "problem", identity), "🛡 guard unavailable");
	assert.equal(formatStatus(empty, "ready", identity), "🛡 0 saved");
	assert.equal(formatStatus({ ...empty, savedTokens: 12_345, distilledResults: 3 }, "ready", identity), "🛡 −12.3k · 3");
	// After a compaction dropped earlier edits: the lifetime total too.
	assert.equal(formatStatus({ ...empty, lifetimeTokens: 79_000, compacted: true }, "ready", identity), "🛡 0 · Σ−79.0k");
	assert.equal(formatStatus({ ...empty, savedTokens: 4_200, imageResults: 2, distilledResults: 1, lifetimeTokens: 83_200, compacted: true }, "ready", identity), "🛡 −4.2k · 3 · Σ−83.2k");
	// Without a compaction, or when nothing was lost, no lifetime part.
	assert.equal(formatStatus({ ...empty, savedTokens: 4_200, distilledResults: 1, lifetimeTokens: 4_300 }, "ready", identity), "🛡 −4.2k · 1");
	assert.equal(formatStatus({ ...empty, savedTokens: 4_200, distilledResults: 1, lifetimeTokens: 4_200, compacted: true }, "ready", identity), "🛡 −4.2k · 1");
});

test("computeStats: lifetime savings from records, compacted only after a saving record", () => {
	const record = (savedChars: number) => ({ type: "custom", customType: CUSTOM_TYPE, data: { v: 1, savedChars, requests: 1, costUsd: 0, results: [] } });
	const before = computeStats([], [{ type: "compaction" }, record(40_000), record(0)]);
	assert.equal(before.lifetimeChars, 40_000);
	assert.equal(before.lifetimeTokens, 10_000);
	assert.equal(before.compacted, false);
	const after = computeStats([], [record(0), { type: "compaction" }, record(40_000), { type: "compaction" }]);
	assert.equal(after.compacted, true);
});

test("computeStats: a tool result whose images were removed counts as an image result, saved by pixels", () => {
	const png = Buffer.alloc(32);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
	png.writeUInt32BE(1500, 16);
	png.writeUInt32BE(1000, 20);
	const raw = { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "shot taken" }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
	const projected = { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: `${MARKER} Removed 1 image` }, { type: "text", text: "shot taken" }] };
	const stats = computeStats([{ sourceEntry: { id: "r1", type: "message", message: raw }, messages: [projected] }], []);
	assert.equal(stats.imageResults, 1);
	assert.equal(stats.distilledResults, 0);
	// 1500×1000/750 = 2000 tokens × 4 chars, minus the stub.
	assert.equal(stats.savedChars, 2_000 * 4 - `${MARKER} Removed 1 image`.length);
});

test("formatStatus colours each part", () => {
	const tagged: Colorize = (color, text) => `<${color}>${text}`;
	assert.equal(formatStatus(empty, "problem", tagged, "x"), "<warning>🛡 x");
	assert.equal(formatStatus({ ...empty, savedTokens: 10, distilledResults: 1 }, "ready", tagged), "<success>🛡 −10<dim> · 1");
});

test("formatCost", () => {
	assert.equal(formatCost(0), "$0");
	assert.equal(formatCost(0.00123), "$0.0012");
	assert.equal(formatCost(1.234), "$1.23");
});

test("computeStats counts mid-run checkpoints among runs", () => {
	const branch = [
		{ type: "custom", customType: CUSTOM_TYPE, data: { v: 1, phase: "mid-run", requests: 2, costUsd: 0.001, results: [] } },
		{ type: "custom", customType: CUSTOM_TYPE, data: { v: 1, phase: "run-end", requests: 1, costUsd: 0.001, results: [] } },
		{ type: "custom", customType: CUSTOM_TYPE, data: { v: 1, requests: 1, costUsd: 0, results: [] } },
	];
	const stats = computeStats([], branch);
	assert.equal(stats.runs, 3);
	assert.equal(stats.checkpoints, 1);
	assert.equal(stats.requests, 4);
});

test("computeStats counts omitted exchanges and their saved characters", () => {
	const raw = (role: string, text: string) => ({ role, content: [{ type: "text", text }] });
	const branch = [
		{ type: "message", id: "u1", message: raw("user", "old prompt") },
		{ type: "message", id: "a1", message: raw("assistant", "x".repeat(2_000)) },
		{ type: "message", id: "u2", message: raw("user", "current") },
	];
	const stub = `${EXCHANGE_STUB_PREFIX} judged unrelated to the current work: "old prompt" (2 messages, ~500 tokens). Full exchange: recall({"entryId":"u1"}).`;
	const projection = [
		{ sourceEntry: { id: "u1", type: "message", message: raw("user", "old prompt") as never }, messages: [raw("user", stub) as never] },
		// Pi keeps an omitted entry in the projection with no messages.
		{ sourceEntry: { id: "a1", type: "message", message: raw("assistant", "x".repeat(2_000)) as never }, messages: [] },
		{ sourceEntry: { id: "u2", type: "message", message: raw("user", "current") as never }, messages: [raw("user", "current") as never] },
	];
	const stats = computeStats(projection, branch as never);
	assert.equal(stats.omittedExchanges, 1);
	assert.equal(stats.distilledResults, 0);
	assert.equal(stats.savedChars, "old prompt".length + 2_000 - stub.length);
	assert.equal(formatStatus({ ...stats, savedTokens: 400, distilledResults: 2 }, "ready", identity), "🛡 −400 · 3");
	// An entry of the exchange that is still visible (e.g. not editable) is not counted.
	const visible = projection.map((e) => (e.sourceEntry.id === "a1" ? { ...e, messages: [raw("assistant", "x".repeat(2_000)) as never] } : e));
	assert.equal(computeStats(visible, branch as never).savedChars, Math.max(0, "old prompt".length - stub.length));
});
