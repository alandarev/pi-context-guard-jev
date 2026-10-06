import assert from "node:assert/strict";
import { test } from "node:test";
import { MARKER } from "../../src/render.ts";
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
const empty: GuardStats = { distilledResults: 0, savedChars: 0, savedTokens: 0, runs: 0, checkpoints: 0, requests: 0, costUsd: 0 };

test("formatStatus for each state", () => {
	assert.equal(formatStatus(empty, "off", identity), "🛡 guard off");
	assert.equal(formatStatus(empty, "busy", identity), "🛡 distilling…");
	assert.equal(formatStatus(empty, "problem", identity, "no openrouter key"), "🛡 no openrouter key");
	assert.equal(formatStatus(empty, "problem", identity), "🛡 guard unavailable");
	assert.equal(formatStatus(empty, "ready", identity), "🛡 0 saved");
	assert.equal(formatStatus({ ...empty, savedTokens: 12_345, distilledResults: 3 }, "ready", identity), "🛡 −12.3k · 3");
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
