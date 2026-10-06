#!/usr/bin/env node
/**
 * Real-world examples for the README: real public code, real Pi, real main model, real Jev.
 * Every example runs twice, with context-guard ON and with it OFF (`--no-guard`), so the next
 * request's context can be compared.
 *
 *   node test/e2e/examples.mjs [--only A,B,C] [--models gpt,claude] [--jobs 4]
 *
 * Examples (workspaces are temp copies; nothing private is sent anywhere):
 *   A  code search: the installed Pi package (public npm package; dist/ without source maps and
 *      the minified bundle, plus docs/), "where does Pi auto-compact?" then a settings follow-up.
 *   B  test log: a copy of this repo with one injected off-by-one bug; run the unit tests, then fix.
 *   C  large file read: read dist/core/agent-session.js completely, then ask for a detail.
 *
 * Default: A with GPT-6 Luna and Claude Sonnet 5.5, B and C with GPT only; at most 4 Pi runs at
 * once. Results go to test/e2e/out/examples-<stamp>/ (results.json, results.md, one directory per
 * run with summary.json, raw events, captured payloads and the distilled replacement texts).
 *
 * Costs real money/quota: see docs/TESTING.md.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const PI_PACKAGE = "/home/jev/.asdf/installs/nodejs/25.9.0/lib/node_modules/@earendil-works/pi-coding-agent";
const CLAUDE_AUTH = join(homedir(), ".pi/agent/npm/node_modules/pi-claude-auth");

const MODELS = {
	gpt: { id: "openai-codex/gpt-6-luna", ext: [] },
	claude: { id: "anthropic/claude-sonnet-5-5", ext: [CLAUDE_AUTH] },
};

const BIG_FILE = "dist/core/agent-session.js";
const C_DETAIL = "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.";

const EXAMPLES = {
	A: {
		title: "Code search in the Pi package",
		models: ["gpt", "claude"],
		workspace: "pi",
		prompts: [
			"Where does Pi decide to auto-compact the context, and which thresholds or settings control it? Start with one broad " +
				"case-insensitive search: rg -n -i compact dist docs (no head or other limits), then narrow down. Answer with file:line references.",
			"Which of those settings can a user change, and what are their defaults? Don't search again unless you must.",
		],
		// Ground truth from dist/core/compaction/compaction.js and docs/compaction.md.
		correct: (answer) => /enabled/i.test(answer) && /16[,.]?384/.test(answer) && /20[,.]?000/.test(answer),
		correctNote: "names enabled, reserveTokens 16384 and keepRecentTokens 20000",
	},
	B: {
		title: "Unit test log of this repository",
		models: ["gpt"],
		workspace: "repo",
		prompts: [
			"Run node --test --test-reporter=spec test/unit/*.test.ts and tell me which tests fail and the likely cause. Don't fix anything yet.",
			"Now fix it and rerun only the failing test file.",
		],
		correct: (_answer, dir) => {
			const res = spawnSync(process.execPath, ["--test", "test/unit/render.test.ts", "test/unit/extension.test.ts"], { cwd: dir, encoding: "utf8" });
			return res.status === 0;
		},
		correctNote: "render and extension tests pass in the workspace afterwards",
	},
	C: {
		title: "Reading a 164 KB source file",
		models: ["gpt"],
		workspace: "pi",
		prompts: [
			`Read ${BIG_FILE} completely (use offsets until you've seen the whole file) and explain in a few bullets how a user prompt reaches the model.`,
			"What exact error does Pi throw if a prompt is submitted while compaction is still running? Quote the message exactly as it " +
				"appears in that file. Don't read the file again unless you must.",
		],
		correct: (answer) => answer.includes(C_DETAIL),
		correctNote: `quotes "${C_DETAIL}"`,
	},
};

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};

// -----------------------------------------------------------------------------------------------
// Workspaces
// -----------------------------------------------------------------------------------------------
function makePiWorkspace(dir) {
	for (const sub of ["dist", "docs"]) {
		cpSync(join(PI_PACKAGE, sub), join(dir, sub), {
			recursive: true,
			// Source maps and the minified bundle are one-line blobs that duplicate dist/; leave them out.
			filter: (src) => !src.endsWith(".map") && !src.includes(`${join("dist", "bundle")}`),
		});
	}
	cpSync(join(PI_PACKAGE, "package.json"), join(dir, "package.json"));
	cpSync(join(PI_PACKAGE, "README.md"), join(dir, "README.md"));
}

/** Off-by-one in the omission line's last line number: 3 unit tests fail, the message shows only the symptom. */
const BUG = { file: "src/render.ts", from: "${end - 1 + base}", to: "${end + base}" };

function makeRepoWorkspace(dir) {
	for (const p of ["src", "test/unit", "package.json", "tsconfig.json"]) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
	symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
	const file = join(dir, BUG.file);
	const text = readFileSync(file, "utf8");
	if (!text.includes(BUG.from)) throw new Error(`bug site not found in ${BUG.file}`);
	writeFileSync(file, text.replace(BUG.from, BUG.to));
	spawnSync("git", ["init", "-q"], { cwd: dir });
	spawnSync("git", ["add", "-A"], { cwd: dir });
	spawnSync("git", ["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-qm", "fixture"], { cwd: dir });
}

// -----------------------------------------------------------------------------------------------
// One run (worker mode): node examples.mjs --run <A|B|C> --model <gpt|claude> [--no-guard] --out <dir>
// -----------------------------------------------------------------------------------------------
const textOf = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n"));
const findJsonl = (dir) =>
	readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? findJsonl(p) : name.endsWith(".jsonl") ? [p] : [];
	});

function runOne(exampleKey, modelKey, withGuard, out) {
	const example = EXAMPLES[exampleKey];
	const model = MODELS[modelKey];
	const ws = join(out, "workspace");
	const sessions = join(out, "sessions");
	mkdirSync(ws, { recursive: true });
	mkdirSync(sessions, { recursive: true });
	if (example.workspace === "pi") makePiWorkspace(ws);
	else makeRepoWorkspace(ws);

	const captureFile = join(out, "capture.jsonl");
	const configFile = join(out, "context-guard.json");
	writeFileSync(configFile, "{}");
	const sessionId = `ex-${exampleKey}-${modelKey}-${withGuard ? "on" : "off"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const extArgs = [...model.ext.flatMap((p) => ["-e", p]), ...(withGuard ? ["-e", join(ROOT, "src/index.ts")] : []), "-e", join(HERE, "capture.ts")];

	const turns = [];
	for (const [i, prompt] of example.prompts.entries()) {
		const started = Date.now();
		const res = spawnSync(
			"pi",
			["--mode", "json", "-ne", ...extArgs, "--session-dir", sessions, "--session-id", sessionId, "--model", model.id, "--thinking", "low", prompt],
			{
				cwd: ws,
				env: { ...process.env, CG_CAPTURE_FILE: captureFile, CG_TURN: String(i + 1), PI_CONTEXT_GUARD_CONFIG: configFile },
				encoding: "utf8",
				maxBuffer: 512 * 1024 * 1024,
				timeout: 20 * 60_000,
			},
		);
		writeFileSync(join(out, `turn-${i + 1}.events.jsonl`), res.stdout ?? "");
		writeFileSync(join(out, `turn-${i + 1}.stderr.txt`), res.stderr ?? "");
		turns.push({ prompt, exit: res.status, seconds: (Date.now() - started) / 1000 });
		if (res.status !== 0) break;
	}

	const sessionFile = findJsonl(sessions)[0];
	const entries = sessionFile ? readFileSync(sessionFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
	const turnEntries = [];
	for (const e of entries) {
		if (e.type === "message" && e.message.role === "user") turnEntries.push([]);
		if (turnEntries.length) turnEntries.at(-1).push(e);
	}
	const sumCost = (msgs) => msgs.reduce((n, m) => n + (m.usage?.cost?.total ?? 0), 0);

	const summary = { example: exampleKey, title: example.title, model: model.id, withGuard, out, turns: [] };
	turnEntries.forEach((list, i) => {
		const assistants = list.filter((e) => e.type === "message" && e.message.role === "assistant").map((e) => e.message);
		const toolResults = list.filter((e) => e.type === "message" && e.message.role === "toolResult").map((e) => e.message);
		const toolCalls = assistants.flatMap((m) => m.content.filter((b) => b.type === "toolCall").map((b) => ({ name: b.name, args: b.arguments })));
		const edits = list.filter((e) => e.type === "context_edit");
		const records = list.filter((e) => e.type === "custom" && e.customType === "context-guard").map((e) => e.data);
		edits.forEach((e, k) => writeFileSync(join(out, `turn-${i + 1}.edit-${k + 1}.txt`), textOf(e.replacement ?? { content: [] })));
		const u = assistants[0]?.usage;
		summary.turns.push({
			prompt: turns[i]?.prompt,
			seconds: turns[i]?.seconds,
			answer: textOf(assistants.at(-1) ?? { content: [] }),
			toolCalls: toolCalls.map((c) => `${c.name} ${JSON.stringify(c.args).slice(0, 160)}`),
			usedRecall: toolCalls.some((c) => c.name === "recall"),
			toolResultChars: toolResults.map((m) => textOf(m).length),
			firstRequest: u && { input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, context: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) },
			requests: assistants.length,
			mainCostUsd: sumCost(assistants),
			mainTokens: assistants.reduce((n, m) => n + (m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0) + (m.usage?.cacheWrite ?? 0) + (m.usage?.output ?? 0), 0),
			edits: edits.map((e) => {
				const text = textOf(e.replacement ?? { content: [] });
				const kept = /kept (\d+) of (\d+) lines?/.exec(text);
				const removed = /Removed the output of .*?: (\d+) lines?/.exec(text);
				return { targetId: e.targetId, chars: text.length, keptLines: kept ? Number(kept[1]) : removed ? 0 : undefined, totalLines: kept ? Number(kept[2]) : removed ? Number(removed[1]) : undefined };
			}),
			guard: records.map((r) => ({
				savedChars: r.savedChars,
				requests: r.requests,
				ms: r.ms,
				costUsd: r.costUsd,
				timedOut: r.timedOut,
				results: r.results.map((x) => ({ outcome: x.outcome, reason: x.reason, beforeChars: x.beforeChars, afterChars: x.afterChars, label: x.label, jev: x.jev })),
			})),
		});
	});
	const t2 = summary.turns[1];
	summary.turn2Correct = t2 ? Boolean(example.correct(t2.answer, ws)) : false;
	summary.correctNote = example.correctNote;
	if (exampleKey === "B") {
		// The test log is the point of example B: make sure it is big enough to matter.
		const t1 = summary.turns[0];
		summary.testLogChars = Math.max(0, ...(t1?.toolResultChars ?? []));
		summary.testLogBigEnough = summary.testLogChars >= 8_000;
	}
	writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	return summary;
}

if (opt("run")) {
	const s = runOne(opt("run"), opt("model"), !args.includes("--no-guard"), opt("out"));
	console.log(`${s.example} ${s.model} guard=${s.withGuard}: turn 2 correct=${s.turn2Correct}`);
	process.exit(0);
}

// -----------------------------------------------------------------------------------------------
// Driver: all runs, at most --jobs at once, then a combined table.
// -----------------------------------------------------------------------------------------------
const only = (opt("only") ?? "A,B,C").split(",");
const modelFilter = opt("models")?.split(",");
const jobs = Number(opt("jobs", "4"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outRoot = join(ROOT, "test/e2e/out", `examples-${stamp}`);
mkdirSync(outRoot, { recursive: true });

const queue = [];
for (const key of only) {
	for (const modelKey of EXAMPLES[key].models) {
		if (modelFilter && !modelFilter.includes(modelKey)) continue;
		for (const guard of [true, false]) queue.push({ key, modelKey, guard, out: join(outRoot, `${key}-${modelKey}-${guard ? "on" : "off"}`) });
	}
}

async function worker() {
	while (queue.length) {
		const job = queue.shift();
		mkdirSync(job.out, { recursive: true });
		await new Promise((done) => {
			const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--run", job.key, "--model", job.modelKey, "--out", job.out, ...(job.guard ? [] : ["--no-guard"])], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let log = "";
			child.stdout.on("data", (d) => (log += d));
			child.stderr.on("data", (d) => (log += d));
			child.on("close", (code) => {
				writeFileSync(join(job.out, "driver.log"), log);
				console.log(`${job.key}-${job.modelKey}-${job.guard ? "on" : "off"}: exit ${code} ${log.trim().split("\n").at(-1) ?? ""}`);
				done();
			});
		});
	}
}
await Promise.all(Array.from({ length: jobs }, worker));

// Combine.
const results = [];
for (const name of readdirSync(outRoot)) {
	const file = join(outRoot, name, "summary.json");
	if (existsSync(file)) results.push(JSON.parse(readFileSync(file, "utf8")));
}
writeFileSync(join(outRoot, "results.json"), `${JSON.stringify(results, null, 2)}\n`);

const fmt = (n) => (n === undefined ? "–" : n.toLocaleString("en-US"));
const lines = [
	"| Example | Model | Guard | Turn-1 results before → after (lines kept) | Jev | Turn-2 first request context (cache read) | Turn 2 | recall | Turn-2 main cost |",
	"|---|---|---|---|---|---|---|---|---|",
];
let jevCost = 0;
let mainCost = 0;
for (const r of results.sort((a, b) => `${a.example}${a.model}${!a.withGuard}`.localeCompare(`${b.example}${b.model}${!b.withGuard}`))) {
	const [t1, t2] = r.turns;
	const guard = t1?.guard ?? [];
	jevCost += r.turns.flatMap((t) => t.guard).reduce((n, g) => n + g.costUsd, 0);
	mainCost += r.turns.reduce((n, t) => n + t.mainCostUsd, 0);
	const distilled = guard.flatMap((g) => g.results).map((x) => {
		const edit = t1.edits.find((e) => e.chars === x.afterChars);
		return x.outcome === "kept" ? `${fmt(x.beforeChars)} kept (${x.reason})` : `${fmt(x.beforeChars)} → ${fmt(x.afterChars)}${edit?.totalLines ? ` (${edit.keptLines}/${edit.totalLines})` : ""}`;
	});
	const jev = guard.length ? `${guard.reduce((n, g) => n + g.requests, 0)} req, ${guard.map((g) => g.ms).join("+")} ms, $${guard.reduce((n, g) => n + g.costUsd, 0).toFixed(5)}` : "–";
	lines.push(
		`| ${r.example} | ${r.model.split("/")[1]} | ${r.withGuard ? "on" : "off"} | ${distilled.join("; ") || "–"} | ${jev} | ${fmt(t2?.firstRequest?.context)} (${fmt(t2?.firstRequest?.cacheRead)}) | ${r.turn2Correct ? "correct" : "wrong"} | ${t2?.usedRecall ? "yes" : "no"} | $${(t2?.mainCostUsd ?? 0).toFixed(4)} |`,
	);
}
lines.push("", `Jev total: $${jevCost.toFixed(5)}; main models total: $${mainCost.toFixed(4)} (as reported by Pi's usage).`);
writeFileSync(join(outRoot, "results.md"), `${lines.join("\n")}\n`);
console.log(`\n${lines.join("\n")}\n\nartifacts: ${outRoot}`);
