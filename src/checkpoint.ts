/**
 * Mid-run checkpoints (docs/DESIGN.md → Mid-run checkpoints).
 *
 * At the end of a turn that will be followed by another one, tool results of the current run
 * that are at least `midRunMinAgeTurns` turns old and were not judged before are "eligible".
 * When their total size reaches the batch size, all of them are judged in one checkpoint.
 * Each output is judged mid-run at most once (outputs Jev never answered for are asked again).
 *
 * All state is derived from what is persisted on the active branch (our records, the context_edit
 * entries), never kept in memory: a boundary's drafts can be replaced by a later handler or rejected
 * as a whole, and /tree or compaction change the branch.
 */
import { toolLabel } from "./render.ts";
import { type Candidate, type CollectOptions, candidateOf, collectHistory, findRunStart, indexSpan, questionAt, type RunHistory, type ToolCallInfo } from "./run.ts";
import type { ProjectedEntryLike } from "./types.ts";

export interface CheckpointOptions extends CollectOptions {
	midRunMinAgeTurns: number;
}

export interface CheckpointCandidate extends Candidate {
	toolCallId?: string;
	/** Turn (0-based assistant message index in the run) of the call that produced the output. */
	turn: number;
	/** Labels of the tool calls made after this output, oldest first (see `laterCallsFor`). */
	laterCalls: string[];
	/** Why the output is probably out of date, e.g. "this file was edited after this read (…)". */
	superseded?: string;
}

export interface CheckpointInfo {
	question: string;
	history: RunHistory;
	/** The latest assistant text of the run (the agent's current progress note). */
	latest: string;
	/** Earlier assistant text of the run, oldest first. */
	notes: string;
	currentTurn: number;
	/** Eligible, not yet judged outputs. */
	candidates: CheckpointCandidate[];
	/** Total characters of `candidates`. */
	pendingChars: number;
}

export const LATER_CALLS_LIMIT = 30;

/** Normalize a shell command for "ran again" detection. */
export const normalizeCommand = (command: string): string => command.replace(/\s+/g, " ").replace(/\s*2>&1\s*$/, "").trim();
const normalizePath = (path: string): string => path.replace(/^\.\//, "").replace(/\/+/g, "/");

const str = (args: Record<string, unknown> | undefined, ...keys: string[]): string | undefined => {
	for (const key of keys) if (typeof args?.[key] === "string") return args[key] as string;
	return undefined;
};
const pathOf = (args: Record<string, unknown> | undefined) => {
	const path = str(args, "path", "file_path", "file");
	return path === undefined ? undefined : normalizePath(path);
};
const commandOf = (args: Record<string, unknown> | undefined) => {
	const command = str(args, "command", "cmd");
	return command === undefined ? undefined : normalizeCommand(command);
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Why an output is probably out of date: the file it read was edited or written later, the same
 * file range was read again, or the same command (or the same search) ran again.
 */
export function supersededBy(candidate: Pick<CheckpointCandidate, "toolName" | "args" | "turn">, later: readonly ToolCallInfo[]): string | undefined {
	const path = pathOf(candidate.args);
	const command = commandOf(candidate.args);
	const offset = Number(candidate.args?.offset ?? 1) || 1;
	const limit = candidate.args?.limit;
	for (const call of later) {
		if (call.turn <= candidate.turn) continue;
		const when = `${plural(call.turn - candidate.turn, "turn")} later`;
		const label = toolLabel({ toolName: call.name, args: call.args });
		if (candidate.toolName === "read" && path) {
			const callPath = pathOf(call.args);
			if ((call.name === "edit" || call.name === "write") && callPath === path) return `this file was changed after this read (${label}, ${when})`;
			if (call.name === "read" && callPath === path && (Number(call.args?.offset ?? 1) || 1) === offset && call.args?.limit === limit) {
				return `the same file range was read again later (${label}, ${when})`;
			}
		} else if (command && commandOf(call.args) === command) {
			return `the same command ran again later (${when})`;
		} else if (!command && call.name === candidate.toolName && JSON.stringify(call.args ?? {}) === JSON.stringify(candidate.args ?? {})) {
			return `the same ${call.name} call ran again later (${when})`;
		}
	}
	return undefined;
}

/** Labels of the calls after `turn`; above the limit, the first and last halves with a gap note. */
export function laterCallsFor(turn: number, calls: readonly ToolCallInfo[], limit = LATER_CALLS_LIMIT): string[] {
	const labels = calls.filter((call) => call.turn > turn).map((call) => toolLabel({ toolName: call.name, args: call.args }));
	if (labels.length <= limit) return labels;
	const head = Math.floor(limit / 2);
	const tail = limit - head;
	return [...labels.slice(0, head), `[… ${labels.length - limit} more calls …]`, ...labels.slice(-tail)];
}

/**
 * Eligible outputs for a checkpoint at the end of the current turn. `judged`: entry ids already
 * judged mid-run (the memo). Returns undefined outside a run.
 */
export function collectCheckpoint(entries: readonly ProjectedEntryLike[], options: CheckpointOptions, judged: ReadonlySet<string>): CheckpointInfo | undefined {
	const start = findRunStart(entries);
	if (start < 0) return undefined;
	const span = entries.slice(start + 1);
	const { toolCalls, assistantTexts, turns } = indexSpan(span);
	const currentTurn = turns - 1;
	const calls = [...toolCalls.values()];
	const youngest = currentTurn - options.midRunMinAgeTurns;

	const candidates: CheckpointCandidate[] = [];
	for (const entry of span) {
		const candidate = candidateOf(entry, toolCalls, options);
		if (!candidate || candidate.turn === undefined || judged.has(candidate.entryId)) continue;
		if (candidate.turn > youngest) continue;
		const turn = candidate.turn;
		const superseded = supersededBy({ toolName: candidate.toolName, args: candidate.args, turn }, calls);
		candidates.push({ ...candidate, turn, laterCalls: laterCallsFor(turn, calls), ...(superseded ? { superseded } : {}) });
	}

	const latest = assistantTexts.at(-1)?.text ?? "";
	return {
		question: questionAt(entries, start),
		history: collectHistory(entries.slice(0, start), options.historyExchanges),
		latest,
		notes: assistantTexts
			.slice(0, -1)
			.map((t) => t.text)
			.join("\n\n"),
		currentTurn,
		candidates,
		pendingChars: candidates.reduce((sum, c) => sum + c.text.length, 0),
	};
}

/**
 * Break-even rule (docs/CACHE.md → Mid-run checkpoints). A checkpoint makes the next request pay
 * the full input price (OpenAI) or the cache-write price (Anthropic) once for the context it can no
 * longer read from cache, and saves the removed characters (about 70% of the judged ones) at the
 * cache-read price on every later request. Assuming the run goes on for about as many turns as it
 * has had so far, it pays off when
 *   pendingChars × 0.7 × read × turnsSoFar ≥ (uncached − read) × rewriteChars,
 * i.e. pendingChars × turnsSoFar ≥ factor × rewriteChars, with
 *   OpenAI Codex: input 10× cached → factor 0.9 / (0.1 × 0.7) ≈ 13, rewrite = the whole context
 *     (measured: the first request after an edit reads 0–2,560 tokens, wherever the edit is);
 *   Anthropic:    write 1.25× vs read 0.1× of input → factor 1.15 / (0.1 × 0.7) ≈ 16, rewrite =
 *     everything after the first edited output (the read point keeps the prefix).
 */
export const BREAK_EVEN_FACTOR = { full: 13, prefix: 16 } as const;

export function paysOff(pendingChars: number, turnsSoFar: number, rewriteChars: number, factor: number): boolean {
	return pendingChars * Math.max(1, turnsSoFar) >= factor * rewriteChars;
}

/** Characters of model-visible text in the projected context (an estimate of its size). */
export function contextChars(entries: readonly ProjectedEntryLike[]): number {
	let n = 0;
	for (const entry of entries) {
		for (const message of entry.messages) {
			if (typeof message.summary === "string") n += message.summary.length;
			if (typeof message.content === "string") n += message.content.length;
			else for (const block of message.content ?? []) n += typeof block.text === "string" ? block.text.length : JSON.stringify(block).length;
		}
	}
	return n;
}

/** Characters from the first of `entryIds` to the end: what a checkpoint makes the cache rewrite. */
export function charsFrom(entries: readonly ProjectedEntryLike[], entryIds: ReadonlySet<string>): number {
	const first = entries.findIndex((entry) => entryIds.has(entry.sourceEntry.id));
	return first < 0 ? 0 : contextChars(entries.slice(first));
}

/** Recent notes, clipped from the start so the latest ones survive. */
export function recentNotes(notes: string, max: number): string {
	if (notes.length <= max) return notes;
	return `[…]\n${notes.slice(notes.length - max + 4)}`;
}

export type BranchEntry = {
	type?: string;
	id?: string;
	customType?: string;
	data?: unknown;
	targetId?: string;
	message?: { role?: string; stopReason?: string; toolCallId?: string };
};

const isAnswered = (entry: BranchEntry): boolean =>
	entry.type === "message" && entry.message?.role === "assistant" && entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted";

/**
 * Targets of the context edits that no model request has seen yet: the `context_edit` entries after
 * the last assistant message on the branch (a failed or aborted response does not count, since the
 * retry repeats the request). Cache-warming replays append no assistant message, so this stays the
 * same until a real request after the edits has been answered.
 */
export function pendingEdits(branch: readonly BranchEntry[]): Set<string> {
	const targets = new Set<string>();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (isAnswered(entry)) break;
		if (entry.type === "context_edit" && typeof entry.targetId === "string") targets.add(entry.targetId);
	}
	return targets;
}

/** A cache entry this process wrote: a breakpoint it saw in a request it sent (see `cacheAnchors`). */
export interface WrittenEntry {
	/** Session entry id of the tool result that ended the prefix. */
	entryId: string;
	/** `provider/id` of the model the request went to. */
	model: string;
	/** When the request was sent (ms). */
	time: number;
	/** Id of the last branch entry when the request was sent. */
	leafId: string;
}

/** Anthropic's default cache TTL. */
export const CACHE_TTL_MS = 5 * 60_000;

export interface CacheAnchors {
	/** Tool call id to read up to: an entry this process wrote, still valid, before the first edit. */
	read?: string;
	/** Tool call id that ends the first edited tool-result batch (writes an entry with the new content). */
	write?: string;
}

/**
 * Anthropic anchors for the request about to be sent. Only with pending edits (see `pendingEdits`);
 * the previous-question pin is always placed too and is the floor.
 *
 * - `read`: the latest entry in `log` (breakpoints this process saw in requests it sent) that the same
 *   model wrote within the TTL, that is still on the branch, that ends with a tool result before the
 *   first edited entry, and whose prefix nothing has touched since: no `context_edit` at or before it
 *   and no compaction or branch summary on the branch after the request that wrote it.
 * - `write`: the end of the tool-result batch holding the first edited entry, so that prefix gets an entry.
 */
/** Branch index of every entry id. */
const positionsOf = (branch: readonly BranchEntry[]): Map<string, number> => {
	const position = new Map<string, number>();
	branch.forEach((entry, i) => {
		if (entry.id) position.set(entry.id, i);
	});
	return position;
};

/**
 * True when a logged entry's prefix is still what was cached: the entry and the leaf at write time are on
 * the branch, and since then no `context_edit` touched anything at or before the entry and no compaction or
 * branch summary was appended.
 */
function unchangedSince(branch: readonly BranchEntry[], position: ReadonlyMap<string, number>, w: WrittenEntry): boolean {
	const pos = position.get(w.entryId);
	const since = position.get(w.leafId);
	if (pos === undefined || since === undefined) return false;
	for (let j = since + 1; j < branch.length; j++) {
		const e = branch[j];
		if (e.type === "compaction" || e.type === "branch_summary") return false;
		if (e.type === "context_edit" && (position.get(e.targetId ?? "") ?? -1) <= pos) return false;
	}
	return true;
}

/**
 * The latest trusted cache entry that ends with a tool result before branch index `before`: written (or
 * refreshed) by the same model within the TTL, with its prefix unchanged since. Returns its entry.
 */
export function trustedReadPoint(branch: readonly BranchEntry[], log: readonly WrittenEntry[], model: string, now: number, before: number, ttlMs = CACHE_TTL_MS): BranchEntry | undefined {
	const position = positionsOf(branch);
	let read: BranchEntry | undefined;
	let readPos = -1;
	for (const w of log) {
		if (w.model !== model || now - w.time > ttlMs) continue;
		const pos = position.get(w.entryId);
		if (pos === undefined || pos >= before || pos <= readPos) continue;
		if (branch[pos].message?.role !== "toolResult" || !unchangedSince(branch, position, w)) continue;
		read = branch[pos];
		readPos = pos;
	}
	return read;
}

export function cacheAnchors(branch: readonly BranchEntry[], log: readonly WrittenEntry[], model: string, now: number, ttlMs = CACHE_TTL_MS): CacheAnchors {
	const pending = pendingEdits(branch);
	if (pending.size === 0) return {};
	const position = positionsOf(branch);
	let first = Number.POSITIVE_INFINITY;
	for (const id of pending) first = Math.min(first, position.get(id) ?? Number.POSITIVE_INFINITY);
	if (!Number.isFinite(first)) return {};
	const read = trustedReadPoint(branch, log, model, now, first, ttlMs);

	let write: BranchEntry | undefined;
	if (branch[first]?.message?.role === "toolResult") {
		let end = first;
		for (let j = first + 1; j < branch.length; j++) {
			const e = branch[j];
			if (e.type !== "message") continue;
			if (e.message?.role !== "toolResult") break;
			end = j;
		}
		write = branch[end];
	}
	return {
		...(read?.message?.toolCallId ? { read: read.message.toolCallId } : {}),
		...(write?.message?.toolCallId ? { write: write.message.toolCallId } : {}),
	};
}

/**
 * Characters per token assumed when checking that a cache read went through an entry. Code and logs run
 * at about 2.3 characters per token and prose at about 4 (docs/JEV.md), so dividing by 1.5 overestimates
 * the tokens of the prefix: a refresh needs a read clearly beyond the entry.
 */
export const REFRESH_CHARS_PER_TOKEN = 1.5;

/**
 * Refresh logged entries that a request read through (docs/CACHE.md: reading a longer prefix keeps the
 * entries on its path alive). For the response to the request sent at `requestTime` to `model` with
 * `cacheRead` tokens read: every entry of the same model whose prefix is unchanged and lies within the
 * part that was read gets `time = requestTime`. "Within" is conservative: cacheRead must reach `baseline`
 * (the system prompt, tools and question: the full input of the run's first request) plus the projected
 * characters from the question to the entry divided by REFRESH_CHARS_PER_TOKEN. Returns the refreshed ids.
 */
export function refreshOnReadThrough(
	projection: readonly ProjectedEntryLike[],
	branch: readonly BranchEntry[],
	log: WrittenEntry[],
	model: string,
	requestTime: number,
	cacheRead: number,
	baseline: number,
): string[] {
	if (!(cacheRead > 0) || !(baseline > 0) || cacheRead <= baseline) return [];
	const start = findRunStart(projection);
	if (start < 0) return [];
	const position = positionsOf(branch);
	const refreshed: string[] = [];
	for (const w of log) {
		if (w.model !== model || w.time >= requestTime || !unchangedSince(branch, position, w)) continue;
		const index = projection.findIndex((entry) => entry.sourceEntry.id === w.entryId);
		if (index <= start) continue;
		const prefixTokens = baseline + contextChars(projection.slice(start + 1, index + 1)) / REFRESH_CHARS_PER_TOKEN;
		if (cacheRead < prefixTokens) continue;
		w.time = requestTime;
		refreshed.push(w.entryId);
	}
	return refreshed;
}

/**
 * Full input tokens (input + cacheRead + cacheWrite) of the first answered request after the run's user
 * message: the system prompt, tools and question. Undefined until that response is on the branch.
 */
export function runBaseline(branch: readonly (BranchEntry & { message?: { usage?: { input?: number; cacheRead?: number; cacheWrite?: number } } })[]): number | undefined {
	let start = branch.length - 1;
	while (start >= 0 && !(branch[start].type === "message" && branch[start].message?.role === "user")) start--;
	if (start < 0) return undefined;
	for (let i = start + 1; i < branch.length; i++) {
		const m = branch[i];
		if (m.type === "message" && m.message?.role === "assistant") {
			const u = m.message.usage;
			return u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : undefined;
		}
	}
	return undefined;
}

/**
 * Characters an Anthropic request after a checkpoint would write to the cache again: everything after
 * the read point it would get (the latest trusted entry before the first of `candidateIds`, as
 * `cacheAnchors` would pick it), or, without one, everything after the run's question (the question pin
 * is the floor).
 */
export function anthropicRewriteChars(
	projection: readonly ProjectedEntryLike[],
	branch: readonly BranchEntry[],
	log: readonly WrittenEntry[],
	model: string,
	now: number,
	candidateIds: ReadonlySet<string>,
): number {
	const position = positionsOf(branch);
	let first = Number.POSITIVE_INFINITY;
	for (const id of candidateIds) first = Math.min(first, position.get(id) ?? Number.POSITIVE_INFINITY);
	const read = Number.isFinite(first) ? trustedReadPoint(branch, log, model, now, first) : undefined;
	const readIndex = read ? projection.findIndex((entry) => entry.sourceEntry.id === read.id) : -1;
	if (readIndex >= 0) return contextChars(projection.slice(readIndex + 1));
	// The question pin can be read only if every edit comes after it (an omitted old exchange comes before).
	const runStart = findRunStart(projection);
	const earliest = projection.findIndex((entry) => candidateIds.has(entry.sourceEntry.id));
	const from = earliest >= 0 && earliest <= runStart ? 0 : runStart + 1;
	return contextChars(projection.slice(Math.max(0, from)));
}

/** A result counts as judged unless Jev never answered for it (timeout, error): those are asked again. */
export const wasJudged = (result: { reason?: string }): boolean => !/timeout|error|aborted/.test(result.reason ?? "");

/** The memo: entry ids judged at a mid-run checkpoint, from our records persisted on the branch. */
export function memoFromBranch(branch: readonly BranchEntry[], customType: string): Set<string> {
	const judged = new Set<string>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== customType) continue;
		const data = entry.data as { v?: number; phase?: string; results?: { entryId?: string; reason?: string; kind?: string }[] } | undefined;
		if (data?.v !== 1 || data.phase !== "mid-run") continue;
		for (const result of data.results ?? []) {
			if (typeof result.entryId === "string" && result.kind !== "exchange" && wasJudged(result)) judged.add(result.entryId);
		}
	}
	return judged;
}

/**
 * Old exchanges judged during the current run (records of any phase after the last user message on the
 * branch). An exchange is judged again in a later run, against that run's work.
 */
export function exchangeMemo(branch: readonly BranchEntry[], customType: string): Set<string> {
	let start = branch.length - 1;
	while (start >= 0 && !(branch[start].type === "message" && branch[start].message?.role === "user")) start--;
	const judged = new Set<string>();
	for (const entry of branch.slice(start + 1)) {
		if (entry.type !== "custom" || entry.customType !== customType) continue;
		const data = entry.data as { v?: number; results?: { entryId?: string; reason?: string; kind?: string }[] } | undefined;
		if (data?.v !== 1) continue;
		for (const result of data.results ?? []) {
			// A deferred omission (break-even) stays eligible: the exchange is judged again at a later pass.
			if (result.kind === "exchange" && typeof result.entryId === "string" && wasJudged(result) && result.reason !== "deferred") judged.add(result.entryId);
		}
	}
	return judged;
}
