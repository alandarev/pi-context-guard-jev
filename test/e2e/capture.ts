/**
 * E2E helper extension: records every provider request payload (as finally sent) and the usage
 * of every assistant message, so the driver can check what the model saw and what was cached.
 *
 * Load it LAST (after context-guard and any auth extension) so it sees the final payload.
 * Writes JSONL to $CG_CAPTURE_FILE and full payloads next to it.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARKER = "[context-guard]";

function breakpointPaths(payload: any): string[] {
	const paths: string[] = [];
	const visit = (value: unknown, path: string) => {
		if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${path}[${i}]`));
		else if (value && typeof value === "object") {
			if ((value as any).cache_control) paths.push(`${path}${(value as any).cache_control.ttl ? `(ttl=${(value as any).cache_control.ttl})` : ""}`);
			for (const [k, v] of Object.entries(value)) if (k !== "cache_control") visit(v, `${path}.${k}`);
		}
	};
	visit(payload?.tools, "tools");
	visit(payload?.system, "system");
	visit(payload?.messages, "messages");
	return paths;
}

export default function capture(pi: ExtensionAPI) {
	const file = process.env.CG_CAPTURE_FILE;
	if (!file) return;
	let n = 0;
	const write = (record: Record<string, unknown>) => appendFileSync(file, `${JSON.stringify({ t: Date.now(), ...record })}\n`);

	pi.on("before_provider_request", (event, ctx) => {
		n++;
		const payload = event.payload as any;
		const json = JSON.stringify(payload);
		writeFileSync(`${file}.t${process.env.CG_TURN ?? "0"}-${String(n).padStart(3, "0")}.json`, json);
		const items = payload?.messages ?? payload?.input;
		write({
			kind: "request",
			turn: Number(process.env.CG_TURN ?? 0),
			n,
			api: ctx.model?.api,
			model: ctx.model?.id,
			bytes: json.length,
			items: Array.isArray(items) ? items.length : undefined,
			markers: json.split(MARKER).length - 1,
			breakpoints: breakpointPaths(payload),
			promptCacheKey: payload?.prompt_cache_key,
		});
	});

	pi.on("message_end", (event) => {
		const message = event.message as any;
		if (message?.role !== "assistant") return;
		write({
			kind: "assistant",
			stopReason: message.stopReason,
			usage: message.usage,
			toolCalls: (message.content ?? []).filter((b: any) => b.type === "toolCall").map((b: any) => ({ name: b.name, args: b.arguments })),
		});
	});
}
