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

export type PinResult = "pinned" | "no-cache" | "no-question" | "already" | "over-budget" | "not-anthropic";

/** Mutates an Anthropic Messages payload in place. */
export function pinQuestionBreakpoint(payload: unknown): PinResult {
	if (!payload || typeof payload !== "object") return "not-anthropic";
	const body = payload as Json;
	const messages = body.messages;
	if (!Array.isArray(messages) || messages.length < 2) return "no-question";

	// Reuse Pi's rolling breakpoint settings (type + ttl) so TTL ordering stays valid.
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
	block.cache_control = { ...rolling };

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
