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
	/** Add an Anthropic cache breakpoint at the previous user question (see docs/CACHE.md). */
	pinAnthropicCache: boolean;
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
};

const INTEGER_KEYS = new Set<keyof GuardConfig>(["minResultChars", "minRunChars", "timeoutMs", "concurrency", "maxSegmentChars", "maxChunksPerSegment", "historyExchanges"]);

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
