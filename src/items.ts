/**
 * Whole-item judgments (docs/DESIGN.md → Small outputs, Old exchanges): small tool outputs and old
 * exchanges are judged as whole items, many per Jev request, requests in parallel. A dropped small
 * output becomes a one-line stub; an omitted exchange keeps a stub on its user prompt and omits every
 * other entry (`replacement: null`).
 */
import { MARKER, RECALL_TOOL, formatChars, toolLabel } from "./render.ts";
import { supersededBy } from "./checkpoint.ts";
import { contentChars } from "./size.ts";
import { type Candidate, type CollectOptions, candidateOf, indexSpan, isSteering, type RunHistory } from "./run.ts";
import {
	type ClassifierQuestion,
	type ClassifierRequest,
	type ClassifyFn,
	clip,
	type ContextEditDraft,
	type OmitDraft,
	type ProjectedEntryLike,
	textOf,
} from "./types.ts";

export type ItemKind = "large" | "small" | "exchange" | "image";

// ---------------------------------------------------------------------------------------------
// Small outputs
// ---------------------------------------------------------------------------------------------

export interface SmallItem extends Candidate {
	/** Turn (0-based assistant message index in the run) of the call that produced the output. */
	turn: number;
	/** Why the output is probably out of date (see checkpoint.ts → supersededBy). */
	superseded?: string;
}

export interface SmallOptions extends CollectOptions {
	smallResultMinChars: number;
}

/**
 * Tool results of the run span `span` (entries after the run's user message) between
 * `smallResultMinChars` and `minResultChars`, under the same candidate rules as large outputs. With
 * `youngest`, only outputs whose call was made in a turn ≤ youngest (the mid-run age rule), and no
 * recall outputs.
 */
export function collectSmall(span: readonly ProjectedEntryLike[], options: SmallOptions, judged: ReadonlySet<string>, youngest = Number.POSITIVE_INFINITY): SmallItem[] {
	const { toolCalls } = indexSpan(span);
	const calls = [...toolCalls.values()];
	const items: SmallItem[] = [];
	for (const entry of span) {
		const candidate = candidateOf(entry, toolCalls, { ...options, minResultChars: options.smallResultMinChars });
		if (!candidate || candidate.text.length >= options.minResultChars || judged.has(candidate.entryId)) continue;
		const turn = candidate.turn ?? 0;
		if (turn > youngest) continue;
		// Mid-run (`youngest` given): recall outputs are left alone, see checkpoint.ts → collectCheckpoint.
		if (Number.isFinite(youngest) && candidate.toolName === RECALL_TOOL) continue;
		const { toolCallId: _id, turn: _turn, ...plain } = candidate;
		// Skip outputs whose stub would not be shorter.
		if (smallStub(plain).length >= plain.text.length) continue;
		const superseded = supersededBy({ toolName: plain.toolName, args: plain.args, turn }, calls);
		items.push({ ...plain, turn, ...(superseded ? { superseded } : {}) });
	}
	return items;
}

export const smallStub = (item: Pick<Candidate, "entryId" | "toolName" | "args" | "text">): string =>
	`${MARKER} Omitted the output of ${toolLabel(item)} (${formatChars(item.text.length)} chars): judged no longer needed. Full output: recall({"entryId":"${item.entryId}"}).`;

// ---------------------------------------------------------------------------------------------
// Old exchanges
// ---------------------------------------------------------------------------------------------

export interface ExchangeItem {
	/** Session entry id of the user prompt that starts the exchange (the stub goes here). */
	entryId: string;
	/** Every other editable entry of the exchange (they get `replacement: null`). */
	omitIds: string[];
	prompt: string;
	/** The last assistant text of the exchange. */
	answer: string;
	/** toolLabel()s of the tool calls, in order. */
	toolCalls: string[];
	/** Model-visible characters of the exchange's editable entries (what the omission removes). */
	chars: number;
	/** Messages in the exchange. */
	messages: number;
}

export const EXCHANGE_STUB_PREFIX = `${MARKER} Omitted an earlier exchange`;

/** Editable entries per Pi's context_edit rules (user, assistant, tool result, custom message). */
const isEditable = (entry: ProjectedEntryLike): boolean => {
	if (entry.sourceEntry.type === "custom_message") return true;
	if (entry.sourceEntry.type !== "message") return false;
	const role = entry.messages[0]?.role;
	return role === "user" || role === "assistant" || role === "toolResult";
};

const entryChars = (entry: ProjectedEntryLike): number => entry.messages.reduce((n, m) => n + contentChars(m.content), 0);

/** Exchanges smaller than this (model-visible characters) are never judged: the saving is not worth an edit. */
export const EXCHANGE_MIN_CHARS = 2_000;

/**
 * True when the model sees something other than the raw entry and the difference is not ours: another
 * extension (or Pi's overflow recovery) replaced or omitted it. `recall` returns raw entries, so whatever
 * that edit put in place could not be recovered after the exchange is omitted.
 */
const editedByOthers = (entry: ProjectedEntryLike): boolean => {
	const raw = entry.sourceEntry.message;
	if (!raw) return false;
	if (entry.messages.length === 0) return true;
	const projected = entry.messages[0];
	if (projected === raw) return false;
	const text = textOf(projected);
	return !text.startsWith(MARKER) && (text !== textOf(raw) || JSON.stringify(projected.content) !== JSON.stringify(raw.content));
};

/**
 * Old exchanges: from each user prompt up to the next one, before the current run's user message at
 * `runStart`, without the last `keepRecent` exchanges. Only exchanges that completed (their last
 * assistant message has no tool calls), that are not already omitted, and that were not judged in this
 * run (`judged`, user entry ids). Compaction and branch summaries are never part of an exchange (they
 * come before the first user message, or are not editable and stay in place).
 */
export function collectExchanges(entries: readonly ProjectedEntryLike[], runStart: number, keepRecent: number, judged: ReadonlySet<string>): ExchangeItem[] {
	const starts: number[] = [];
	// Steering messages belong to the exchange they were sent in.
	for (let i = 0; i < runStart; i++) if (entries[i].messages.some((m) => m.role === "user") && !isSteering(entries, i)) starts.push(i);
	const exchanges: ExchangeItem[] = [];
	starts.slice(0, Math.max(0, starts.length - keepRecent)).forEach((start, k) => {
		const end = k + 1 < starts.length ? starts[k + 1] : runStart;
		const span = entries.slice(start, end);
		const user = span[0];
		if (!isEditable(user) || judged.has(user.sourceEntry.id)) return;
		const promptText = textOf(user.messages[0]);
		if (promptText.startsWith(MARKER)) return; // already omitted
		// Recoverability: recall returns raw entries (with their images, see recall.ts), so no foreign edits.
		if (span.some(editedByOthers)) return;
		const assistants = span.filter((e) => e.messages[0]?.role === "assistant");
		const lastAssistant = assistants.at(-1)?.messages[0];
		if (!lastAssistant || (Array.isArray(lastAssistant.content) && lastAssistant.content.some((b) => b.type === "toolCall"))) return;
		const toolCalls: string[] = [];
		for (const a of assistants) {
			const content = a.messages[0].content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (block.type === "toolCall") toolCalls.push(toolLabel({ toolName: String(block.name ?? "tool"), args: block.arguments as Record<string, unknown> | undefined }));
			}
		}
		const answer = [...assistants].reverse().map((a) => textOf(a.messages[0]).trim()).find(Boolean) ?? "";
		const editable = span.filter(isEditable);
		const item: ExchangeItem = {
			entryId: user.sourceEntry.id,
			omitIds: editable.slice(1).map((e) => e.sourceEntry.id),
			prompt: promptText,
			answer,
			toolCalls,
			chars: editable.reduce((n, e) => n + entryChars(e), 0),
			messages: span.reduce((n, e) => n + e.messages.length, 0),
		};
		// Net saving: the stub must be clearly shorter than what it replaces.
		if (item.chars < EXCHANGE_MIN_CHARS || exchangeStub(item).length >= item.chars) return;
		exchanges.push(item);
	});
	return exchanges;
}

export function exchangeStub(item: Pick<ExchangeItem, "entryId" | "prompt" | "messages" | "chars">): string {
	const prompt = item.prompt.replace(/\s+/g, " ").trim();
	const short = prompt.length > 120 ? `${prompt.slice(0, 119)}…` : prompt;
	const tokens = formatChars(Math.round(item.chars / 4));
	return `${EXCHANGE_STUB_PREFIX} judged unrelated to the current work: "${short}" (${item.messages} messages, ~${tokens} tokens). Full exchange: recall({"entryId":"${item.entryId}"}).`;
}

export function exchangeEdits(item: ExchangeItem): (ContextEditDraft | OmitDraft)[] {
	return [
		{ type: "context_edit", targetId: item.entryId, replacement: { content: [{ type: "text", text: exchangeStub(item) }] } },
		...item.omitIds.map((id) => ({ type: "context_edit" as const, targetId: id, replacement: null })),
	];
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/** What Jev knows about the current work (both phases). */
export interface WorkContext {
	question: string;
	history: RunHistory;
	/** Run end: the final answer. */
	answer?: string;
	/** Mid-run: the latest assistant text and earlier notes. */
	latest?: string;
	notes?: string;
}

export const SMALL_OUTPUT_LIMIT = 4_000;
export const EXCHANGE_PROMPT_LIMIT = 600;
export const EXCHANGE_ANSWER_LIMIT = 800;
export const EXCHANGE_CALLS_LIMIT = 20;

const workState = (work: WorkContext): Record<string, unknown> => {
	const state: Record<string, unknown> = {};
	const history = work.history;
	if (history.summary || history.firstRequest || history.exchanges.length > 0) {
		const earlier: Record<string, unknown> = {};
		if (history.summary) earlier.summary = history.summary;
		if (history.firstRequest) earlier.first_request = history.firstRequest;
		if (history.exchanges.length > 0) earlier.recent_exchanges = history.exchanges.map((e) => (e.assistant ? { user: e.user, assistant: e.assistant } : { user: e.user }));
		state.earlier_conversation = earlier;
	}
	state.user_question = clip(work.question, 4_000);
	if (work.answer !== undefined) state.final_answer = clip(work.answer, 6_000);
	else {
		const progress: Record<string, string> = {};
		if (work.latest?.trim()) progress.latest_note = clip(work.latest, 2_000);
		if (work.notes?.trim()) progress.earlier_notes = clip(work.notes, 2_000);
		if (Object.keys(progress).length > 0) state.agent_progress = progress;
	}
	return state;
};

export const itemLabel = (index: number): string => `item_${index + 1}`;

/** One bool per small output: will the agent still need it? */
export function buildSmallRequest(work: WorkContext, items: readonly SmallItem[]): ClassifierRequest {
	const finished = work.answer !== undefined;
	const state: Record<string, unknown> = {
		situation: finished
			? "A coding agent answered user_question. To do so it called tools; items are the outputs of some of those calls. Outputs judged not needed are replaced by a one-line note and can be fetched again."
			: "A coding agent is still working on user_question; it has not finished yet. Items are outputs of its earlier tool calls. Outputs judged not needed are replaced by a one-line note and can be fetched again.",
		...workState(work),
		items: Object.fromEntries(
			items.map((item, i) => [
				itemLabel(i),
				{
					tool: toolLabel(item),
					...(item.isError ? { status: "failed" } : {}),
					...(item.superseded ? { superseded: item.superseded } : {}),
					output: clip(item.text, SMALL_OUTPUT_LIMIT),
				},
			]),
		),
	};
	const questions: Record<string, ClassifierQuestion> = {};
	items.forEach((_, i) => {
		const label = itemLabel(i);
		questions[label] = {
			type: "bool",
			instructions: finished
				? `Does ${label} contain anything that final_answer relies on, or that a likely follow-up question would need? An output marked superseded is out of date: a newer version exists, so it is not needed.`
				: `To finish user_question, will the agent still need the output in ${label}? Output that is out of date (marked superseded) or that the agent has already acted on and moved past is not needed.`,
			criteria: { true: `Keep ${label}`, false: `${label} is no longer needed` },
		};
	});
	return { state, questions };
}

export const exchangeLabel = (index: number): string => `exchange_${index + 1}`;

/** One bool per old exchange: is it still relevant to the current work? */
export function buildExchangeRequest(work: WorkContext, items: readonly ExchangeItem[]): ClassifierRequest {
	const state: Record<string, unknown> = {
		situation:
			"A coding agent works with a user in one long session. The exchanges are earlier, finished parts of the session: a user " +
			"prompt and everything the agent did for it. An exchange judged unrelated to the current work is replaced by a one-line " +
			"note and can be fetched again; the agent then no longer sees its details. user_question is the current work.",
		...workState(work),
		exchanges: Object.fromEntries(
			items.map((item, i) => [
				exchangeLabel(i),
				{
					user_prompt: clip(item.prompt, EXCHANGE_PROMPT_LIMIT),
					final_answer: clip(item.answer, EXCHANGE_ANSWER_LIMIT),
					tool_calls: item.toolCalls.length > EXCHANGE_CALLS_LIMIT ? [...item.toolCalls.slice(0, EXCHANGE_CALLS_LIMIT), `… ${item.toolCalls.length - EXCHANGE_CALLS_LIMIT} more`] : item.toolCalls,
					size: `${item.messages} messages, about ${formatChars(Math.round(item.chars / 4))} tokens`,
				},
			]),
		),
	};
	const questions: Record<string, ClassifierQuestion> = {};
	items.forEach((_, i) => {
		const label = exchangeLabel(i);
		questions[label] = {
			type: "bool",
			instructions: `Is ${label} still relevant to the current work (user_question and what the agent is doing for it)? Relevant means the agent may need its details: the same files, task, decisions or facts.`,
			criteria: { true: `${label} is still relevant`, false: `${label} is unrelated to the current work` },
		};
	});
	return { state, questions };
}

// ---------------------------------------------------------------------------------------------
// Shared limiter
// ---------------------------------------------------------------------------------------------

/** Runs at most `limit` tasks at once; shared by every item kind so `concurrency` is the total. */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
	let active = 0;
	const queue: (() => void)[] = [];
	const next = () => {
		if (active >= limit) return;
		const start = queue.shift();
		if (start) start();
	};
	return <T>(task: () => Promise<T>) =>
		new Promise<T>((resolve, reject) => {
			queue.push(() => {
				active++;
				task()
					.then(resolve, reject)
					.finally(() => {
						active--;
						next();
					});
			});
			next();
		});
}

// ---------------------------------------------------------------------------------------------
// Judging in parallel batches
// ---------------------------------------------------------------------------------------------

export interface JudgeOptions {
	timeoutMs: number;
	concurrency: number;
	/** Most characters of item text per request. */
	maxRequestChars: number;
	/** Most items per request. */
	maxItemsPerRequest: number;
}

export interface JudgeOutcome {
	/** P(true) per item index; undefined when Jev gave no answer (error, timeout). */
	probabilities: (number | undefined)[];
	/** Why an item has no probability. */
	failures: Map<number, string>;
	requests: number;
	inputTokens: number;
	costUsd: number;
	ms: number;
	timedOut: boolean;
}

/** Group consecutive items into requests that respect both limits. */
export function batchItems<T>(items: readonly T[], sizeOf: (item: T) => number, maxChars: number, maxItems: number): number[][] {
	const batches: number[][] = [];
	let current: number[] = [];
	let size = 0;
	items.forEach((item, i) => {
		const s = sizeOf(item);
		if (current.length > 0 && (size + s > maxChars || current.length >= maxItems)) {
			batches.push(current);
			current = [];
			size = 0;
		}
		current.push(i);
		size += s;
	});
	if (current.length > 0) batches.push(current);
	return batches;
}

/**
 * Ask Jev about `items` in batches (`build(batchItems)` makes one request, whose questions are
 * `label(position in batch)`), at most `concurrency` requests at once, within `timeoutMs`. Errors and
 * timeouts leave the probability undefined (= keep).
 */
export async function judgeItems<T>(
	items: readonly T[],
	sizeOf: (item: T) => number,
	build: (batch: T[]) => ClassifierRequest,
	label: (index: number) => string,
	classify: ClassifyFn,
	options: JudgeOptions,
	parentSignal?: AbortSignal,
	now: () => number = Date.now,
): Promise<JudgeOutcome> {
	const started = now();
	const outcome: JudgeOutcome = { probabilities: items.map(() => undefined), failures: new Map(), requests: 0, inputTokens: 0, costUsd: 0, ms: 0, timedOut: false };
	if (items.length === 0) return outcome;
	const batches = batchItems(items, sizeOf, options.maxRequestChars, options.maxItemsPerRequest);
	const budget = new AbortController();
	const timer = setTimeout(() => budget.abort(new Error("context-guard time budget exceeded")), options.timeoutMs);
	const signal = parentSignal ? AbortSignal.any([parentSignal, budget.signal]) : budget.signal;
	let next = 0;
	const fail = (batch: number[], why: string) => {
		for (const i of batch) outcome.failures.set(i, why);
	};
	const runner = async () => {
		while (next < batches.length && !signal.aborted) {
			const batch = batches[next++];
			outcome.requests++;
			try {
				const response = await raceAbort(classify(build(batch.map((i) => items[i])), signal), signal);
				if (response.usage) {
					outcome.inputTokens += response.usage.input;
					outcome.costUsd += response.usage.cost.total;
				}
				if (response.stopReason !== "stop") {
					fail(batch, budget.signal.aborted ? "timeout" : "error");
					continue;
				}
				batch.forEach((itemIndex, k) => {
					const answer = response.answers[label(k)];
					if (answer?.type === "bool") outcome.probabilities[itemIndex] = answer.probability;
					else outcome.failures.set(itemIndex, "no-answer");
				});
			} catch {
				fail(batch, budget.signal.aborted ? "timeout" : "error");
			}
		}
	};
	try {
		await Promise.all(Array.from({ length: Math.min(options.concurrency, batches.length) }, runner));
	} finally {
		clearTimeout(timer);
	}
	outcome.timedOut = budget.signal.aborted;
	items.forEach((_, i) => {
		if (outcome.probabilities[i] === undefined && !outcome.failures.has(i)) outcome.failures.set(i, "timeout");
	});
	outcome.ms = now() - started;
	return outcome;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}


