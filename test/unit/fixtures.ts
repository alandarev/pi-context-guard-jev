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

/** Base64 of a PNG header for a `width`×`height` image (enough for size.ts), padded to `pad` characters. */
export const pngData = (width: number, height: number, pad = 0): string => {
	const b = Buffer.alloc(32);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
	b.writeUInt32BE(13, 8);
	b.write("IHDR", 12, "latin1");
	b.writeUInt32BE(width, 16);
	b.writeUInt32BE(height, 20);
	return b.toString("base64") + "A".repeat(pad);
};

/** A tool result with a text line and `images` screenshots (1500×1000: 2,000 tokens each). */
export const screenshotResult = (toolCallId: string, toolName: string, text: string, id?: string, images = 1) =>
	entry(
		{
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }, ...Array.from({ length: images }, () => ({ type: "image", mimeType: "image/png", data: pngData(1500, 1000, 50_000) }))],
			isError: false,
		},
		id,
	);

/** `count` lines of filler text, each about `width` characters, numbered for identification. */
export const lines = (count: number, prefix = "line", width = 60): string =>
	Array.from({ length: count }, (_, i) => `${prefix} ${i + 1} `.padEnd(width, "x")).join("\n");

/** rg-style output: `files` files with `perFile` matches each. */
export const grepOutput = (files: string[], perFile: number, width = 60): string =>
	files.flatMap((file) => Array.from({ length: perFile }, (_, i) => `${file}:${i + 1}:${"match ".padEnd(width, "y")}`)).join("\n");
