#!/usr/bin/env node
/**
 * Live end-to-end test: real Pi, real main model, real Jev (OpenRouter).
 *
 *   node test/e2e/run-e2e.mjs --model anthropic/claude-sonnet-5-5 [--ext <path>]... [--turns 3] [--thinking low]
 *
 * Each turn is a separate `pi --mode json` process on the same session id, run inside a freshly
 * generated fixture repo (test/e2e/make-fixture.mjs). Pi's own extensions are disabled (-ne);
 * context-guard, any --ext (e.g. an auth extension) and the capture helper are loaded explicitly.
 * Results go to test/e2e/out/<stamp>-<model>/ (summary.json plus raw logs and payloads).
 *
 * Costs real money/quota: a few main-model requests per turn and a few Jev requests.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const MARKER = "[context-guard]";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};
const exts = args.flatMap((a, i) => (a === "--ext" ? [resolve(args[i + 1])] : []));
const model = opt("model");
if (!model) {
	console.error("usage: run-e2e.mjs --model <provider/id> [--ext <path>]... [--turns N] [--thinking level] [--no-guard]");
	process.exit(2);
}
const turnsWanted = Number(opt("turns", "3"));
const thinking = opt("thinking", "low");
const withGuard = !args.includes("--no-guard");

const PROMPTS = [
	"Which parts of this codebase use the StatusBadge UI component? Start with one broad case-insensitive search for " +
		"'status' over the whole repo (rg -n -i status) to see everything related, then narrow down as needed. " +
		"Answer with a list of file:line references and what each usage displays.",
	'Which of those usages can render the badge with tone="danger"? Answer briefly, with file:line.',
	"Quote, exactly as your very first broad search printed it, the match for src/api/jobStatus.ts line 3. " +
		"Do not run a new search or read the file; get it from that earlier output.",
];

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = join(ROOT, "test/e2e/out", `${stamp}-${model.replace(/[^\w.-]+/g, "_")}${withGuard ? "" : "-noguard"}`);
const repo = join(out, "repo");
const sessions = join(out, "sessions");
const captureFile = join(out, "capture.jsonl");
mkdirSync(sessions, { recursive: true });
spawnSync(process.execPath, [join(HERE, "make-fixture.mjs"), repo], { stdio: "inherit" });

const extArgs = [...exts.flatMap((p) => ["-e", p]), ...(withGuard ? ["-e", join(ROOT, "src/index.ts")] : []), "-e", join(HERE, "capture.ts")];
const turns = [];
for (let i = 0; i < Math.min(turnsWanted, PROMPTS.length); i++) {
	const started = Date.now();
	const res = spawnSync(
		"pi",
		["--mode", "json", "-ne", ...extArgs, "--session-dir", sessions, "--session-id", "e2e", "--model", model, "--thinking", thinking, PROMPTS[i]],
		{ cwd: repo, env: { ...process.env, CG_CAPTURE_FILE: captureFile, CG_TURN: String(i + 1) }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60_000 },
	);
	writeFileSync(join(out, `turn-${i + 1}.events.jsonl`), res.stdout ?? "");
	writeFileSync(join(out, `turn-${i + 1}.stderr.txt`), res.stderr ?? "");
	turns.push({ prompt: PROMPTS[i], exit: res.status, seconds: (Date.now() - started) / 1000 });
	console.log(`turn ${i + 1}: exit ${res.status} in ${turns.at(-1).seconds.toFixed(1)} s`);
	if (res.status !== 0) break;
}

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------
const findJsonl = (dir) =>
	readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? findJsonl(p) : name.endsWith(".jsonl") ? [p] : [];
	});
const sessionFile = findJsonl(sessions)[0];
const entries = sessionFile ? readFileSync(sessionFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const capture = existsSync(captureFile) ? readFileSync(captureFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

const textOf = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n"));

// Split session entries into turns at each user message.
const turnEntries = [];
for (const e of entries) {
	if (e.type === "message" && e.message.role === "user") turnEntries.push([]);
	if (turnEntries.length) turnEntries.at(-1).push(e);
}
// Split capture records into turns: each pi process starts a new turn; requests are numbered per process.
const capTurns = [];
let currentTurn = 0;
for (const r of capture) {
	if (r.kind === "request") currentTurn = r.turn;
	if (currentTurn > 0) (capTurns[currentTurn - 1] ??= []).push(r);
}

const summary = { model, withGuard, out, sessionFile, turns: [] };
turnEntries.forEach((list, i) => {
	const assistants = list.filter((e) => e.type === "message" && e.message.role === "assistant").map((e) => e.message);
	const toolCalls = assistants.flatMap((m) => m.content.filter((b) => b.type === "toolCall").map((b) => `${b.name} ${JSON.stringify(b.arguments).slice(0, 120)}`));
	const edits = list.filter((e) => e.type === "context_edit");
	const records = list.filter((e) => e.type === "custom" && e.customType === "context-guard").map((e) => e.data);
	const requests = (capTurns[i] ?? []).filter((r) => r.kind === "request");
	const usage = assistants.map((m) => ({ input: m.usage?.input, cacheRead: m.usage?.cacheRead, cacheWrite: m.usage?.cacheWrite, output: m.usage?.output }));
	summary.turns.push({
		prompt: turns[i]?.prompt,
		seconds: turns[i]?.seconds,
		answer: textOf(assistants.at(-1) ?? { content: [] }).slice(0, 1500),
		toolCalls,
		usedRecall: toolCalls.some((c) => c.startsWith("recall ")),
		usage,
		firstRequest: requests[0] && { bytes: requests[0].bytes, markers: requests[0].markers, breakpoints: requests[0].breakpoints },
		maxBreakpoints: Math.max(0, ...requests.map((r) => r.breakpoints.length)),
		edits: edits.map((e) => ({ targetId: e.targetId, chars: textOf(e.replacement ?? { content: [] }).length })),
		guard: records.map((r) => ({ savedChars: r.savedChars, requests: r.requests, ms: r.ms, costUsd: r.costUsd, timedOut: r.timedOut, results: r.results.map((x) => `${x.outcome} ${x.beforeChars}->${x.afterChars} ${x.reason} ${x.label}`) })),
	});
});

// Checks ------------------------------------------------------------------------------------
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
const [t1, t2, t3] = summary.turns;
const usageFiles = ["OrdersPage", "ServerListPage", "DeploymentCard", "InvoiceRow", "UserTable"];
if (t1) {
	check("turn 1 answer names all 5 usages", usageFiles.every((f) => t1.answer.includes(f)), usageFiles.filter((f) => !t1.answer.includes(f)));
	if (withGuard) {
		check("turn 1 produced context edits", t1.edits.length > 0, t1.edits.length);
		check("turn 1 Jev record saved chars", (t1.guard[0]?.savedChars ?? 0) > 0, t1.guard[0]);
	}
}
if (t2) {
	check("turn 2 answer names the danger usages", ["OrdersPage", "DeploymentCard", "UserTable"].every((f) => t2.answer.includes(f)), t2.answer.slice(0, 300));
	if (withGuard) {
		const baseline = t1?.firstRequest?.markers ?? 0;
		check("turn 2 first request carries distilled text", (t2.firstRequest?.markers ?? 0) > baseline, { baseline, now: t2.firstRequest?.markers });
		// Raw noise from turn 1's broad search must not reach the model again (unless re-searched).
		const payload = readFileSync(`${captureFile}.t2-001.json`, "utf8");
		check("turn 2 first request no longer carries raw search noise", !payload.includes("statusNote") && !payload.includes("http_status="), {
			statusNote: payload.split("statusNote").length - 1,
			http_status: payload.split("http_status=").length - 1,
		});
	}
	const u = t2.usage[0];
	if (u) check("turn 2 first request reads cache", (u.cacheRead ?? 0) > 0, u);
}
if (t3) {
	const expected = readFileSync(join(repo, "src/api/jobStatus.ts"), "utf8").split("\n")[2].trim();
	check("turn 3 quotes the removed line exactly", t3.answer.includes(expected), { expected, answer: t3.answer.slice(0, 300) });
	if (withGuard) check("turn 3 used recall", t3.usedRecall, t3.toolCalls);
}
if (model.startsWith("anthropic/")) {
	check("anthropic requests stay within 4 breakpoints", summary.turns.every((t) => t.maxBreakpoints <= 4), summary.turns.map((t) => t.maxBreakpoints));
}
summary.checks = checks;
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

for (const [i, t] of summary.turns.entries()) {
	console.log(`\n=== turn ${i + 1} (${t.seconds?.toFixed(1)} s) ===`);
	console.log(`tools: ${t.toolCalls.join(" | ") || "-"}`);
	console.log(`usage: ${t.usage.map((u) => `in=${u.input} cr=${u.cacheRead} cw=${u.cacheWrite}`).join("; ")}`);
	if (t.firstRequest) console.log(`first request: ${t.firstRequest.bytes} bytes, ${t.firstRequest.markers} markers, breakpoints ${JSON.stringify(t.firstRequest.breakpoints)}`);
	for (const g of t.guard) console.log(`guard: saved ${g.savedChars} chars in ${g.ms} ms, ${g.requests} Jev req, $${g.costUsd.toFixed(5)}${g.timedOut ? " TIMEOUT" : ""}\n  ${g.results.join("\n  ")}`);
	console.log(`answer: ${t.answer.slice(0, 400).replace(/\n/g, " ⏎ ")}`);
}
console.log("\nchecks:");
for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.name}${c.ok ? "" : ` → ${JSON.stringify(c.detail)}`}`);
console.log(`\nartifacts: ${out}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
