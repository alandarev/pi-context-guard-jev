/**
 * E2E helper: API-validity probe for shortened tool-call arguments. At every mid-run turn boundary
 * (turn_end) it shortens the long string arguments (saving ≥ CG_ARGS_MIN characters, default 500) of
 * earlier assistant messages of the current run (after the last user message) with src/args.ts →
 * elideString, the way context-guard's old-argument rule does: the content array is copied unchanged (text, thinking
 * blocks with their signatures, tool-call ids and names) except those argument values. The next request
 * of the same run then sends an earlier assistant message of the tool-use loop with edited tool input.
 *
 * Driven by test/e2e/args-probe-run.mjs (CG_ARGS_MIN, CG_ARGS_KEEP, CG_ARGS_SCOPE).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { elideString } from "../../src/args.ts";

type Block = { type: string; arguments?: Record<string, unknown>; [key: string]: unknown };
type Entry = { sourceEntry: { id: string }; messages: { role: string; content: unknown }[] };

export default function argsProbe(pi: ExtensionAPI) {
	const min = Number(process.env.CG_ARGS_MIN ?? 500);
	// Stub assistant messages followed by at least this many assistant messages (1 = every earlier one).
	const keep = Number(process.env.CG_ARGS_KEEP ?? 1);
	pi.on("turn_end", async (event) => {
		const entries = event.context.contextEntries as unknown as Entry[];
		let lastUser = -1;
		entries.forEach((e, i) => {
			if (e.messages[0]?.role === "user") lastUser = i;
		});
		// CG_ARGS_SCOPE=earlier: stub messages of earlier runs (before the last user message) instead.
		const earlier = process.env.CG_ARGS_SCOPE === "earlier";
		const assistants = entries.map((e, i) => ({ e, i })).filter(({ e, i }) => (earlier ? i < lastUser : i > lastUser) && e.messages[0]?.role === "assistant");
		const drafts: unknown[] = [];
		for (const { e } of earlier ? assistants : assistants.slice(0, Math.max(0, assistants.length - keep))) {
			const content = e.messages[0].content;
			if (!Array.isArray(content)) continue;
			let stubbed = 0;
			const next = (content as Block[]).map((block) => {
				if (block.type !== "toolCall" || !block.arguments) return block;
				const args = Object.fromEntries(
					Object.entries(block.arguments).map(([k, v]) => {
						const short = typeof v === "string" ? elideString(v, e.sourceEntry.id, min) : undefined;
						if (short === undefined) return [k, v];
						stubbed++;
						return [k, short];
					}),
				);
				return { ...block, arguments: args };
			});
			if (stubbed === 0) continue;
			const kinds = (content as Block[]).map((b) => b.type + (b.type === "thinking" && b.thinkingSignature ? "(signed)" : "")).join(",");
			process.stderr.write(`args-probe: shortening ${stubbed} argument(s) of ${e.sourceEntry.id} [${kinds}]\n`);
			drafts.push({ type: "context_edit", targetId: e.sourceEntry.id, replacement: { content: next } });
		}
		if (drafts.length === 0) return;
		return { entries: [...event.entries, ...(drafts as never[])] };
	});
}
