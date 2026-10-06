/**
 * Find the run that just finished and its candidate tool results (see docs/DESIGN.md).
 */
import { MARKER } from "./render.ts";
import { isTextOnly, type MessageLike, type ProjectedEntryLike, textOf } from "./types.ts";

export interface Candidate {
	/** Session entry id of the tool-result message. */
	entryId: string;
	toolName: string;
	/** Arguments of the matching tool call, when found in the run. */
	args: Record<string, unknown> | undefined;
	/** Model-visible text (after earlier context edits). */
	text: string;
}

export interface RunInfo {
	question: string;
	answer: string;
	/** Earlier assistant text of the run (reasoning notes), oldest first. */
	notes: string;
	candidates: Candidate[];
	/** Number of tool results in the run, including ones that are not candidates. */
	toolResults: number;
}

export interface CollectOptions {
	minResultChars: number;
	excludeTools: readonly string[];
}

/** Question text used when the prompt that started the run has no text (e.g. only an image). */
export const NO_TEXT_QUESTION = "[the user sent only an image]";

/**
 * The run starts after the last user message, with or without text. Steering messages sent
 * during a run are user messages too, so they start a new span; tool results before them are
 * left for later (they stay unpruned, which is the safe direction).
 */
export function collectRun(entries: readonly ProjectedEntryLike[], options: CollectOptions): RunInfo | undefined {
	let start = entries.length - 1;
	while (start >= 0 && !entries[start].messages.some((m) => m.role === "user")) start--;
	if (start < 0) return undefined;

	const questionMessage = entries[start].messages.findLast((m) => m.role === "user");
	const questionText = questionMessage ? textOf(questionMessage).trim() : "";
	const question = questionText ? textOf(questionMessage as MessageLike) : NO_TEXT_QUESTION;
	const span = entries.slice(start + 1);

	const assistantTexts: string[] = [];
	const toolCalls = new Map<string, { name: string; args: Record<string, unknown> | undefined }>();
	for (const entry of span) {
		for (const message of entry.messages) {
			if (message.role !== "assistant" || typeof message.content === "string") continue;
			const text = textOf(message).trim();
			if (text) assistantTexts.push(text);
			for (const block of message.content) {
				if (block.type === "toolCall" && typeof block.id === "string") {
					const args = block.arguments && typeof block.arguments === "object" ? (block.arguments as Record<string, unknown>) : undefined;
					toolCalls.set(block.id, { name: String(block.name ?? ""), args });
				}
			}
		}
	}
	const answer = assistantTexts.at(-1) ?? "";
	const notes = assistantTexts.slice(0, -1).join("\n\n");

	const exclude = new Set(options.excludeTools);
	const candidates: Candidate[] = [];
	let toolResults = 0;
	for (const entry of span) {
		const message = entry.messages[0];
		if (entry.messages.length !== 1 || message?.role !== "toolResult") continue;
		toolResults++;
		if (message.isError || !isTextOnly(message)) continue;
		const call = message.toolCallId ? toolCalls.get(message.toolCallId) : undefined;
		const toolName = message.toolName ?? call?.name ?? "tool";
		if (exclude.has(toolName)) continue;
		const text = textOf(message);
		if (text.length < options.minResultChars || text.startsWith(MARKER)) continue;
		// Another extension already edited this result: recall returns the raw entry, so whatever
		// that edit added could not be recovered after distillation. Leave it alone.
		const raw = entry.sourceEntry.message;
		if (raw && textOf(raw) !== text) continue;
		candidates.push({ entryId: entry.sourceEntry.id, toolName, args: call?.args, text });
	}
	return { question, answer, notes, candidates, toolResults };
}
