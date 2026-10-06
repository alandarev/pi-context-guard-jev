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

const scenario = opt("scenario", "badge");
const guardConfig = opt("config");
const SCENARIOS = {};
SCENARIOS.badge = [
	"Which parts of this codebase use the StatusBadge UI component? Start with one broad case-insensitive search for " +
		"'status' over the whole repo (rg -n -i status) to see everything related, then narrow down as needed. " +
		"Answer with a list of file:line references and what each usage displays.",
	'Which of those usages can render the badge with tone="danger"? Answer briefly, with file:line.',
	"Quote, exactly as your very first broad search printed it, the match for src/api/jobStatus.ts line 3. " +
		"Do not run a new search or read the file; get it from that earlier output.",
];
// A run with 12+ sequential tool calls puts the question more than 20 cache positions back: this is
// where the Anthropic question breakpoint matters (docs/CACHE.md). (Called "long" before 0.2.0.)
SCENARIOS.sequential = [
	"Where is the StatusBadge component used? Start with one broad case-insensitive search (rg -n -i status). " +
		"Then open every file under src/pages, src/widgets, src/admin, src/layout and src/components with the read tool, " +
		"strictly one read call per message: wait for each result before making the next call. " +
		"Finish with the list of StatusBadge usages and a one-line summary of what each opened file renders.",
	"Which of those files did you find hardest to understand? One sentence.",
];
// Earlier conversation matters (historyExchanges): turn 1 sets up a goal (API retry behaviour), turn 2
// asks an unrelated-looking question whose broad search also prints the src/api retry lines, turn 3
// needs those lines. With history Jev can see that they matter for the ongoing work.
SCENARIOS.history = [
	"Context for this session: I'm about to migrate every API client in src/api to a shared retry helper, so I care about " +
		"how each client retries. Don't change anything and don't search yet; just acknowledge in one sentence.",
	"Which parts of this codebase use the StatusBadge UI component? Start with one broad case-insensitive search " +
		"(rg -n -i status), then narrow down as needed. Answer with file:line references.",
	"Without running any new search or reading files, which API clients retry on HTTP 429 according to what you have " +
		"already seen? If it's not in your context, use recall.",
];
// A long autonomous run (mid-run checkpoints): fix every failing test of a generated project
// (test/e2e/make-long-fixture.mjs: 10 bugs in up to three layers; every suite run prints 10–30k
// characters).
SCENARIOS.long = [
	"Fix all failing tests in this project. Work autonomously until the whole suite passes (npm test). " +
		"Fix one bug at a time and run the full suite with plain `npm test` (no pipes, filters, head or tail) after every single fix. " +
		"Don't ask me anything; don't stop until npm test is green.",
];
// Several unrelated tasks in one session, then a follow-up on the first (old-exchange pruning).
SCENARIOS.topics = [
	"Which API clients in src/api retry on HTTP 503? Answer with file:line references.",
	"Draft a short README paragraph that documents the StatusBar component in src/components/StatusBar.tsx. Show me the text; don't edit any files.",
	"How many lines in logs/worker.log have http_status=500, and which workers logged them? Use a command.",
	"Where is the StatusBadge component used? Answer with file:line references.",
	"Back to the API clients that retry on 503: which of them also retry on HTTP 502? Answer with file:line references.",
];
const PROMPTS = SCENARIOS[scenario];
if (!PROMPTS) {
	console.error(`unknown scenario ${scenario}`);
	process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const label = `${scenario}${withGuard ? "" : "-noguard"}${guardConfig ? `-cfg${Buffer.from(guardConfig).toString("base64url").slice(0, 8)}` : ""}`;
const out = join(ROOT, "test/e2e/out", `${stamp}-${model.replace(/[^\w.-]+/g, "_")}-${label}`);
const repo = join(out, "repo");
// Unique per run: OpenAI uses the session id as prompt_cache_key, so runs must not share it.
const sessionId = `e2e-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
const sessions = join(out, "sessions");
const captureFile = join(out, "capture.jsonl");
mkdirSync(sessions, { recursive: true });
// Never read the user's own context-guard settings: defaults, plus --config '{"key":value}' overrides.
const configFile = join(out, "context-guard.json");
writeFileSync(configFile, guardConfig ?? "{}");
spawnSync(process.execPath, [join(HERE, scenario === "long" ? "make-long-fixture.mjs" : "make-fixture.mjs"), repo], { stdio: "inherit" });

const extArgs = [...exts.flatMap((p) => ["-e", p]), ...(withGuard ? ["-e", join(ROOT, "src/index.ts")] : []), "-e", join(HERE, "capture.ts")];
const turns = [];
for (let i = 0; i < Math.min(turnsWanted, PROMPTS.length); i++) {
	const started = Date.now();
	const res = spawnSync(
		"pi",
		["--mode", "json", "-ne", ...extArgs, "--session-dir", sessions, "--session-id", sessionId, "--model", model, "--thinking", thinking, PROMPTS[i]],
		{ cwd: repo, env: { ...process.env, CG_CAPTURE_FILE: captureFile, CG_TURN: String(i + 1), PI_CONTEXT_GUARD_CONFIG: configFile }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: (scenario === "long" ? 60 : 15) * 60_000 },
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

const summary = { model, scenario, withGuard, guardConfig, out, sessionFile, turns: [] };
turnEntries.forEach((list, i) => {
	const assistants = list.filter((e) => e.type === "message" && e.message.role === "assistant").map((e) => e.message);
	const toolCalls = assistants.flatMap((m) => m.content.filter((b) => b.type === "toolCall").map((b) => `${b.name} ${JSON.stringify(b.arguments).slice(0, 120)}`));
	const edits = list.filter((e) => e.type === "context_edit");
	const records = list.filter((e) => e.type === "custom" && e.customType === "context-guard").map((e) => e.data);
	const requests = (capTurns[i] ?? []).filter((r) => r.kind === "request");
	const usage = assistants.map((m) => ({ input: m.usage?.input, cacheRead: m.usage?.cacheRead, cacheWrite: m.usage?.cacheWrite, output: m.usage?.output, cost: m.usage?.cost?.total }));
	summary.turns.push({
		prompt: turns[i]?.prompt,
		seconds: turns[i]?.seconds,
		answer: textOf(assistants.at(-1) ?? { content: [] }).slice(0, 1500),
		toolCalls,
		usedRecall: toolCalls.some((c) => c.startsWith("recall ")),
		usage,
		firstRequest: requests[0] && { bytes: requests[0].bytes, markers: requests[0].markers, breakpoints: requests[0].breakpoints },
		maxBreakpoints: Math.max(0, ...requests.map((r) => r.breakpoints.length)),
		edits: edits.map((e) => ({ targetId: e.targetId, chars: textOf(e.replacement ?? { content: [] }).length, text: textOf(e.replacement ?? { content: [] }) })),
		guard: records.map((r) => ({ savedChars: r.savedChars, requests: r.requests, ms: r.ms, costUsd: r.costUsd, timedOut: r.timedOut, results: r.results.map((x) => `${x.outcome} ${x.beforeChars}->${x.afterChars} ${x.reason} ${x.label}${x.jev ? `\n      jev: ${x.jev.join(" | ")}` : ""}`) })),
	});
});

// Checks ------------------------------------------------------------------------------------
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
const [t1, t2, t3] = summary.turns;
const isBadge = scenario === "badge";
const usageFiles = ["OrdersPage", "ServerListPage", "DeploymentCard", "InvoiceRow", "UserTable"];
if (t1 && isBadge) {
	check("turn 1 answer names all 5 usages", usageFiles.every((f) => t1.answer.includes(f)), usageFiles.filter((f) => !t1.answer.includes(f)));
	if (withGuard) {
		check("turn 1 produced context edits", t1.edits.length > 0, t1.edits.length);
		check("turn 1 Jev record saved chars", (t1.guard[0]?.savedChars ?? 0) > 0, t1.guard[0]);
	}
}
if (t2 && isBadge) {
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
if (t3 && isBadge) {
	const expected = readFileSync(join(repo, "src/api/jobStatus.ts"), "utf8").split("\n")[2].trim();
	check("turn 3 quotes the removed line exactly", t3.answer.includes(expected), { expected, answer: t3.answer.slice(0, 300) });
	// Only required when distillation actually removed that line from the model's view.
	const t3Payload = existsSync(`${captureFile}.t3-001.json`) ? readFileSync(`${captureFile}.t3-001.json`, "utf8") : "";
	const stillVisible = t3Payload.includes(JSON.stringify(expected).slice(1, -1));
	if (withGuard && !stillVisible) check("turn 3 used recall (line was distilled away)", t3.usedRecall, t3.toolCalls);
}
if (scenario === "sequential" && t1 && withGuard) {
	check("sequential: turn 1 produced context edits", t1.edits.length > 0, t1.edits.length);
	check("sequential: turn 1 made 10+ tool calls", t1.toolCalls.length >= 10, t1.toolCalls.length);
	check("sequential: turn 1 had 10+ model requests (sequential calls)", t1.usage.length >= 10, t1.usage.length);
}
if (scenario === "history" && t2) {
	// Which clients really retry on 429 (the fixture is deterministic, but read it to be sure).
	const apiDir = join(repo, "src/api");
	const clients = readdirSync(apiDir).map((f) => f.replace(/\.ts$/, ""));
	const retry429 = clients.filter((c) => readFileSync(join(apiDir, `${c}.ts`), "utf8").includes("=== 429"));
	const editText = t2.edits.map((e) => e.text).join("\n");
	const retryLines = editText.split("\n").filter((l) => /^src\/api\/\w+\.ts[:-]\d+[:-].*retry/.test(l));
	summary.history = {
		historyExchanges: guardConfig ? JSON.parse(guardConfig).historyExchanges : undefined,
		turn2Edits: t2.edits.length,
		keptApiRetryLines: retryLines.length,
		kept429Lines: retryLines.filter((l) => l.includes("429")).length,
		turn2Results: t2.guard.flatMap((g) => g.results),
		turn2JevMs: t2.guard.map((g) => g.ms),
		turn3UsedRecall: t3?.usedRecall,
		turn3ToolCalls: t3?.toolCalls,
		expected429: retry429,
	};
	if (withGuard) check("history: turn 2 produced context edits", t2.edits.length > 0, t2.edits.length);
	if (t3) {
		const answer = t3.answer.toLowerCase();
		const named = clients.filter((c) => answer.includes(c.toLowerCase()));
		// A client named only to say it does NOT retry on 429 is fine.
		const negated = (c) => answer.split("\n").filter((l) => l.includes(c.toLowerCase())).every((l) => /\b(not|no|none|doesn't|does not|without|only lists)\b/.test(l));
		const claimed = named.filter((c) => !negated(c) || retry429.includes(c));
		const correct = retry429.every((c) => named.includes(c)) && claimed.every((c) => retry429.includes(c));
		summary.history.turn3Named = named;
		summary.history.turn3Correct = correct;
		check("history: turn 3 names exactly the clients that retry on 429", correct, { expected: retry429, named });
	}
}
if (scenario === "long") {
	// Timeline of the run: every assistant request with its context, and every checkpoint record.
	const timeline = [];
	for (const e of entries) {
		if (e.type === "message" && e.message.role === "assistant") {
			const u = e.message.usage ?? {};
			timeline.push({ kind: "request", input: u.input ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, output: u.output ?? 0, cost: u.cost?.total ?? 0 });
		} else if (e.type === "custom" && e.customType === "context-guard") {
			timeline.push({ kind: "guard", phase: e.data.phase ?? "run-end", data: e.data });
		}
	}
	const requests = timeline.filter((t) => t.kind === "request").map((t) => ({ ...t, context: t.input + t.cacheRead + t.cacheWrite }));
	const checkpoints = [];
	timeline.forEach((t, i) => {
		if (t.kind !== "guard") return;
		const next = timeline.slice(i + 1).find((x) => x.kind === "request");
		const before = timeline.slice(0, i).filter((x) => x.kind === "request").at(-1);
		checkpoints.push({
			phase: t.phase,
			requestIndex: timeline.slice(0, i).filter((x) => x.kind === "request").length,
			ms: t.data.ms,
			costUsd: t.data.costUsd,
			jevRequests: t.data.requests,
			savedChars: t.data.savedChars,
			results: t.data.results.map((r) => `${r.outcome} ${r.beforeChars}->${r.afterChars} ${r.reason} ${r.label}`),
			before: before && { context: before.input + before.cacheRead + before.cacheWrite, cacheRead: before.cacheRead },
			after: next && { input: next.input, cacheRead: next.cacheRead, cacheWrite: next.cacheWrite, context: next.input + next.cacheRead + next.cacheWrite },
		});
	});
	const allCalls = summary.turns.flatMap((t) => t.toolCalls);
	const isSuite = (c) => /npm (run )?test|node --test/.test(c);
	const seen = new Map();
	const repeats = [];
	for (const c of allCalls) {
		const key = c.replace(/"timeout":\d+/, "");
		if (seen.has(key) && !isSuite(c)) repeats.push(c);
		seen.set(key, true);
	}
	const suite = spawnSync("npm", ["test"], { cwd: repo, encoding: "utf8" });
	const sparkChars = "▁▂▃▄▅▆▇█";
	const maxCtx = Math.max(1, ...requests.map((r) => r.context));
	summary.long = {
		requests: requests.length,
		contexts: requests.map((r) => r.context),
		spark: requests.map((r) => sparkChars[Math.min(7, Math.floor((r.context / maxCtx) * 8))]).join(""),
		maxContext: maxCtx,
		totals: {
			input: requests.reduce((n, r) => n + r.input, 0),
			cacheRead: requests.reduce((n, r) => n + r.cacheRead, 0),
			cacheWrite: requests.reduce((n, r) => n + r.cacheWrite, 0),
			output: requests.reduce((n, r) => n + r.output, 0),
			costUsd: requests.reduce((n, r) => n + r.cost, 0),
		},
		checkpoints,
		jevCostUsd: checkpoints.reduce((n, c) => n + (c.costUsd ?? 0), 0),
		suiteGreen: suite.status === 0,
		recallCalls: allCalls.filter((c) => c.startsWith("recall ")).length,
		repeatedNonSuiteCalls: repeats,
		toolCalls: allCalls.length,
	};
	check("long: the suite is green afterwards", suite.status === 0, suite.stdout?.split("\n").filter((l) => /^ℹ (pass|fail)/.test(l)).join(" "));
	// Checkpoints are required only when forced (break-even off); a default run may rightly make none.
	const cfg = guardConfig ? JSON.parse(guardConfig) : {};
	if (withGuard && cfg.midRun !== false && cfg.midRunBreakEven === false) check("long: at least one mid-run checkpoint (forced)", checkpoints.some((c) => c.phase === "mid-run"), checkpoints.length);
	// After a checkpoint, the next request should still read the cached prefix (system/question at least).
	if (withGuard && model.startsWith("anthropic/")) {
		for (const c of checkpoints.filter((x) => x.phase === "mid-run" && x.after)) {
			check(`long: request after the checkpoint at request ${c.requestIndex} reads the cached prefix`, (c.after.cacheRead ?? 0) >= (requests[0]?.cacheRead ?? 0) + (requests[0]?.cacheWrite ?? 0) * 0.9, { after: c.after, firstRequest: requests[0] });
		}
	}
}
if (scenario === "topics") {
	const apiDir = join(repo, "src/api");
	const clients = readdirSync(apiDir).map((f) => f.replace(/\.ts$/, ""));
	const both = clients.filter((c) => {
		const text = readFileSync(join(apiDir, `${c}.ts`), "utf8");
		return text.includes("=== 503") && text.includes("=== 502");
	});
	const last = summary.turns.at(-1);
	const answer = (last?.answer ?? "").toLowerCase();
	const named = clients.filter((c) => answer.includes(c.toLowerCase()));
	const exchangeResults = entries
		.filter((e) => e.type === "custom" && e.customType === "context-guard")
		.flatMap((e) => e.data.results.filter((r) => r.kind === "exchange").map((r) => ({ phase: e.data.phase ?? "run-end", label: r.label, outcome: r.outcome, p: r.jev?.[0] })));
	summary.topics = {
		contextPerTurn: summary.turns.map((t) => t.usage[0] && (t.usage[0].input ?? 0) + (t.usage[0].cacheRead ?? 0) + (t.usage[0].cacheWrite ?? 0)),
		firstRequestUsage: summary.turns.map((t) => t.usage[0]),
		exchanges: exchangeResults,
		smallItems: entries.filter((e) => e.type === "custom" && e.customType === "context-guard").flatMap((e) => e.data.results.filter((r) => r.kind === "small").map((r) => `${r.outcome} ${r.beforeChars}->${r.afterChars} ${r.label}`)),
		lastTurnTools: last?.toolCalls,
		lastTurnUsedRecall: last?.usedRecall,
		expected: both,
		named,
		correct: both.length > 0 && both.every((c) => named.includes(c)) && named.every((c) => both.includes(c) || answer.split("\n").filter((l) => l.includes(c.toLowerCase())).every((l) => /\b(not|no|none|only)\b/.test(l))),
		mainCostUsd: summary.turns.reduce((n, t) => n + t.usage.reduce((m, u) => m + (u.cost ?? 0), 0), 0),
	};
	check("topics: the follow-up on task 1 names exactly the clients that retry on 503 and 502", summary.topics.correct, { expected: both, named });
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
if (summary.topics) console.log(`\ntopics: ${JSON.stringify(summary.topics, null, 1)}`);
if (summary.long) {
	const L = summary.long;
	console.log(`\nlong: ${L.requests} requests, max context ${L.maxContext}, suite green: ${L.suiteGreen}, recall: ${L.recallCalls}, repeated non-suite calls: ${L.repeatedNonSuiteCalls.length}`);
	console.log(`context: ${L.spark}`);
	console.log(`every 5th request: ${L.contexts.filter((_, i) => i % 5 === 0).join(" ")}`);
	console.log(`totals: ${JSON.stringify(L.totals)}; Jev $${L.jevCostUsd.toFixed(5)}`);
	for (const c of L.checkpoints) console.log(`${c.phase} after request ${c.requestIndex}: saved ${c.savedChars} in ${c.ms} ms $${(c.costUsd ?? 0).toFixed(5)}; before ${JSON.stringify(c.before)} next ${JSON.stringify(c.after)}\n  ${c.results.join("\n  ")}`);
}
if (summary.history) console.log(`\nhistory: ${JSON.stringify(summary.history, null, 1)}`);
console.log("\nchecks:");
for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.name}${c.ok ? "" : ` → ${JSON.stringify(c.detail)}`}`);
console.log(`\nartifacts: ${out}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
