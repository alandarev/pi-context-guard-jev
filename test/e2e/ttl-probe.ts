/**
 * Anthropic prompt-cache TTL experiment (docs/CACHE.md → "Does a marked breakpoint stay alive?").
 *
 * Question: Pi's rolling breakpoint makes every request read the longest cached prefix. Does an
 * earlier breakpoint A that every request also marks stay alive (its 5-minute TTL refreshed), even
 * though A itself is never the prefix that is read? This decides whether a checkpoint 15 minutes
 * into a run can still read the conversation up to its "frontier".
 *
 * Driven by test/e2e/ttl-probe.mjs. The prompt makes the model `cat` a large file once and then
 * `sleep 55` eight times, one call per request. A = the `cat` tool result.
 *
 *   PROBE_ARM=refresh  A marked (5m) on every request
 *   PROBE_ARM=control  A marked (5m) only on the request that first contains it
 *   PROBE_ARM=ttl1h    A marked with ttl "1h" on every request (earlier breakpoints upgraded to 1h)
 *
 * PROBE_DELAY_AT / PROBE_DELAY_MS (idle arms): the request is held back that long first, so no
 * request reads the cache in between.
 *
 * From request PROBE_EDIT_AT on, the tool result right after A is changed, so nothing after A can
 * match; A is marked in every arm. The cacheRead of that request shows whether A was still alive.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Json = Record<string, any>;

export default function ttlProbe(pi: ExtensionAPI) {
	const arm = process.env.PROBE_ARM ?? "refresh";
	const editAt = Number(process.env.PROBE_EDIT_AT ?? 10);
	let n = 0;
	let firstSeen = 0;
	const delayAt = Number(process.env.PROBE_DELAY_AT ?? 0);
	const delayMs = Number(process.env.PROBE_DELAY_MS ?? 0);
	// Pi's own cache warming (setting `cacheWarming`, default "streaming") re-reads the prefix while
	// a request waits; the idle arms must not be refreshed by it.
	if (delayMs > 0) pi.on("cache_warming_decision", () => ({ action: "stop" }));
	pi.on("before_provider_request", async (event) => {
		const body = event.payload as Json;
		if (!Array.isArray(body?.messages)) return;
		n++;
		const results: Json[] = body.messages.flatMap((m: Json) => (Array.isArray(m.content) ? m.content.filter((b: Json) => b?.type === "tool_result") : []));
		const anchor = results[0];
		if (!anchor) return;
		if (!firstSeen) firstSeen = n;
		// idle arms: hold this request back, so nothing reads the cache for PROBE_DELAY_MS.
		if (n === delayAt && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
		const editing = n >= editAt;
		if (editing && results[1]) results[1].content = [{ type: "text", text: `edited by ttl-probe at request ${n}` }];
		const mark = arm !== "control" || n === firstSeen || editing;
		if (!mark) return;
		// OAuth payloads carry 4 breakpoints already: the system[0] identity block is redundant.
		if (Array.isArray(body.system) && body.system.length > 1) delete body.system[0].cache_control;
		const ttl1h = arm === "ttl1h";
		anchor.cache_control = ttl1h ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
		if (ttl1h) {
			// Longer TTLs must come first: upgrade the tools and system breakpoints too.
			for (const block of [...(body.tools ?? []), ...(body.system ?? [])]) if (block?.cache_control) block.cache_control = { type: "ephemeral", ttl: "1h" };
		}
	});
}
