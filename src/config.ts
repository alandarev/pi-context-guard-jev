/**
 * Settings, stored as JSON in `<agentDir>/context-guard.json` (normally ~/.pi/agent/context-guard.json).
 * Every field is optional in the file; missing or invalid values fall back to the defaults.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface GuardConfig {
	/** Master switch. `/guard on|off` persists it. */
	enabled: boolean;
	/** Classifier model as `provider/id`; the first `/` separates provider from id. */
	model: string;
	/** Ignore tool results shorter than this (characters). */
	minResultChars: number;
	/** Skip a run whose candidate tool output totals less than this (characters). */
	minRunChars: number;
	/** Keep a result untouched when P(whole output needed) reaches this. */
	keepWholeThreshold: number;
	/** Keep a result untouched when Jev answers "most of it is needed" with at least this probability. */
	focusWholeThreshold: number;
	/** Keep a chunk when P(chunk needed) reaches this. */
	chunkKeepThreshold: number;
	/** Drop a whole result when Jev picks "none" with at least this probability and no chunk passes. */
	noneThreshold: number;
	/** Skip the edit when the kept part is larger than this fraction of the original. */
	maxKeepRatio: number;
	/**
	 * Also keep grep-style chunks for files the final answer names. Off by default: answers also
	 * name files to rule them out ("X only matches the word"), which keeps exactly the noise.
	 */
	keepCitedFiles: boolean;
	/** Total time budget for all Jev calls of one run (ms). Unfinished results are left alone. */
	timeoutMs: number;
	/** Parallel Jev requests. */
	concurrency: number;
	/** Largest piece of one tool output sent in a single Jev request (characters). */
	maxSegmentChars: number;
	/** Most chunks per Jev request. */
	maxChunksPerSegment: number;
	/** Tool names whose results are never distilled. */
	excludeTools: string[];
	/** Also distill error results, e.g. the log of a failing test or build command. */
	distillErrors: boolean;
	/**
	 * Earlier exchanges (user prompt + final assistant text) shown to Jev, so it judges relevance
	 * against the ongoing work too. 0 sends no earlier conversation at all (no summary either).
	 */
	historyExchanges: number;
	/**
	 * Add Anthropic cache breakpoints: at the previous user question, and after context edits at a
	 * read point before the first edited output (see docs/CACHE.md).
	 */
	pinAnthropicCache: boolean;
	/** Mid-run checkpoints: judge older tool outputs while a long run is still going. */
	midRun: boolean;
	/** A tool output is judged mid-run only once its turn is at least this many turns old. */
	midRunMinAgeTurns: number;
	/** Run a checkpoint only when the not-yet-judged eligible outputs total at least this (characters). */
	midRunBatchChars: number;
	/** Batch size for OpenAI Codex models, whose first request after an edit reads (almost) nothing from cache. */
	midRunBatchCharsOpenAI: number;
	/** Keep a chunk at a checkpoint when P(still needed) reaches this. */
	midRunChunkKeepThreshold: number;
	/** Skip a checkpoint unless its one-time prompt-cache rewrite is likely to pay off (docs/CACHE.md). */
	midRunBreakEven: boolean;
	/** Tool results from this size up to `minResultChars` are judged as whole items (0 turns this off). */
	smallResultMinChars: number;
	/** Keep a small output when P(still needed) reaches this. */
	smallKeepThreshold: number;
	/** Omit old exchanges judged unrelated to the current work. */
	pruneExchanges: boolean;
	/** The last this many exchanges before the current prompt are never omitted. */
	keepRecentExchanges: number;
	/** Omit an exchange only when P(still relevant) is below this. */
	exchangeOmitThreshold: number;
	/**
	 * Gate exchange omission at run end by the break-even rule (and `exchangeMinSavingChars`); deferred
	 * exchanges stay eligible and accumulate. `false` always omits unrelated exchanges.
	 */
	exchangeBreakEven: boolean;
	/** A pass omits exchanges only if they save at least this many characters together (when that costs a cache rewrite). */
	exchangeMinSavingChars: number;
	/**
	 * Remove images from tool results once they are this many turns old (assistant messages after the
	 * result); `recall` shows them again. Images in user messages are always kept. 0 turns this off.
	 */
	imageKeepTurns: number;
}

export const DEFAULT_CONFIG: GuardConfig = {
	enabled: true,
	model: "openrouter/~typesafe/jev-latest",
	minResultChars: 4_000,
	minRunChars: 8_000,
	keepWholeThreshold: 0.7,
	focusWholeThreshold: 0.6,
	chunkKeepThreshold: 0.6,
	noneThreshold: 0.5,
	maxKeepRatio: 0.6,
	keepCitedFiles: false,
	timeoutMs: 8_000,
	concurrency: 6,
	maxSegmentChars: 32_000,
	maxChunksPerSegment: 40,
	excludeTools: ["edit", "write"],
	distillErrors: true,
	historyExchanges: 3,
	pinAnthropicCache: true,
	midRun: true,
	midRunMinAgeTurns: 4,
	midRunBatchChars: 60_000,
	midRunBatchCharsOpenAI: 60_000,
	midRunChunkKeepThreshold: 0.6,
	midRunBreakEven: true,
	smallResultMinChars: 400,
	smallKeepThreshold: 0.45,
	pruneExchanges: true,
	keepRecentExchanges: 2,
	exchangeOmitThreshold: 0.2,
	exchangeBreakEven: true,
	exchangeMinSavingChars: 8_000,
	imageKeepTurns: 3,
};

const NUMBER_RANGES: Partial<Record<keyof GuardConfig, [number, number]>> = {
	minResultChars: [0, 10_000_000],
	minRunChars: [0, 10_000_000],
	keepWholeThreshold: [0, 1],
	focusWholeThreshold: [0, 1],
	chunkKeepThreshold: [0, 1],
	noneThreshold: [0, 1],
	maxKeepRatio: [0, 1],
	timeoutMs: [500, 600_000],
	concurrency: [1, 32],
	maxSegmentChars: [2_000, 200_000],
	maxChunksPerSegment: [2, 60],
	historyExchanges: [0, 10],
	midRunMinAgeTurns: [1, 100],
	midRunBatchChars: [0, 10_000_000],
	midRunBatchCharsOpenAI: [0, 10_000_000],
	midRunChunkKeepThreshold: [0, 1],
	smallResultMinChars: [0, 10_000_000],
	smallKeepThreshold: [0, 1],
	keepRecentExchanges: [0, 100],
	exchangeOmitThreshold: [0, 1],
	exchangeMinSavingChars: [0, 10_000_000],
	imageKeepTurns: [0, 1_000],
};

const INTEGER_KEYS = new Set<keyof GuardConfig>(["minResultChars", "minRunChars", "timeoutMs", "concurrency", "maxSegmentChars", "maxChunksPerSegment", "historyExchanges", "midRunMinAgeTurns", "midRunBatchChars", "midRunBatchCharsOpenAI", "smallResultMinChars", "keepRecentExchanges", "exchangeMinSavingChars", "imageKeepTurns"]);

/** Merge untrusted JSON over the defaults, keeping only well-typed, in-range values. */
export function normalizeConfig(raw: unknown): GuardConfig {
	const config: GuardConfig = { ...DEFAULT_CONFIG, excludeTools: [...DEFAULT_CONFIG.excludeTools] };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return config;
	const input = raw as Record<string, unknown>;
	for (const key of Object.keys(DEFAULT_CONFIG) as (keyof GuardConfig)[]) {
		const value = input[key];
		if (value === undefined) continue;
		const fallback = DEFAULT_CONFIG[key];
		if (typeof fallback === "boolean" && typeof value === "boolean") {
			(config as unknown as Record<string, unknown>)[key] = value;
		} else if (typeof fallback === "number" && typeof value === "number" && Number.isFinite(value)) {
			const range = NUMBER_RANGES[key];
			if (INTEGER_KEYS.has(key) && !Number.isInteger(value)) continue;
			if (!range || (value >= range[0] && value <= range[1])) (config as unknown as Record<string, unknown>)[key] = value;
		} else if (key === "model" && typeof value === "string" && value.indexOf("/") > 0) {
			config.model = value.trim();
		} else if (key === "excludeTools" && Array.isArray(value)) {
			config.excludeTools = value.filter((name): name is string => typeof name === "string");
		}
	}
	return config;
}

/** Split `provider/id` at the first slash (ids may contain slashes, e.g. `openrouter/~typesafe/jev-latest`). */
export function parseModelRef(ref: string): { provider: string; id: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export function loadConfig(path: string): { config: GuardConfig; error?: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { config: normalizeConfig(undefined) };
	}
	try {
		return { config: normalizeConfig(JSON.parse(text)) };
	} catch (err) {
		return { config: normalizeConfig(undefined), error: `invalid JSON in ${path}: ${(err as Error).message}` };
	}
}

/** Persist only the given keys, preserving anything else already in the file. */
export function saveConfigPatch(path: string, patch: Partial<GuardConfig>): void {
	let current: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
	} catch {
		// Missing or unreadable file: start fresh.
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}
