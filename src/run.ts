/**
 * Find the run that just finished and its candidate tool results (DESIGN.md → Algorithm 2–3).
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

const hasText = (message: MessageLike): boolean => textOf(message).trim().length > 0;

/**
 * The run starts after the last user message with text. Steering messages sent during a
 * run are user messages too, so they start a new span; tool results before them are left
 * for later (they stay unpruned, which is the safe direction).
 */
export function collectRun(entries: readonly ProjectedEntryLike[], options: CollectOptions): RunInfo | undefined {
	let start = entries.length - 1;
	while (start >= 0 && !entries[start].messages.some((m) => m.role === "user" && hasText(m))) start--;
	if (start < 0) return undefined;

	const questionMessage = entries[start].messages.findLast((m) => m.role === "user" && hasText(m));
	const question = questionMessage ? textOf(questionMessage) : "";
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
		candidates.push({ entryId: entry.sourceEntry.id, toolName, args: call?.args, text });
	}
	return { question, answer, notes, candidates, toolResults };
}
