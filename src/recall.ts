/**
 * Text returned by the `recall` tool: the original tool output, optionally filtered by a regex
 * or limited to a line window, truncated like Pi's `read` tool.
 */
import vm from "node:vm";
import { MARKER } from "./render.ts";
import { type SourceEntryLike, textOf } from "./types.ts";

export const RECALL_MAX_LINES = 2_000;
export const RECALL_MAX_BYTES = 50 * 1024;
/** Longest accepted `pattern` (characters). */
export const RECALL_MAX_PATTERN = 500;
/** Only this many leading characters of each line are matched against `pattern`. */
export const RECALL_MATCH_CHARS = 4_000;
/** Wall-clock limit for filtering by `pattern` (ms); stops catastrophic backtracking. */
export const RECALL_PATTERN_TIMEOUT_MS = 1_000;

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
		const matching = new Set(matchingLines(lines, params.pattern));
		numbered = numbered.filter((_, i) => matching.has(i));
		prefix = true;
		if (numbered.length === 0) return `No line of the original output (${lines.length} lines) matches /${params.pattern}/.`;
	}

	const start = params.offset && params.offset > 1 ? Math.floor(params.offset) - 1 : 0;
	const requested = params.limit && params.limit > 0 ? Math.floor(params.limit) : Number.POSITIVE_INFINITY;
	const window = numbered.slice(start, start + Math.min(requested, RECALL_MAX_LINES));
	if (window.length === 0) return `Offset ${params.offset} is beyond the end (${numbered.length} ${prefix ? "matching " : ""}lines).`;

	const out: string[] = [];
	let bytes = 0;
	let shown = 0;
	for (const { n, line } of window) {
		const text = prefix ? `${n}: ${line}` : line;
		const size = Buffer.byteLength(text, "utf8") + 1;
		if (bytes + size > RECALL_MAX_BYTES && out.length > 0) break;
		if (size > RECALL_MAX_BYTES) {
			// A single line over the cap (minified code, base64, …) is cut; leave room for the note.
			const note = `[line ${n} cut at ${RECALL_MAX_BYTES / 1024}KB]`;
			out.push(cutUtf8(text, RECALL_MAX_BYTES - 1 - Buffer.byteLength(note) - 1), note);
			shown++;
			break;
		}
		out.push(text);
		bytes += size;
		shown++;
	}
	const shownEnd = start + shown;
	if (shownEnd < numbered.length) {
		const unit = prefix ? "matching lines" : "lines";
		out.push("", `[Showing ${unit} ${start + 1}–${shownEnd} of ${numbered.length}. Use offset=${shownEnd + 1} to continue.]`);
	}
	return out.join("\n");
}

/**
 * Indexes of the lines matching `pattern`, tested on the first RECALL_MATCH_CHARS characters of
 * each line. Runs in a `node:vm` context with a timeout, which interrupts a runaway regex
 * (e.g. `(a+)+$`) instead of freezing Pi.
 */
function matchingLines(lines: readonly string[], pattern: string): number[] {
	if (pattern.length > RECALL_MAX_PATTERN) throw new Error(`Pattern is longer than ${RECALL_MAX_PATTERN} characters; use a shorter one.`);
	try {
		new RegExp(pattern);
	} catch (err) {
		throw new Error(`Invalid pattern: ${(err as Error).message}`);
	}
	const script = new vm.Script(
		"const re = new RegExp(pattern); const hits = []; " +
			"for (let i = 0; i < lines.length; i++) if (re.test(lines[i].slice(0, maxChars))) hits.push(i); " +
			"hits.join(',')",
	);
	let hits: string;
	try {
		hits = script.runInNewContext({ lines, pattern, maxChars: RECALL_MATCH_CHARS }, { timeout: RECALL_PATTERN_TIMEOUT_MS });
	} catch (err) {
		if ((err as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
			throw new Error(`Pattern took too long (over ${RECALL_PATTERN_TIMEOUT_MS} ms); use a simpler pattern.`);
		}
		throw err;
	}
	return hits ? hits.split(",").map(Number) : [];
}

/** The longest prefix of `text` that fits in `maxBytes` of UTF-8, never splitting a character. */
function cutUtf8(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}
