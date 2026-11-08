#!/usr/bin/env node
/**
 * Live probe for shortened tool-call arguments (test/e2e/args-probe.ts). One Pi run in a temp directory
 * that writes three files with the write tool and checks them with bash, one call per message; the probe
 * shortens the long `content` arguments of earlier messages of the same run at every turn boundary.
 * Prints each assistant message (blocks, stop reason, provider error), the edits, and whether a write was
 * repeated (the model took the shortened value for what it had sent).
 *
 *   node test/e2e/args-probe-run.mjs --model anthropic/claude-haiku-5-5 --ext ~/.pi/agent/npm/node_modules/pi-claude-auth [--thinking high] [--keep 4] [--earlier]
 *
 * --earlier: run two prompts; the probe is only loaded for the second, and shortens messages of the first
 * run (before the last user message) instead of the current one (CG_ARGS_SCOPE=earlier).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};
const model = opt("model");
if (!model) {
	console.error("usage: args-probe-run.mjs --model <provider/id> [--ext <path>]... [--thinking level] [--keep N] [--earlier]");
	process.exit(2);
}
const exts = args.flatMap((a, i) => (a === "--ext" ? ["-e", resolve(args[i + 1])] : []));
const earlier = args.includes("--earlier");
const dir = mkdtempSync(join(tmpdir(), "args-probe-"));
const repo = join(dir, "repo");
mkdirSync(repo);
const sessions = join(dir, "sessions");
const sessionId = `args-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const WRITE_PROMPT =
	"Do these steps strictly one tool call per message, waiting for each result before the next call: " +
	'1) Use the write tool to create a.txt containing 30 numbered lines, each "Line N: the quick brown fox jumps over the lazy dog." ' +
	"2) Use the write tool to create b.txt with the same 30 lines in reverse order. " +
	"3) Use the write tool to create c.txt with only the even-numbered lines of a.txt. " +
	"4) Run `wc -l a.txt b.txt c.txt` with bash. 5) Run `head -n 2 b.txt` with bash. 6) Run `tail -n 2 c.txt` with bash. " +
	"7) Run `grep -c fox a.txt` with bash. Then reply with the outputs of steps 4 to 7.";
const prompts = earlier
	? [WRITE_PROMPT, "Now run `head -n 1 a.txt b.txt c.txt` with bash, then `tail -n 1 a.txt` with bash, one call per message, and reply with both outputs."]
	: [WRITE_PROMPT];

prompts.forEach((prompt, i) => {
	const probe = !earlier || i === prompts.length - 1;
	const res = spawnSync(
		"pi",
		["--mode", "json", "-ne", ...exts, ...(probe ? ["-e", join(HERE, "args-probe.ts")] : []), "--session-dir", sessions, "--session-id", sessionId, "--model", model, "--thinking", opt("thinking", "high"), prompt],
		{
			cwd: repo,
			env: { ...process.env, CG_ARGS_KEEP: opt("keep", "1"), CG_ARGS_SCOPE: earlier ? "earlier" : "run" },
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
			timeout: 6 * 60_000,
		},
	);
	console.log(`turn ${i + 1}: exit ${res.status}`);
	process.stdout.write((res.stderr ?? "").split("\n").filter((l) => l.startsWith("args-probe")).map((l) => `  ${l}\n`).join(""));
});

const file = readdirSync(sessions, { recursive: true }).map(String).find((n) => n.endsWith(".jsonl"));
const entries = readFileSync(join(sessions, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const writes = [];
let errors = 0;
for (const e of entries) {
	if (e.type === "context_edit") console.log(`  context_edit ${e.targetId}`);
	if (e.type !== "message") continue;
	const m = e.message;
	if (m.role === "user") console.log(`user: ${String(typeof m.content === "string" ? m.content : m.content[0]?.text).slice(0, 60)}…`);
	if (m.role !== "assistant") continue;
	if (m.stopReason === "error") errors++;
	const blocks = m.content.map((b) => (b.type === "thinking" ? `thinking${b.thinkingSignature ? "(signed)" : ""}` : b.type === "toolCall" ? `${b.name}(${b.arguments?.path ?? String(b.arguments?.command ?? "").slice(0, 30)})` : b.type));
	for (const b of m.content) if (b.type === "toolCall" && b.name === "write") writes.push(b.arguments?.path);
	console.log(`${e.id} ${m.stopReason} [${blocks.join(", ")}]${m.errorMessage ? ` ERROR ${m.errorMessage}` : ""}`);
}
console.log(`session: ${join(sessions, file)}`);
console.log(`provider errors: ${errors}; writes: ${writes.join(", ")}${writes.length > new Set(writes).size ? " (REPEATED)" : ""}`);
process.exit(errors > 0 ? 1 : 0);
