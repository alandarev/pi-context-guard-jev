/** Shared fixtures for the unit tests: Pi-shaped projected session entries. */
import type { MessageLike, ProjectedEntryLike } from "../../src/types.ts";

let counter = 0;

export const entry = (message: MessageLike, id = `e${++counter}`): ProjectedEntryLike => ({
	sourceEntry: { id, type: "message", message },
	messages: [message],
});

export const user = (text: string, id?: string) => entry({ role: "user", content: [{ type: "text", text }] }, id);

export const assistant = (text: string, toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [], id?: string) =>
	entry(
		{
			role: "assistant",
			content: [...(text ? [{ type: "text", text }] : []), ...toolCalls.map((call) => ({ type: "toolCall", ...call }))],
		},
		id,
	);

export const toolResult = (toolCallId: string, toolName: string, text: string, id?: string, extra: Partial<MessageLike> = {}) =>
	entry({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, ...extra }, id);

/** `count` lines of filler text, each about `width` characters, numbered for identification. */
export const lines = (count: number, prefix = "line", width = 60): string =>
	Array.from({ length: count }, (_, i) => `${prefix} ${i + 1} `.padEnd(width, "x")).join("\n");

/** rg-style output: `files` files with `perFile` matches each. */
export const grepOutput = (files: string[], perFile: number, width = 60): string =>
	files.flatMap((file) => Array.from({ length: perFile }, (_, i) => `${file}:${i + 1}:${"match ".padEnd(width, "y")}`)).join("\n");
