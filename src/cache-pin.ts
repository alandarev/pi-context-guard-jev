/**
 * Anthropic prompt-cache breakpoint at the previous user question (docs/CACHE.md → Fix).
 *
 * Pi puts a rolling breakpoint on the last message only. After a long run is distilled, the
 * next request's prefix still matches up to the run's question, but that cache entry can be
 * more than 20 block positions back from the rolling breakpoint, beyond Anthropic's lookback.
 * Pinning a breakpoint on the most recent user text that is NOT the last message keeps that
 * entry read (and refreshed) by every request of the run and by the first request after it.
 */

export const ANTHROPIC_MAX_BREAKPOINTS = 4;

type Json = Record<string, any>;

export function countBreakpoints(payload: Json): number {
	let n = 0;
	const visit = (value: unknown) => {
		if (Array.isArray(value)) value.forEach(visit);
		else if (value && typeof value === "object") {
			if ((value as Json).cache_control) n++;
			for (const child of Object.values(value)) visit(child);
		}
	};
	visit([payload.tools, payload.system, payload.messages]);
	return n;
}

function lastCacheControl(messages: Json[]): Json | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const content = messages[i]?.content;
		if (!Array.isArray(content)) continue;
		for (let j = content.length - 1; j >= 0; j--) if (content[j]?.cache_control) return content[j].cache_control;
	}
	return undefined;
}

const hasText = (message: Json): boolean =>
	typeof message.content === "string"
		? message.content.trim().length > 0
		: Array.isArray(message.content) && message.content.some((b: Json) => b?.type === "text" && typeof b.text === "string" && b.text.trim());

export type PinResult = "pinned" | "no-cache" | "no-question" | "already" | "over-budget" | "ttl-conflict" | "not-anthropic";

/** Anthropic TTLs in minutes; a breakpoint without `ttl` lasts 5 minutes. */
const ttlMinutes = (cacheControl: Json): number => (cacheControl.ttl === "1h" ? 60 : 5);

/**
 * TTLs of the breakpoints before and after `target`, in Anthropic's prefix order
 * (tools → system → messages).
 */
function ttlsAround(payload: Json, target: Json): { before: number[]; after: number[] } {
	const result = { before: [] as number[], after: [] as number[] };
	let passed = false;
	const visit = (value: unknown) => {
		if (Array.isArray(value)) value.forEach(visit);
		else if (value && typeof value === "object") {
			if (value === target) passed = true;
			else if ((value as Json).cache_control) (passed ? result.after : result.before).push(ttlMinutes((value as Json).cache_control));
			for (const child of Object.values(value)) visit(child);
		}
	};
	visit([payload.tools, payload.system, payload.messages]);
	return result;
}

/** Mutates an Anthropic Messages payload in place. */
export function pinQuestionBreakpoint(payload: unknown): PinResult {
	if (!payload || typeof payload !== "object") return "not-anthropic";
	const body = payload as Json;
	const messages = body.messages;
	if (!Array.isArray(messages) || messages.length < 2) return "no-question";

	// Reuse Pi's rolling breakpoint settings (type, and ttl when the ordering allows it).
	const rolling = lastCacheControl(messages);
	if (!rolling) return "no-cache";

	// Mid-conversation `system` messages (effort, tool changes) can follow the last turn.
	let last = messages.length - 1;
	while (last >= 0 && messages[last]?.role === "system") last--;
	let target = -1;
	for (let i = last - 1; i >= 0; i--) {
		if (messages[i]?.role === "user" && hasText(messages[i])) {
			target = i;
			break;
		}
	}
	if (target < 0) return "no-question";

	const question = messages[target];
	if (typeof question.content === "string") question.content = [{ type: "text", text: question.content }];
	const block = question.content.findLast((b: Json) => b?.type === "text" && typeof b.text === "string" && b.text.trim());
	if (!block) return "no-question";
	if (block.cache_control) return "already";

	// Longer TTLs must come first: every breakpoint before the pin needs TTL ≥ the pin's, every
	// one after it TTL ≤ the pin's. Prefer the rolling breakpoint's TTL, else try the other one.
	const { before, after } = ttlsAround(body, block);
	const fits = (ttl: number) => before.every((t) => t >= ttl) && after.every((t) => t <= ttl);
	const rollingTtl = ttlMinutes(rolling);
	const ttl = [rollingTtl, rollingTtl === 60 ? 5 : 60].find(fits);
	if (ttl === undefined) return "ttl-conflict";
	const { ttl: _rollingTtl, ...rest } = rolling;
	block.cache_control = ttl === 60 ? { ...rest, ttl: "1h" } : rest;

	let identityCacheControl: unknown;
	if (countBreakpoints(body) > ANTHROPIC_MAX_BREAKPOINTS) {
		// OAuth requests carry a breakpoint on the tiny Claude Code identity block (system[0]);
		// the breakpoint on system[1] covers that prefix too, so it is redundant.
		const system = body.system;
		if (Array.isArray(system) && system.length > 1 && system[0]?.cache_control) {
			identityCacheControl = system[0].cache_control;
			delete system[0].cache_control;
		}
	}
	if (countBreakpoints(body) > ANTHROPIC_MAX_BREAKPOINTS) {
		// Leave the payload exactly as Pi built it.
		delete block.cache_control;
		if (identityCacheControl) body.system[0].cache_control = identityCacheControl;
		return "over-budget";
	}
	return "pinned";
}

// ---------------------------------------------------------------------------------------------
// Read-point anchors after context edits (docs/CACHE.md → Mid-run checkpoints)
// ---------------------------------------------------------------------------------------------

/** Pi's Anthropic provider rewrites tool call ids like this (pi-ai anthropic-messages.js). */
export const normalizeToolUseId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

export interface GuardBreakpointOptions {
	/** Tool call ids that get a read anchor, highest priority first (after the question). */
	anchors: readonly string[];
	/** Tool call ids that get a breakpoint only to write a cache entry (lowest priority). */
	writeAnchors?: readonly string[];
	/** Pin the previous user question. It has the highest priority: it is the floor every edit falls back to. */
	pinQuestion: boolean;
}

export interface GuardBreakpointResult {
	/** Anchors placed (ids from `anchors` and `writeAnchors`). */
	anchored: string[];
	/** Anchors that could not be placed, with the reason. */
	skipped: { id: string; reason: "not-found" | "in-last-message" | "already" | "over-budget" | "ttl-conflict" }[];
	question: PinResult | "off";
	/** Breakpoints Pi placed that were removed to make room. */
	removed: string[];
}

function findToolResult(messages: Json[], id: string, before: number): { index: number; block: Json } | undefined {
	const ids = new Set([id, normalizeToolUseId(id)]);
	for (let i = 0; i < messages.length; i++) {
		const content = messages[i]?.content;
		if (!Array.isArray(content)) continue;
		const block = content.find((b: Json) => b?.type === "tool_result" && ids.has(b.tool_use_id));
		if (block) return i < before ? { index: i, block } : { index: -1, block };
	}
	return undefined;
}

/** Index of `target` among the cacheable blocks of the payload (prefix order). */
function positionOf(payload: Json, target: Json): number {
	let n = 0;
	let found = -1;
	const visit = (value: unknown) => {
		if (found >= 0) return;
		if (Array.isArray(value)) value.forEach(visit);
		else if (value && typeof value === "object") {
			if (value === target) {
				found = n;
				return;
			}
			n++;
			for (const [key, child] of Object.entries(value)) if (key !== "cache_control") visit(child);
		}
	};
	visit([payload.tools, payload.system, payload.messages]);
	return found;
}

/** All blocks carrying cache_control, in prefix order (tools → system → messages). */
function breakpointBlocks(payload: Json): Json[] {
	const out: Json[] = [];
	const visit = (value: unknown) => {
		if (Array.isArray(value)) value.forEach(visit);
		else if (value && typeof value === "object") {
			if ((value as Json).cache_control) out.push(value as Json);
			for (const [key, child] of Object.entries(value)) if (key !== "cache_control") visit(child);
		}
	};
	visit([payload.tools, payload.system, payload.messages]);
	return out;
}

/**
 * Place the previous-question pin, read anchors and write anchors on an Anthropic Messages payload,
 * in place, in that priority. Respects the 4-breakpoint limit (dropping, in this order, the redundant
 * OAuth identity breakpoint, the tools breakpoint when the system prompt has one, then the
 * lowest-priority guard marks) and the TTL order (anchors use the rolling breakpoint's TTL; a mark that
 * cannot keep longer TTLs first is skipped).
 */
export function placeGuardBreakpoints(payload: unknown, options: GuardBreakpointOptions): GuardBreakpointResult {
	const result: GuardBreakpointResult = { anchored: [], skipped: [], question: options.pinQuestion ? "no-question" : "off", removed: [] };
	if (!payload || typeof payload !== "object") return { ...result, question: options.pinQuestion ? "not-anthropic" : "off" };
	const body = payload as Json;
	const messages = body.messages;
	if (!Array.isArray(messages)) return result;
	const rolling = lastCacheControl(messages);
	if (!rolling) return { ...result, question: options.pinQuestion ? "no-cache" : "off" };
	let last = messages.length - 1;
	while (last >= 0 && messages[last]?.role === "system") last--;

	// 1. Targets, highest priority first: question, read anchors, write anchors.
	const marks: { id: string; block: Json; kind: "question" | "anchor" | "write" }[] = [];
	if (options.pinQuestion) {
		let target = -1;
		for (let i = last - 1; i >= 0; i--) {
			if (messages[i]?.role === "user" && hasText(messages[i])) {
				target = i;
				break;
			}
		}
		if (target >= 0) {
			const question = messages[target];
			if (typeof question.content === "string") question.content = [{ type: "text", text: question.content }];
			const block = question.content.findLast((b: Json) => b?.type === "text" && typeof b.text === "string" && b.text.trim());
			if (block?.cache_control) result.question = "already";
			else if (block) marks.push({ id: "question", block, kind: "question" });
		}
	}
	const addAnchor = (id: string, kind: "anchor" | "write") => {
		const found = findToolResult(messages, id, last);
		if (!found) result.skipped.push({ id, reason: "not-found" });
		else if (found.index < 0) result.skipped.push({ id, reason: "in-last-message" });
		else if (found.block.cache_control || marks.some((m) => m.block === found.block)) result.skipped.push({ id, reason: "already" });
		else marks.push({ id, block: found.block, kind });
	};
	for (const id of options.anchors) addAnchor(id, "anchor");
	for (const id of options.writeAnchors ?? []) addAnchor(id, "write");

	// 2. Apply with TTL order: the rolling TTL if it fits, else the other one, else skip.
	const applied: typeof marks = [];
	const { ttl: _rollingTtl, ...rollingRest } = rolling;
	for (const mark of marks) {
		const position = positionOf(body, mark.block);
		const others = breakpointBlocks(body).filter((b) => b !== mark.block);
		const before = others.filter((b) => positionOf(body, b) < position);
		const after = others.filter((b) => positionOf(body, b) > position);
		const fits = (ttl: number) => before.every((b) => ttlMinutes(b.cache_control) >= ttl) && after.every((b) => ttlMinutes(b.cache_control) <= ttl);
		const ttl = [ttlMinutes(rolling), ttlMinutes(rolling) === 60 ? 5 : 60].find(fits);
		if (ttl === undefined) {
			if (mark.kind === "question") result.question = "ttl-conflict";
			else result.skipped.push({ id: mark.id, reason: "ttl-conflict" });
			continue;
		}
		mark.block.cache_control = ttl === 60 ? { ...rollingRest, ttl: "1h" } : { ...rollingRest };
		applied.push(mark);
	}

	// 3. Budget.
	const system = body.system;
	if (countBreakpoints(body) > ANTHROPIC_MAX_BREAKPOINTS && Array.isArray(system) && system.length > 1 && system[0]?.cache_control && system.slice(1).some((b: Json) => b?.cache_control)) {
		delete system[0].cache_control;
		result.removed.push("system[0]");
	}
	const tools = Array.isArray(body.tools) ? body.tools : [];
	if (countBreakpoints(body) > ANTHROPIC_MAX_BREAKPOINTS && Array.isArray(system) && system.some((b: Json) => b?.cache_control)) {
		const toolBlock = tools.findLast((b: Json) => b?.cache_control);
		if (toolBlock) {
			delete toolBlock.cache_control;
			result.removed.push("tools");
		}
	}
	while (countBreakpoints(body) > ANTHROPIC_MAX_BREAKPOINTS && applied.length > 0) {
		const dropped = applied.pop() as (typeof applied)[number];
		delete dropped.block.cache_control;
		if (dropped.kind === "question") result.question = "over-budget";
		else result.skipped.push({ id: dropped.id, reason: "over-budget" });
	}
	for (const mark of applied) {
		if (mark.kind === "question") result.question = "pinned";
		else result.anchored.push(mark.id);
	}
	return result;
}

/** Tool-use ids of the tool_result blocks that carry a breakpoint in the final payload. */
export function markedToolResults(payload: unknown): string[] {
	const messages = (payload as Json | undefined)?.messages;
	if (!Array.isArray(messages)) return [];
	return messages.flatMap((m: Json) => (Array.isArray(m?.content) ? m.content.filter((b: Json) => b?.type === "tool_result" && b.cache_control).map((b: Json) => String(b.tool_use_id)) : []));
}
