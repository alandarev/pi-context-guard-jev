/**
 * Replay real sessions against Jev with response caching, to tune thresholds offline.
 *
 *   node test/analysis/jev-replay.ts --cache cache.jsonl --out items.jsonl [--budget 4.5] [--offline]
 *        [--set '{"chunkKeepThreshold":0.5}'] session.jsonl...
 *
 * The guard's own records and context edits are stripped first, so each session is replayed as if the
 * guard were fresh. Edits are NOT applied during the replay (the model saw the full outputs in these
 * sessions); an item's final state is "removed at a checkpoint, or else at run end". Mid-run checkpoints
 * use the real gates (batch size, break-even with the conservative rewrite of replay-session.ts).
 * With --offline every request must be in the cache (a miss counts as an error = keep), so threshold
 * sweeps cost nothing. Without it, uncached requests go to OpenRouter (OPENROUTER_API_KEY) until the
 * total cost reaches --budget.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildSessionProjection } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { classify as systemOne } from "../../node_modules/@earendil-works/pi-ai/dist/api/typesafe-system-one.js";
import { BREAK_EVEN_FACTOR, type CheckpointCandidate, collectCheckpoint, contextChars, paysOff } from "../../src/checkpoint.ts";
import { DEFAULT_CONFIG, normalizeConfig } from "../../src/config.ts";
import { buildCheckpointRequest } from "../../src/decide.ts";
import { collectExchanges, collectSmall, type WorkContext } from "../../src/items.ts";
import { processItems } from "../../src/process.ts";
import { collectRun, findRunStart, lastUserIndex, type RunInfo } from "../../src/run.ts";
import type { ClassifierRequest, ClassifierResponse, ProjectedEntryLike } from "../../src/types.ts";

const argv = process.argv.slice(2);
const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const cachePath = opt("--cache") ?? "/tmp/cg-replay/cache.jsonl";
const outPath = opt("--out") ?? "/tmp/cg-replay/items.jsonl";
const budget = Number(opt("--budget") ?? 4.5);
const offline = argv.includes("--offline");
const config = normalizeConfig({ ...DEFAULT_CONFIG, ...JSON.parse(opt("--set") ?? "{}") });
const valueFlags = new Set(["--cache", "--out", "--budget", "--set"]);
const files = argv.filter((a, i) => !a.startsWith("--") && !valueFlags.has(argv[i - 1]));

const cache = new Map<string, ClassifierResponse>();
let spent = 0;
if (existsSync(cachePath)) {
	for (const line of readFileSync(cachePath, "utf8").split("\n")) {
		if (!line) continue;
		const row = JSON.parse(line) as { key: string; response: ClassifierResponse };
		cache.set(row.key, row.response);
		spent += row.response.usage?.cost.total ?? 0;
	}
}
let misses = 0;
let fresh = 0;
let exhausted = false;
const model = { id: "~typesafe/jev-latest", name: "jev", api: "typesafe-system-one", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", input: ["text"], cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 0, reasoning: false };

async function classify(request: ClassifierRequest, signal: AbortSignal): Promise<ClassifierResponse> {
	const key = createHash("sha256").update(JSON.stringify(request)).digest("hex");
	const hit = cache.get(key);
	if (hit) return hit;
	if (offline) {
		misses++;
		return { answers: {}, stopReason: "error", errorMessage: "cache miss" };
	}
	if (spent >= budget) {
		exhausted = true;
		return { answers: {}, stopReason: "error", errorMessage: "budget" };
	}
	const response = (await systemOne(model as never, request as never, { apiKey: process.env.OPENROUTER_API_KEY, signal, timeoutMs: 30_000, maxRetries: 2 } as never)) as ClassifierResponse;
	if (response.stopReason !== "stop") return response; // not cached: errors are retried next time
	fresh++;
	spent += response.usage?.cost.total ?? 0;
	cache.set(key, response);
	appendFileSync(cachePath, `${JSON.stringify({ key, response })}\n`);
	return response;
}

type Entry = { type: string; id: string; parentId?: string | null; customType?: string; message?: { role: string; content: unknown; stopReason?: string; provider?: string } };
const hasToolCall = (e: Entry) => Array.isArray(e.message?.content) && (e.message!.content as { type?: string }[]).some((b) => b?.type === "toolCall");
const textOf = (content: unknown): string =>
	typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n") : "";

/** Lines of `original` that the replacement no longer shows verbatim. */
function removedText(original: string, replacement: string): string {
	const kept = new Set(replacement.split("\n"));
	return original
		.split("\n")
		.filter((l) => !kept.has(l))
		.join("\n");
}

writeFileSync(outPath, "");

for (const file of files) {
	// Strip the guard: its records and every context edit (images were the only edits in these sessions).
	const raw: Entry[] = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const dropped = new Set(raw.filter((e) => e.type === "context_edit" || (e.type === "custom" && e.customType === "context-guard")).map((e) => e.id));
	const parentOf = new Map(raw.map((e) => [e.id, e.parentId ?? null]));
	const liveParent = (id: string | null | undefined): string | null => {
		let p = id ?? null;
		while (p && dropped.has(p)) p = parentOf.get(p) ?? null;
		return p;
	};
	const entries = raw.filter((e) => !dropped.has(e.id)).map((e) => ({ ...e, parentId: liveParent(e.parentId) }));
	const byId = new Map(entries.map((e) => [e.id, e]));
	const provider = entries.find((e) => e.message?.role === "assistant")?.message?.provider ?? "";
	const midMemo = new Set<string>();
	let exMemo = new Set<string>();
	let runStartId = "";
	const removedMid = new Set<string>();
	const write = (phase: string, pos: number, outcome: Awaited<ReturnType<typeof processItems>>, texts: Map<string, string>) => {
		const replacements = new Map(outcome.edits.map((e) => [e.targetId, e.replacement ? textOf(e.replacement.content) : ""]));
		for (const r of outcome.records) {
			const original = texts.get(r.entryId) ?? "";
			const rep = replacements.get(r.entryId);
			appendFileSync(
				outPath,
				`${JSON.stringify({
					file,
					phase,
					pos,
					kind: r.kind,
					entryId: r.entryId,
					tool: r.tool,
					outcome: r.outcome,
					reason: r.reason,
					beforeChars: r.beforeChars,
					afterChars: r.afterChars,
					jev: r.jev,
					removed: rep === undefined || r.kind === "exchange" ? "" : removedText(original, rep),
				})}\n`,
			);
		}
	};
	{
		for (let i = 1; i < entries.length; i++) {
			const e = entries[i];
			if (e.type !== "message" || e.message?.role !== "assistant") continue;
			const toolTurn = hasToolCall(e);
			let leaf = i;
			for (let j = i + 1; j < entries.length; j++) {
				const n = entries[j];
				if (n.type === "message" && n.message?.role === "toolResult") leaf = j;
				else if (n.type === "message" || n.type === "custom_message") break;
			}
			if (toolTurn && leaf === i) continue;
			const projection = buildSessionProjection(entries as never, entries[leaf].id, byId as never).entries as unknown as ProjectedEntryLike[];
			const runStart = findRunStart(projection);
			const rsId = projection[runStart]?.sourceEntry.id ?? "";
			if (rsId !== runStartId) {
				runStartId = rsId;
				exMemo = new Set();
			}
			const texts = new Map(projection.map((p) => [p.sourceEntry.id, textOf(p.messages[0]?.content)]));
			if (toolTurn) {
				if (e.message?.stopReason !== "toolUse") continue;
				const info = collectCheckpoint(projection, config, midMemo);
				if (!info) continue;
				const small = collectSmall(projection.slice(runStart + 1), config, midMemo, info.currentTurn - config.midRunMinAgeTurns);
				const exchanges = config.pruneExchanges ? collectExchanges(projection, runStart, config.keepRecentExchanges, exMemo) : [];
				const outputChars = info.pendingChars + small.reduce((n, s) => n + s.text.length, 0);
				const pin = lastUserIndex(projection);
				const outputIds = new Set([...info.candidates.map((c) => c.entryId), ...small.map((s) => s.entryId)]);
				const rewrite = (ids: Set<string>) => {
					if (provider === "openai-codex") return contextChars(projection);
					const earliest = projection.findIndex((p) => ids.has(p.sourceEntry.id));
					return contextChars(projection.slice(earliest >= 0 && earliest <= pin ? 0 : pin + 1));
				};
				const factor = provider === "openai-codex" ? BREAK_EVEN_FACTOR.full : BREAK_EVEN_FACTOR.prefix;
				const tiers = [exchanges, []];
				const chosen = tiers.find((tier) => {
					const chars = outputChars + tier.reduce((n, x) => n + x.chars, 0);
					if (chars < config.midRunBatchChars) return false;
					return paysOff(chars, info.currentTurn + 1, rewrite(new Set([...outputIds, ...tier.map((x) => x.entryId)])), factor);
				});
				if (!chosen) continue;
				const run: RunInfo = { question: info.question, answer: "", notes: info.notes, candidates: info.candidates, toolResults: 0, history: info.history };
				const work: WorkContext = { question: info.question, history: info.history, latest: info.latest, notes: info.notes };
				const outcome = await processItems(run, small, chosen, work, classify, {
					...config,
					minRunChars: 0,
					timeoutMs: 120_000,
					chunkKeepThreshold: config.midRunChunkKeepThreshold,
					requestBuilder: (candidate, segment, si, sc, tl) => buildCheckpointRequest(info, candidate as CheckpointCandidate, segment, si, sc, tl),
				});
				for (const r of outcome.records) {
					if (r.kind === "exchange") {
						if (!/error|timeout/.test(r.reason)) exMemo.add(r.entryId);
					} else if (!/error|timeout/.test(r.reason)) midMemo.add(r.entryId);
					if (r.outcome !== "kept") removedMid.add(r.entryId);
				}
				write("mid-run", i, outcome, texts);
				if (exhausted) break;
			} else {
				if (e.message?.stopReason !== "stop") continue;
				const run = collectRun(projection, config, removedMid);
				if (!run) continue;
				if (run.candidates.reduce((n, c) => n + c.text.length, 0) < config.minRunChars) run.candidates = [];
				const small = collectSmall(projection.slice(runStart + 1), config, removedMid);
				const exchanges = config.pruneExchanges ? collectExchanges(projection, runStart, config.keepRecentExchanges, exMemo) : [];
				if (run.candidates.length + small.length + exchanges.length === 0) continue;
				const work: WorkContext = { question: run.question, history: run.history ?? { exchanges: [] }, answer: run.answer };
				const outcome = await processItems(run, small, exchanges, work, classify, { ...config, timeoutMs: 120_000 });
				write("run-end", i, outcome, texts);
				if (exhausted) break;
			}
		}
		console.error(`${file.split("/").slice(-2).join("/")}: spent $${spent.toFixed(3)} fresh ${fresh} misses ${misses}${exhausted ? " (budget reached, stopped)" : ""}`);
		if (exhausted) break;
	}
}
console.error(`total spent $${spent.toFixed(3)}, fresh requests ${fresh}, cache misses ${misses}`);
