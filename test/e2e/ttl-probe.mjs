#!/usr/bin/env node
/**
 * Run the Anthropic TTL experiment (test/e2e/ttl-probe.ts) for one or more arms, in parallel.
 *
 *   node test/e2e/ttl-probe.mjs [--arms refresh,control,ttl1h,idle,idle1h] [--ext <auth extension>] [--model anthropic/claude-sonnet-5-5]
 *
 * Prints cacheRead / cacheWrite / input per request for each arm. About 9 minutes; a few cents.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};
const arms = opt("arms", "refresh,control,ttl1h").split(",");
const model = opt("model", "anthropic/claude-sonnet-5-5");
const ext = resolve(opt("ext", join(homedir(), ".pi/agent/npm/node_modules/pi-claude-auth")));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outRoot = join(ROOT, "test/e2e/out", `ttl-probe-${stamp}`);

const IDLE_PROMPT =
	"First run `cat data.txt` with the bash tool. Then run `true` with the bash tool once. " +
	"Do not comment between calls. Finally reply with the single word done.";
const PROMPT =
	"First run `cat data.txt` with the bash tool. Then run `sleep 55` with the bash tool eight times, strictly one call per " +
	"message: wait for each result before the next call. Do not comment between calls. Finally reply with the single word done.";

function dataFile() {
	const lines = [];
	for (let i = 0; i < 900; i++) lines.push(`record ${i}: ${Buffer.from(String(i * 7919)).toString("base64")} the quick brown fox jumps over the lazy dog ${i % 97}`);
	return lines.join("\n");
}

async function runArm(arm) {
	const dir = join(outRoot, arm);
	mkdirSync(join(dir, "ws"), { recursive: true });
	writeFileSync(join(dir, "ws", "data.txt"), dataFile());
	const capture = join(dir, "capture.jsonl");
	// idle / idle1h: request 3 is held back --idle-seconds (default 400), so nothing reads the cache in between.
	const idle = arm.startsWith("idle");
	const argv = ["--mode", "json", "-ne", "-e", ext, "-e", join(HERE, "ttl-probe.ts"), "-e", join(HERE, "capture.ts"), "--session-dir", join(dir, "sessions"), "--model", model, "--thinking", "low", idle ? IDLE_PROMPT : PROMPT];
	await new Promise((done) => {
		const child = spawn("pi", argv, { cwd: join(dir, "ws"), env: { ...process.env, PROBE_ARM: idle ? (arm === "idle1h" ? "ttl1h" : "control") : arm, PROBE_EDIT_AT: idle ? "3" : "10", PROBE_DELAY_AT: idle ? "3" : "0", PROBE_DELAY_MS: String(Number(opt("idle-seconds", "400")) * 1000), CG_CAPTURE_FILE: capture, CG_TURN: "1" }, stdio: ["ignore", "pipe", "pipe"] });
		let err = "";
		child.stdout.on("data", () => {});
		child.stderr.on("data", (d) => (err += d));
		child.on("close", () => {
			writeFileSync(join(dir, "stderr.txt"), err);
			done();
		});
	});
	const records = readFileSync(capture, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const rows = [];
	let t0;
	for (const r of records) {
		if (r.kind === "request") rows.push({ n: r.n, t: r.t, breakpoints: r.breakpoints });
		if (r.kind === "assistant" && rows.length) Object.assign(rows.at(-1), r.usage);
	}
	const lines = rows.map((r) => {
		t0 ??= r.t;
		return `${arm.padEnd(8)} #${String(r.n).padStart(2)} t+${String(Math.round((r.t - t0) / 1000)).padStart(3)}s input=${r.input} cacheRead=${r.cacheRead} cacheWrite=${r.cacheWrite} bp=${r.breakpoints.join(",")}`;
	});
	writeFileSync(join(dir, "result.txt"), `${lines.join("\n")}\n`);
	return lines.join("\n");
}

const outputs = await Promise.all(arms.map(runArm));
console.log(outputs.join("\n\n"));
console.log(`\nartifacts: ${outRoot}`);
