/**
 * Build the replacement text for a distilled tool result. Kept chunks are copied verbatim;
 * each run of removed chunks becomes one `[… omitted …]` line. The header names the entry id
 * so the model can fetch the original with the `recall` tool.
 */
import type { Chunk } from "./chunk.ts";
import type { Candidate } from "./run.ts";

/** Every replacement starts with this; it also marks results as already distilled. */
export const MARKER = "[context-guard]";

export const formatChars = (chars: number): string =>
	chars >= 1_000_000 ? `${(chars / 1_000_000).toFixed(1)}M` : chars >= 1_000 ? `${(chars / 1_000).toFixed(1)}k` : String(chars);

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Short human label for the tool call, e.g. "bash `rg -n foo src`" or "read src/a.ts". */
export function toolLabel(candidate: Pick<Candidate, "toolName" | "args">): string {
	const args = candidate.args ?? {};
	const pick = (key: string): string | undefined => (typeof args[key] === "string" ? (args[key] as string) : undefined);
	const short = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
	const command = pick("command") ?? pick("cmd");
	if (command) return `${candidate.toolName} \`${short(command.replace(/\s+/g, " ").trim())}\``;
	const path = pick("path") ?? pick("file_path") ?? pick("file");
	if (path) return `${candidate.toolName} ${short(path)}`;
	const pattern = pick("pattern") ?? pick("query");
	if (pattern) return `${candidate.toolName} \`${short(pattern)}\``;
	return candidate.toolName;
}

/** For `read`, map output line indexes to file line numbers using its `offset` argument. */
function lineOffset(candidate: Pick<Candidate, "toolName" | "args">): { base: number; file?: string } {
	if (candidate.toolName !== "read") return { base: 1 };
	const offset = candidate.args?.offset;
	const path = candidate.args?.path;
	return { base: typeof offset === "number" && offset >= 1 ? Math.floor(offset) : 1, file: typeof path === "string" ? path : undefined };
}

function omissionLine(candidate: Pick<Candidate, "toolName" | "args">, removed: readonly Chunk[]): string {
	const first = removed[0];
	const last = removed[removed.length - 1];
	const lines = last.end - first.start;
	const files = [...new Set(removed.flatMap((chunk) => chunk.files))];
	if (files.length > 0) {
		const shown = files.slice(0, 5).join(", ");
		const more = files.length > 5 ? ` and ${files.length - 5} more` : "";
		return `[… ${plural(lines, "line")} omitted: matches in ${shown}${more} …]`;
	}
	const { base, file } = lineOffset(candidate);
	const range = `lines ${first.start + base}–${last.end - 1 + base}`;
	return `[… ${plural(lines, "line")} omitted (${file ? `${range} of ${file}` : `output ${range}`}) …]`;
}

const recallHint = (entryId: string): string => `Full output: recall({"entryId":"${entryId}"}).`;

export interface RenderResult {
	text: string;
	keptLines: number;
	totalLines: number;
}

export function renderReplacement(
	candidate: Pick<Candidate, "entryId" | "toolName" | "args" | "text">,
	chunks: readonly Chunk[],
	keep: ReadonlySet<number>,
): RenderResult {
	const totalLines = chunks.length > 0 ? chunks[chunks.length - 1].end : 0;
	const label = toolLabel(candidate);
	const size = formatChars(candidate.text.length);

	if (keep.size === 0) {
		return {
			text: `${MARKER} Removed the output of ${label}: ${plural(totalLines, "line")} (${size} chars) judged not needed for the answer. ${recallHint(candidate.entryId)}`,
			keptLines: 0,
			totalLines,
		};
	}

	const body: string[] = [];
	let removed: Chunk[] = [];
	let keptLines = 0;
	let keptChars = 0;
	const flush = () => {
		if (removed.length > 0) body.push(omissionLine(candidate, removed));
		removed = [];
	};
	for (const chunk of chunks) {
		if (keep.has(chunk.index)) {
			flush();
			body.push(chunk.text);
			keptLines += chunk.end - chunk.start;
			keptChars += chunk.text.length;
		} else {
			removed.push(chunk);
		}
	}
	flush();

	const header =
		`${MARKER} Distilled the output of ${label}: kept ${keptLines} of ${plural(totalLines, "line")} ` +
		`(${formatChars(keptChars)} of ${size} chars); the rest was judged not needed for the answer. ${recallHint(candidate.entryId)}`;
	return { text: `${header}\n${body.join("\n")}`, keptLines, totalLines };
}
