/**
 * Offline replay of a real session file against the guard's gates (no model calls).
 *
 *   node test/e2e/replay-session.ts <session.jsonl> [--from <entry index>] [--all] [--summary]
 *
 * For every turn boundary (assistant message with tool calls + its tool results) it rebuilds the
 * projection Pi would hand to `turn_end` and reports what the mid-run checkpoint gates decide: run
 * start, current turn, eligible large/small outputs, old exchanges, batch size and break-even.
 * Run ends (assistant message without tool calls) report the `agent_before_settle` candidates.
 * `written` (this process's cache log) is unknown offline, so Anthropic rewrites fall back to the
 * question pin: the replay's break-even is the conservative case.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSessionProjection } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { BREAK_EVEN_FACTOR, charsFrom, collectCheckpoint, contextChars, exchangeMemo, memoFromBranch, paysOff } from "../../src/checkpoint.ts";
import { loadConfig } from "../../src/config.ts";
import { collectExchanges, collectSmall } from "../../src/items.ts";
import { collectRun, findRunStart } from "../../src/run.ts";
import { CUSTOM_TYPE } from "../../src/stats.ts";
import type { ProjectedEntryLike } from "../../src/types.ts";

const args = process.argv.slice(2);
const file = args[0];
if (!file) throw new Error("usage: replay-session.ts <session.jsonl> [--from N] [--all]");
const from = Number(args[args.indexOf("--from") + 1] || 0) || 0;
const showAll = args.includes("--all");
const summaryOnly = args.includes("--summary");
const log = (line: string) => {
	if (!summaryOnly) console.log(line);
};
/** Per run (keyed by the run's user entry): turns, gate verdicts, steering. */
type RunSummary = { turns: number; eligible: number; firstEligible?: number; belowBatch: number; breakEven: number; maxPending: number; steered: boolean; steeredPendingChars: number; lastPending: number };
const runs = new Map<string, RunSummary>();
const runOf = (id: string): RunSummary => {
	let r = runs.get(id);
	if (!r) runs.set(id, (r = { turns: 0, eligible: 0, belowBatch: 0, breakEven: 0, maxPending: 0, steered: false, steeredPendingChars: 0, lastPending: 0 }));
	return r;
};
const config = loadConfig(process.env.PI_CONTEXT_GUARD_CONFIG || join(homedir(), ".pi/agent/context-guard.json")).config;

type Entry = { type: string; id: string; parentId?: string | null; message?: { role: string; content: unknown; stopReason?: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } } };
const entries: Entry[] = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
const branchTo = (leafId: string): Entry[] => {
	const path: Entry[] = [];
	for (let e = byId.get(leafId); e; e = e.parentId ? byId.get(e.parentId) : undefined) path.unshift(e);
	return path;
};
const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
const hasToolCall = (e: Entry) => Array.isArray(e.message?.content) && (e.message.content as { type?: string }[]).some((b) => b?.type === "toolCall");

let lastLine = "";
for (let i = Math.max(1, from); i < entries.length; i++) {
	const e = entries[i];
	if (e.type !== "message" || e.message?.role !== "assistant") continue;
	const stop = e.message.stopReason;
	const toolTurn = hasToolCall(e);
	// The turn's tool results follow the assistant message.
	let leaf = i;
	for (let j = i + 1; j < entries.length; j++) {
		const n = entries[j];
		if (n.type === "message" && n.message?.role === "toolResult") leaf = j;
		else if (n.type === "message" || n.type === "custom_message") break;
	}
	if (toolTurn && leaf === i) continue; // still running (no results yet)
	const projection = buildSessionProjection(entries as never, entries[leaf].id, byId as never).entries as unknown as ProjectedEntryLike[];
	const branch = branchTo(entries[leaf].id);
	const runStart = findRunStart(projection);
	const ctxChars = contextChars(projection);
	const usage = e.message.usage;
	const ctxTok = usage ? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : 0;
	const head = `#${i} ${toolTurn ? "turn" : "END "} stop=${stop} ctx=${k(ctxChars)}ch/${k(ctxTok)}tok runStart=${runStart}/${projection.length}`;
	if (!toolTurn) {
		const run = collectRun(projection, config);
		const large = run ? run.candidates.reduce((n, c) => n + c.text.length, 0) : 0;
		const small = run ? collectSmall(projection.slice(runStart + 1), config, new Set()) : [];
		const ex = config.pruneExchanges ? collectExchanges(projection, runStart, config.keepRecentExchanges, exchangeMemo(branch as never, CUSTOM_TYPE)) : [];
		log(`${head} | run-end: large ${run?.candidates.length ?? 0} (${k(large)}${large < config.minRunChars ? " <minRun" : ""}) small ${small.length} exchanges ${ex.length}`);
		continue;
	}
	if (stop !== "toolUse" && stop !== "stop") {
		log(`${head} | outcome not completed`);
		continue;
	}
	const memo = memoFromBranch(branch as never, CUSTOM_TYPE);
	const info = collectCheckpoint(projection, config, memo);
	if (!info) {
		log(`${head} | no run`);
		continue;
	}
	const small = config.smallResultMinChars > 0 ? collectSmall(projection.slice(runStart + 1), config, memo, info.currentTurn - config.midRunMinAgeTurns) : [];
	const exchanges = config.pruneExchanges ? collectExchanges(projection, runStart, config.keepRecentExchanges, exchangeMemo(branch as never, CUSTOM_TYPE)) : [];
	const outputChars = info.pendingChars + small.reduce((n, s) => n + s.text.length, 0);
	const exchangeChars = exchanges.reduce((n, x) => n + x.chars, 0);
	// Span composition: what the run's tool results are made of.
	const span = projection.slice(runStart + 1);
	let textResults = 0, imageResults = 0, imageResultText = 0, errorResults = 0, toolResults = 0, textChars = 0;
	for (const p of span) {
		const m = p.messages[0];
		if (p.messages.length !== 1 || m?.role !== "toolResult") continue;
		toolResults++;
		const blocks = Array.isArray(m.content) ? m.content : [];
		const img = blocks.some((b) => b.type === "image");
		const t = typeof m.content === "string" ? m.content.length : blocks.reduce((n, b) => n + (b.type === "text" ? (b.text ?? "").length : 0), 0);
		if (img) { imageResults++; imageResultText += t; } else { textResults++; textChars += t; }
		if (m.isError) errorResults++;
	}
	let verdict: string;
	if (outputChars + exchangeChars < config.midRunBatchChars) verdict = `below batch (${k(outputChars + exchangeChars)} < ${k(config.midRunBatchChars)})`;
	else {
		const outputIds = new Set([...info.candidates.map((c) => c.entryId), ...small.map((s) => s.entryId)]);
		const allIds = new Set([...outputIds, ...exchanges.map((x) => x.entryId)]);
		const turns = info.currentTurn + 1;
		// Anthropic without a trusted read point: everything after the question (or all, if an exchange is edited).
		const rewrite = (ids: Set<string>) => {
			const earliest = projection.findIndex((p) => ids.has(p.sourceEntry.id));
			return contextChars(projection.slice(earliest >= 0 && earliest <= runStart ? 0 : runStart + 1));
		};
		const rwAll = rewrite(allIds), rwOut = rewrite(outputIds);
		const okAll = paysOff(outputChars + exchangeChars, turns, rwAll, BREAK_EVEN_FACTOR.prefix);
		const okOut = outputChars >= config.midRunBatchChars && paysOff(outputChars, turns, rwOut, BREAK_EVEN_FACTOR.prefix);
		verdict = okAll ? "CHECKPOINT (all)" : okOut ? "CHECKPOINT (outputs)" : `break-even fails: ${k(outputChars + exchangeChars)}×${turns}=${k((outputChars + exchangeChars) * turns)} vs 16×${k(rwAll)}=${k(16 * rwAll)}; outputs ${k(outputChars)}×${turns} vs 16×${k(rwOut)}=${k(16 * rwOut)} (charsFrom ${k(charsFrom(projection, outputIds))})`;
	}
	const line = `${head} turn=${info.currentTurn} results=${toolResults} (text ${textResults}/${k(textChars)}, image ${imageResults}, err ${errorResults}) large=${info.candidates.length}/${k(info.pendingChars)} small=${small.length} ex=${exchanges.length}/${k(exchangeChars)} | ${verdict}`;
	if (showAll || line.split("|")[1] !== lastLine) log(line);
	const run = runOf(projection[runStart]?.sourceEntry.id ?? "?");
	run.turns++;
	run.lastPending = outputChars;
	run.maxPending = Math.max(run.maxPending, outputChars);
	if (verdict.startsWith("CHECKPOINT")) {
		run.eligible++;
		run.firstEligible ??= info.currentTurn;
	} else if (verdict.startsWith("below")) run.belowBatch++;
	else run.breakEven++;
	// Steering: the next message after this turn's results is a user message (the run goes on in a new span).
	const next = entries.slice(leaf + 1).find((n) => n.type === "message");
	if (next?.message?.role === "user") {
		run.steered = true;
		run.steeredPendingChars = outputChars;
	}
	lastLine = line.split("|")[1];
}

if (summaryOnly) {
	const list = [...runs.values()];
	const sum = (f: (r: RunSummary) => number) => list.reduce((n, r) => n + f(r), 0);
	const eligibleRuns = list.filter((r) => r.eligible > 0);
	const firsts = eligibleRuns.map((r) => r.firstEligible ?? 0);
	console.log(
		[
			`runs=${list.length}`,
			`turns=${sum((r) => r.turns)}`,
			`runs≥60k=${list.filter((r) => r.maxPending >= config.midRunBatchChars).length}`,
			`eligibleRuns=${eligibleRuns.length}`,
			`eligibleTurns=${sum((r) => r.eligible)}`,
			`firstEligibleTurn=${firsts.length ? firsts.join(",") : "-"}`,
			`breakEvenFail=${sum((r) => r.breakEven)}`,
			`steered=${list.filter((r) => r.steered).length}`,
			`steeredPending=${k(sum((r) => r.steeredPendingChars))}`,
		].join(" "),
	);
}
