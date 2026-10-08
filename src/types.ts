/**
 * Loose structural types for the parts of Pi's session/message model this extension reads.
 *
 * The pure modules (run, chunk, decide, render, distill, cache-pin, stats) only use these, so
 * they can be unit-tested with plain Node without loading Pi. `index.ts` is the only module
 * that touches the real Pi API.
 */

export type Block = { type: string; text?: string; [key: string]: unknown };

export interface MessageLike {
	role: string;
	/** Absent on Pi's `compactionSummary` / `branchSummary` messages, which carry `summary`. */
	content: string | Block[];
	summary?: string;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	/** Assistant messages: why the model stopped ("toolUse", "stop", "aborted", "error", …). */
	stopReason?: string;
}

export interface SourceEntryLike {
	id: string;
	type?: string;
	message?: MessageLike;
	[key: string]: unknown;
}

/** Shape of Pi's `ProjectedSessionEntry`. */
export interface ProjectedEntryLike {
	sourceEntry: SourceEntryLike;
	messages: MessageLike[];
}

/** Subset of Pi's classifier types (`@earendil-works/pi-ai` → ClassifierContext/Result). */
export type ClassifierQuestion =
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] }
	| { type: "bool"; instructions: string; criteria: { true: string; false: string } };

export interface ClassifierRequest {
	state: Record<string, unknown>;
	questions: Record<string, ClassifierQuestion>;
}

export type ClassifierAnswer =
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "score"; score: number; confidence: number }
	| { type: "bool"; probability: number };

export interface ClassifierResponse {
	answers: Record<string, ClassifierAnswer>;
	usage?: { input: number; output: number; totalTokens: number; cost: { total: number } };
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
}

export type ClassifyFn = (request: ClassifierRequest, signal: AbortSignal) => Promise<ClassifierResponse>;

/** Draft accepted by `agent_before_settle` (Pi's `ContextEditEntryDraft`). */
export interface ContextEditDraft {
	type: "context_edit";
	targetId: string;
	replacement: { content: { type: "text"; text: string }[] };
}

/** A context edit that omits its target from model context (`replacement: null`). */
export interface OmitDraft {
	type: "context_edit";
	targetId: string;
	replacement: null;
}

/** Draft accepted by `agent_before_settle` (Pi's `CustomEntryDraft`). */
export interface CustomDraft {
	type: "custom";
	customType: string;
	data?: unknown;
}

export const textOf = (message: MessageLike): string =>
	typeof message.content === "string"
		? message.content
		: message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("\n");

export const isTextOnly = (message: MessageLike): boolean =>
	typeof message.content === "string" || message.content.every((block) => block.type === "text");

/** Shorten `text` to about `max` characters, keeping its head (70%) and tail. */
export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.7);
	return `${text.slice(0, head)}\n[…]\n${text.slice(text.length - (max - head))}`;
}
