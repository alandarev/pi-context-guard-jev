/**
 * Find the run that just finished and its candidate tool results (see docs/DESIGN.md).
 */
import { MARKER } from "./render.ts";
import { clip, isTextOnly, type MessageLike, type ProjectedEntryLike, textOf } from "./types.ts";

export interface Candidate {
	/** Session entry id of the tool-result message. */
	entryId: string;
	toolName: string;
	/** Arguments of the matching tool call, when found in the run. */
	args: Record<string, unknown> | undefined;
	/** Model-visible text (after earlier context edits). */
	text: string;
	/** The tool reported an error (e.g. a command that exited non-zero). */
	isError?: boolean;
}

export interface RunInfo {
	question: string;
	answer: string;
	/** Earlier assistant text of the run (reasoning notes), oldest first. */
	notes: string;
	candidates: Candidate[];
	/** Number of tool results in the run, including ones that are not candidates. */
	toolResults: number;
	/** Conversation before the run, so Jev can judge relevance against the ongoing work. */
	history?: RunHistory;
}

/** One earlier exchange: a user prompt and the last assistant text before the next prompt. */
export interface Exchange {
	user: string;
	/** Empty when the assistant wrote no text (e.g. only tool calls, or an aborted run). */
	assistant: string;
}

export interface RunHistory {
	/** Latest compaction or branch summary before the run. */
	summary?: string;
	/** The first user prompt of the projected session, when not already in `exchanges`. */
	firstRequest?: string;
	/** The last `historyExchanges` exchanges before the run, oldest first. */
	exchanges: Exchange[];
}

export interface CollectOptions {
	minResultChars: number;
	excludeTools: readonly string[];
	/** Include error results (failing commands). Default false. */
	distillErrors?: boolean;
	/** Earlier exchanges to include in `history`; 0 = no history at all. */
	historyExchanges: number;
}

export const HISTORY_SUMMARY_LIMIT = 2_000;
export const HISTORY_USER_LIMIT = 800;
export const HISTORY_ASSISTANT_LIMIT = 1_200;
export const HISTORY_FIRST_REQUEST_LIMIT = 1_000;

/** Question text used when the prompt that started the run has no text (e.g. only an image). */
export const NO_TEXT_QUESTION = "[the user sent only an image]";

/**
 * The run starts after the last user message, with or without text. Steering messages sent
 * during a run are user messages too, so they start a new span; tool results before them are
 * left for later (they stay unpruned, which is the safe direction).
 */
/** Index of the entry holding the user message that starts the current run, or -1. */
export function findRunStart(entries: readonly ProjectedEntryLike[]): number {
	let start = entries.length - 1;
	while (start >= 0 && !entries[start].messages.some((m) => m.role === "user")) start--;
	return start;
}

/** The run's question: the text of the user message at `start`. */
export function questionAt(entries: readonly ProjectedEntryLike[], start: number): string {
	const questionMessage = entries[start].messages.findLast((m) => m.role === "user");
	const questionText = questionMessage ? textOf(questionMessage).trim() : "";
	return questionText ? textOf(questionMessage as MessageLike) : NO_TEXT_QUESTION;
}

export interface ToolCallInfo {
	name: string;
	args: Record<string, unknown> | undefined;
	/** 0-based index of the assistant message (turn) in the run that made the call. */
	turn: number;
}

/** Tool calls of a run span by id, and the assistant texts in order (with their turn). */
export function indexSpan(span: readonly ProjectedEntryLike[]): { toolCalls: Map<string, ToolCallInfo>; assistantTexts: { turn: number; text: string }[]; turns: number } {
	const toolCalls = new Map<string, ToolCallInfo>();
	const assistantTexts: { turn: number; text: string }[] = [];
	let turn = -1;
	for (const entry of span) {
		for (const message of entry.messages) {
			if (message.role !== "assistant") continue;
			turn++;
			if (typeof message.content === "string") continue;
			const text = textOf(message).trim();
			if (text) assistantTexts.push({ turn, text });
			for (const block of message.content) {
				if (block.type === "toolCall" && typeof block.id === "string") {
					const args = block.arguments && typeof block.arguments === "object" ? (block.arguments as Record<string, unknown>) : undefined;
					toolCalls.set(block.id, { name: String(block.name ?? ""), args, turn });
				}
			}
		}
	}
	return { toolCalls, assistantTexts, turns: turn + 1 };
}

/** The candidate rules (see docs/DESIGN.md → Candidates) for one projected entry, or undefined. */
export function candidateOf(
	entry: ProjectedEntryLike,
	toolCalls: ReadonlyMap<string, ToolCallInfo>,
	options: CollectOptions,
): (Candidate & { toolCallId?: string; turn?: number }) | undefined {
	const message = entry.messages[0];
	if (entry.messages.length !== 1 || message?.role !== "toolResult") return undefined;
	if ((message.isError && !options.distillErrors) || !isTextOnly(message)) return undefined;
	const call = message.toolCallId ? toolCalls.get(message.toolCallId) : undefined;
	const toolName = message.toolName ?? call?.name ?? "tool";
	if (options.excludeTools.includes(toolName)) return undefined;
	const text = textOf(message);
	if (text.length < options.minResultChars || text.startsWith(MARKER)) return undefined;
	// Another extension already edited this result: recall returns the raw entry, so whatever
	// that edit added could not be recovered after distillation. Leave it alone.
	const raw = entry.sourceEntry.message;
	if (raw && textOf(raw) !== text) return undefined;
	return {
		entryId: entry.sourceEntry.id,
		toolName,
		args: call?.args,
		text,
		...(message.isError ? { isError: true } : {}),
		toolCallId: message.toolCallId,
		turn: call?.turn,
	};
}

/**
 * The run starts after the last user message, with or without text. Steering messages sent
 * during a run are user messages too, so they start a new span; tool results before them are
 * left for later (they stay unpruned, which is the safe direction).
 *
 * `skip`: entry ids not to collect.
 */
export function collectRun(entries: readonly ProjectedEntryLike[], options: CollectOptions, skip?: ReadonlySet<string>): RunInfo | undefined {
	const start = findRunStart(entries);
	if (start < 0) return undefined;
	const question = questionAt(entries, start);
	const span = entries.slice(start + 1);
	const { toolCalls, assistantTexts } = indexSpan(span);
	const answer = assistantTexts.at(-1)?.text ?? "";
	const notes = assistantTexts.slice(0, -1).map((t) => t.text).join("\n\n");

	const candidates: Candidate[] = [];
	let toolResults = 0;
	for (const entry of span) {
		if (entry.messages.length === 1 && entry.messages[0]?.role === "toolResult") toolResults++;
		const candidate = candidateOf(entry, toolCalls, options);
		if (!candidate || skip?.has(candidate.entryId)) continue;
		const { toolCallId: _id, turn: _turn, ...plain } = candidate;
		candidates.push(plain);
	}
	const history = collectHistory(entries.slice(0, start), options.historyExchanges);
	return { question, answer, notes, candidates, toolResults, history };
}

export const hasHistory = (history: RunHistory | undefined): history is RunHistory =>
	Boolean(history && (history.summary || history.firstRequest || history.exchanges.length > 0));

/**
 * Earlier conversation from the projected entries before the run's boundary user message.
 * Tool calls and tool results are left out; every user message (steering included) starts a
 * new exchange, whose assistant part is the last assistant text before the next user message.
 */
export function collectHistory(before: readonly ProjectedEntryLike[], count: number): RunHistory {
	if (count <= 0) return { exchanges: [] };
	let summary: string | undefined;
	const all: { user: string; assistant: string; hasText: boolean }[] = [];
	for (const entry of before) {
		for (const message of entry.messages) {
			if ((message.role === "compactionSummary" || message.role === "branchSummary") && typeof message.summary === "string") {
				if (message.summary.trim()) summary = message.summary;
			} else if (message.role === "user") {
				const text = textOf(message).trim();
				all.push({ user: text || NO_TEXT_QUESTION, assistant: "", hasText: Boolean(text) });
			} else if (message.role === "assistant" && all.length > 0) {
				const text = textOf(message).trim();
				if (text) all[all.length - 1].assistant = text;
			}
		}
	}
	const included = all.slice(-count);
	const history: RunHistory = {
		exchanges: included.map((exchange) => ({
			user: clip(exchange.user, HISTORY_USER_LIMIT),
			assistant: clip(exchange.assistant, HISTORY_ASSISTANT_LIMIT),
		})),
	};
	if (summary) history.summary = clip(summary, HISTORY_SUMMARY_LIMIT);
	// The current question is not in `before`, so the first prompt here is never the question.
	const first = all[0];
	if (first && all.length > included.length && first.hasText) history.firstRequest = clip(first.user, HISTORY_FIRST_REQUEST_LIMIT);
	return history;
}
