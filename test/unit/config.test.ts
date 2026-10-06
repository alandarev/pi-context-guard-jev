import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig, parseModelRef, saveConfigPatch } from "../../src/config.ts";

test("normalizeConfig returns defaults for non-objects", () => {
	for (const raw of [undefined, null, 42, "x", [1, 2]]) assert.deepEqual(normalizeConfig(raw), DEFAULT_CONFIG);
});

test("normalizeConfig returns a fresh excludeTools array", () => {
	const config = normalizeConfig({});
	config.excludeTools.push("bash");
	assert.deepEqual(DEFAULT_CONFIG.excludeTools, ["edit", "write"]);
});

test("normalizeConfig drops bad types and out-of-range numbers", () => {
	const config = normalizeConfig({
		enabled: "no",
		minResultChars: "100",
		keepWholeThreshold: 1.5,
		chunkKeepThreshold: -0.1,
		noneThreshold: Number.NaN,
		timeoutMs: 100,
		concurrency: 64,
		maxSegmentChars: 1_000,
		maxChunksPerSegment: 1,
		excludeTools: "edit",
		pinAnthropicCache: 1,
		unknownKey: true,
	});
	assert.deepEqual(config, DEFAULT_CONFIG);
});

test("normalizeConfig rejects non-integer counts and sizes", () => {
	const config = normalizeConfig({
		minResultChars: 500.5,
		minRunChars: 1e3 + 0.1,
		timeoutMs: 1_500.25,
		concurrency: 2.5,
		maxSegmentChars: 10_000.5,
		maxChunksPerSegment: 10.1,
		keepWholeThreshold: 0.55,
	});
	assert.deepEqual(config, { ...DEFAULT_CONFIG, keepWholeThreshold: 0.55 });
	assert.equal(normalizeConfig({ concurrency: 2.0 }).concurrency, 2);
});

test("normalizeConfig keeps valid values", () => {
	const config = normalizeConfig({
		enabled: false,
		minResultChars: 500,
		keepWholeThreshold: 0,
		maxKeepRatio: 1,
		timeoutMs: 500,
		concurrency: 32,
		excludeTools: ["bash", 3, "read"],
		pinAnthropicCache: false,
	});
	assert.equal(config.enabled, false);
	assert.equal(config.minResultChars, 500);
	assert.equal(config.keepWholeThreshold, 0);
	assert.equal(config.maxKeepRatio, 1);
	assert.equal(config.timeoutMs, 500);
	assert.equal(config.concurrency, 32);
	assert.deepEqual(config.excludeTools, ["bash", "read"]);
	assert.equal(config.pinAnthropicCache, false);
});

test("normalizeConfig accepts provider/id model refs only", () => {
	assert.equal(normalizeConfig({ model: "anthropic/claude-x" }).model, "anthropic/claude-x");
	assert.equal(normalizeConfig({ model: "  openrouter/a/b  " }).model, "openrouter/a/b");
	assert.equal(normalizeConfig({ model: "no-slash" }).model, DEFAULT_CONFIG.model);
	assert.equal(normalizeConfig({ model: "/leading" }).model, DEFAULT_CONFIG.model);
	assert.equal(normalizeConfig({ model: 7 }).model, DEFAULT_CONFIG.model);
});

test("parseModelRef splits at the first slash", () => {
	assert.deepEqual(parseModelRef("openrouter/~typesafe/jev-latest"), { provider: "openrouter", id: "~typesafe/jev-latest" });
	assert.deepEqual(parseModelRef(DEFAULT_CONFIG.model), { provider: "openrouter", id: "~typesafe/jev-latest" });
	assert.equal(parseModelRef("plain"), undefined);
	assert.equal(parseModelRef("/id"), undefined);
	assert.equal(parseModelRef("provider/"), undefined);
});

test("loadConfig / saveConfigPatch round trip in a temp dir", () => {
	const dir = mkdtempSync(join(tmpdir(), "context-guard-config-"));
	try {
		const path = join(dir, "nested", "context-guard.json");
		assert.deepEqual(loadConfig(path), { config: DEFAULT_CONFIG });

		saveConfigPatch(path, { enabled: false, concurrency: 3 });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { enabled: false, concurrency: 3 });
		const loaded = loadConfig(path);
		assert.equal(loaded.error, undefined);
		assert.equal(loaded.config.enabled, false);
		assert.equal(loaded.config.concurrency, 3);

		// Unknown keys already in the file are preserved; patched keys are overwritten.
		writeFileSync(path, JSON.stringify({ enabled: false, custom: "keep me" }));
		saveConfigPatch(path, { enabled: true });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { enabled: true, custom: "keep me" });

		writeFileSync(path, "{ not json");
		const broken = loadConfig(path);
		assert.deepEqual(broken.config, DEFAULT_CONFIG);
		assert.match(broken.error ?? "", /invalid JSON/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
