/**
 * Text returned by the `recall` tool: the original tool output, optionally filtered by a regex
 * or limited to a line window, truncated like Pi's `read` tool.
 */
import { MARKER } from "./render.ts";
import { type SourceEntryLike, textOf } from "./types.ts";

export const RECALL_MAX_LINES = 2_000;
export const RECALL_MAX_BYTES = 50 * 1024;

export interface RecallParams {
	entryId: string;
	pattern?: string;
	offset?: number;
	limit?: number;
}

export function originalOutput(entry: SourceEntryLike | undefined, entryId: string): string {
	const message = entry?.type === "message" ? entry.message : undefined;
	if (message?.role !== "toolResult") throw new Error(`No tool result with entry id ${entryId}. Use the id from a "${MARKER}" header.`);
	return textOf(message);
}

export function recallText(original: string, params: Omit<RecallParams, "entryId">): string {
	const lines = original.split("\n");
	let numbered: { n: number; line: string }[] = lines.map((line, i) => ({ n: i + 1, line }));
	let prefix = false;

	if (params.pattern) {
		let re: RegExp;
		try {
			re = new RegExp(params.pattern);
		} catch (err) {
			throw new Error(`Invalid pattern: ${(err as Error).message}`);
		}
		numbered = numbered.filter(({ line }) => re.test(line));
		prefix = true;
		if (numbered.length === 0) return `No line of the original output (${lines.length} lines) matches /${params.pattern}/.`;
	}

	const start = params.offset && params.offset > 1 ? Math.floor(params.offset) - 1 : 0;
	const requested = params.limit && params.limit > 0 ? Math.floor(params.limit) : Number.POSITIVE_INFINITY;
	const window = numbered.slice(start, start + Math.min(requested, RECALL_MAX_LINES));
	if (window.length === 0) return `Offset ${params.offset} is beyond the end (${numbered.length} ${prefix ? "matching " : ""}lines).`;

	const out: string[] = [];
	let bytes = 0;
	for (const { n, line } of window) {
		const text = prefix ? `${n}: ${line}` : line;
		const size = Buffer.byteLength(text, "utf8") + 1;
		if (bytes + size > RECALL_MAX_BYTES && out.length > 0) break;
		out.push(text);
		bytes += size;
	}
	const shownEnd = start + out.length;
	if (shownEnd < numbered.length) {
		const unit = prefix ? "matching lines" : "lines";
		out.push("", `[Showing ${unit} ${start + 1}–${shownEnd} of ${numbered.length}. Use offset=${shownEnd + 1} to continue.]`);
	}
	return out.join("\n");
}
