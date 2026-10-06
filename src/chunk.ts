/**
 * Split a tool output into chunks that Jev judges one by one.
 *
 * - grep-style output (`path:line:text`, `path-line-text`) is grouped by file, so a chunk is
 *   "the matches in one file"; large groups are split, runs of tiny groups are merged.
 * - Anything else is cut into windows of roughly `targetChars`, preferring blank lines.
 *
 * Line numbers are 0-based indexes into `text.split("\n")`; `end` is exclusive.
 */

export interface Chunk {
	/** Position in the output, 0-based. */
	index: number;
	start: number;
	end: number;
	text: string;
	/** Files whose grep matches are in this chunk (grep-style output only). */
	files: string[];
}

export interface ChunkOptions {
	/** Most chunks for the whole output. Chunk size grows to respect it. */
	maxChunks: number;
	/** Smallest target chunk size (characters). */
	minTargetChars: number;
	/** Largest target chunk size (characters). */
	maxTargetChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxChunks: 120, minTargetChars: 800, maxTargetChars: 4_000 };

const MATCH_LINE = /^(?<file>[^\s:][^:\n]*):\d+:/;
const CONTEXT_LINE = /^(?<file>[^\s:][^:\n]*?)-\d+-/;

/**
 * File path of a grep-style line, or undefined. Context separators (`--`) return "".
 * `path:line:` is unambiguous; `path-line-` is not when the path itself contains `-digits-`
 * (e.g. `2024-05-01-post.md`), so context lines prefer the longest of the `knownFiles`.
 */
export function grepFile(line: string, knownFiles?: ReadonlySet<string>): string | undefined {
	if (line === "--") return "";
	const match = MATCH_LINE.exec(line)?.groups?.file;
	if (match) return match;
	let best: string | undefined;
	for (const file of knownFiles ?? []) {
		if ((!best || file.length > best.length) && line.startsWith(file) && /^-\d+-/.test(line.slice(file.length))) best = file;
	}
	return best ?? CONTEXT_LINE.exec(line)?.groups?.file;
}

/** True when at least 60% of the non-empty lines look like `path:line:` / `path-line-` matches. */
export function isGrepLike(lines: readonly string[]): boolean {
	let total = 0;
	let hits = 0;
	for (const line of lines) {
		if (!line.trim() || line === "--") continue;
		total++;
		if (grepFile(line)) hits++;
	}
	return total >= 3 && hits / total >= 0.6;
}

function targetSize(totalChars: number, options: ChunkOptions): number {
	const wanted = Math.ceil(totalChars / Math.max(1, options.maxChunks));
	return Math.min(Math.max(wanted, options.minTargetChars), Math.max(options.maxTargetChars, wanted));
}

/** Cut lines [from, to) into windows of about `target` characters, preferring blank-line breaks. */
function windows(lines: readonly string[], from: number, to: number, target: number): [number, number][] {
	const out: [number, number][] = [];
	let start = from;
	while (start < to) {
		let size = 0;
		let end = start;
		while (end < to && (end === start || size + lines[end].length + 1 <= target)) {
			size += lines[end].length + 1;
			end++;
		}
		if (end < to) {
			// Prefer ending after a blank line within the last 40% of the window.
			for (let k = end; k > start + Math.max(1, Math.floor((end - start) * 0.6)); k--) {
				if (lines[k - 1].trim() === "") {
					end = k;
					break;
				}
			}
		}
		out.push([start, end]);
		start = end;
	}
	return out;
}

function grepGroups(lines: readonly string[]): { start: number; end: number; file: string }[] {
	const groups: { start: number; end: number; file: string }[] = [];
	const known = new Set<string>();
	for (const line of lines) {
		const file = MATCH_LINE.exec(line)?.groups?.file;
		if (file) known.add(file);
	}
	let current: { start: number; end: number; file: string } | undefined;
	for (let i = 0; i < lines.length; i++) {
		const file = grepFile(lines[i], known);
		// Separators, blank lines and non-matching lines stay with the current group.
		if (file && (!current || current.file !== file)) {
			if (current) groups.push(current);
			current = { start: i, end: i + 1, file };
		} else if (current) {
			current.end = i + 1;
		} else {
			current = { start: i, end: i + 1, file: "" };
		}
	}
	if (current) groups.push(current);
	return groups;
}

const charsOf = (lines: readonly string[], start: number, end: number): number => {
	let n = 0;
	for (let i = start; i < end; i++) n += lines[i].length + 1;
	return n;
};

export function chunkOutput(text: string, options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
	const lines = text.split("\n");
	const target = targetSize(text.length, options);
	const ranges: { start: number; end: number; files: string[] }[] = [];

	if (isGrepLike(lines)) {
		let pending: { start: number; end: number; files: string[] } | undefined;
		const flush = () => {
			if (pending) ranges.push(pending);
			pending = undefined;
		};
		for (const group of grepGroups(lines)) {
			const size = charsOf(lines, group.start, group.end);
			const files = group.file ? [group.file] : [];
			if (size > target * 1.5) {
				flush();
				for (const [start, end] of windows(lines, group.start, group.end, target)) ranges.push({ start, end, files });
			} else if (size < target / 4) {
				// Tiny group: merge with neighbouring tiny groups up to half the target size.
				if (pending && charsOf(lines, pending.start, group.end) <= target / 2) {
					pending.end = group.end;
					pending.files.push(...files);
				} else {
					flush();
					pending = { start: group.start, end: group.end, files: [...files] };
				}
			} else {
				flush();
				ranges.push({ start: group.start, end: group.end, files });
			}
		}
		flush();
	} else {
		for (const [start, end] of windows(lines, 0, lines.length, target)) ranges.push({ start, end, files: [] });
	}

	return ranges.map((range, index) => ({
		index,
		start: range.start,
		end: range.end,
		text: lines.slice(range.start, range.end).join("\n"),
		files: [...new Set(range.files)],
	}));
}

/** Group consecutive chunks into Jev requests that respect both size limits. */
export function segmentChunks(chunks: readonly Chunk[], maxChars: number, maxChunks: number): Chunk[][] {
	const segments: Chunk[][] = [];
	let current: Chunk[] = [];
	let size = 0;
	for (const chunk of chunks) {
		const length = chunk.text.length + 1;
		if (current.length > 0 && (size + length > maxChars || current.length >= maxChunks)) {
			segments.push(current);
			current = [];
			size = 0;
		}
		current.push(chunk);
		size += length;
	}
	if (current.length > 0) segments.push(current);
	return segments;
}
