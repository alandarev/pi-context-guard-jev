/**
 * Old images (docs/DESIGN.md → Images). A model looks at a screenshot once: it describes or acts on it in
 * its next message and goes on. Every later request still sends the image (about w×h/750 tokens each), so
 * long runs with screenshots pile up context. Images in tool results are removed once they are
 * `imageKeepTurns` turns old (assistant messages after the result). No Jev request is needed: Jev reads
 * text only, and age is what decides. The result's text stays; a stub in front says what was removed, and
 * `recall` returns the images. Images in user messages are always kept.
 */
import { MARKER, formatChars, toolLabel } from "./render.ts";
import { indexSpan } from "./run.ts";
import { contentChars, imageInfo } from "./size.ts";
import { type Block, type MessageLike, type ProjectedEntryLike, textOf } from "./types.ts";

export interface ImageItem {
	/** Session entry id of the tool result. */
	entryId: string;
	toolName: string;
	args?: Record<string, unknown>;
	/** Position in the projection. */
	index: number;
	/** Assistant messages after the result. */
	age: number;
	images: number;
	/** Estimated input tokens of the removed images. */
	imageTokens: number;
	/** Model-visible size before and after, in text characters (size.ts). */
	beforeChars: number;
	afterChars: number;
	/** The new content: the stub, then the result's text blocks. */
	replacement: { type: "text"; text: string }[];
}

const imageBlocks = (message: MessageLike | undefined): Block[] => (Array.isArray(message?.content) ? message.content.filter((b) => b.type === "image") : []);

/** True for a tool result whose images were removed by us (the raw entry has images, the model sees none). */
export const imagesRemoved = (projected: MessageLike | undefined, raw: MessageLike | undefined): boolean =>
	projected?.role === "toolResult" && imageBlocks(raw).length > 0 && imageBlocks(projected).length === 0 && textOf(projected).startsWith(MARKER);

export function imageStub(item: Pick<ImageItem, "entryId" | "images" | "imageTokens" | "age">, sizes: string[]): string {
	const what = item.images === 1 ? "1 image" : `${item.images} images`;
	const dims = sizes.length > 0 ? `${sizes.slice(0, 3).join(", ")}${sizes.length > 3 ? ", …" : ""}; ` : "";
	const them = item.images === 1 ? "it" : "them";
	return `${MARKER} Removed ${what} from this output (${dims}~${formatChars(item.imageTokens)} tokens), ${item.age} turns old. recall({"entryId":"${item.entryId}"}) shows ${them} again.`;
}

/**
 * Tool results in `entries` (the whole projection, earlier runs included) with images that are at least
 * `keepTurns` turns old. Skipped: results another extension changed (recall returns the raw entry, so
 * their edit could not be restored) and results without images in the model's view.
 */
export function collectImages(entries: readonly ProjectedEntryLike[], keepTurns: number): ImageItem[] {
	if (keepTurns <= 0) return [];
	const { toolCalls } = indexSpan(entries);
	// Assistant messages after each position.
	const after = new Array<number>(entries.length + 1).fill(0);
	for (let i = entries.length - 1; i >= 0; i--) after[i] = after[i + 1] + entries[i].messages.filter((m) => m.role === "assistant").length;
	const items: ImageItem[] = [];
	entries.forEach((entry, index) => {
		const message = entry.messages[0];
		if (entry.messages.length !== 1 || message?.role !== "toolResult" || !Array.isArray(message.content)) return;
		const images = imageBlocks(message);
		if (images.length === 0) return;
		const age = after[index + 1];
		if (age < keepTurns) return;
		const raw = entry.sourceEntry.message;
		if (raw && raw !== message && (textOf(raw) !== textOf(message) || imageBlocks(raw).length !== images.length)) return;
		const call = message.toolCallId ? toolCalls.get(message.toolCallId) : undefined;
		const infos = images.map(imageInfo);
		const item = {
			entryId: entry.sourceEntry.id,
			toolName: message.toolName ?? call?.name ?? "tool",
			...(call?.args ? { args: call.args } : {}),
			index,
			age,
			images: images.length,
			imageTokens: infos.reduce((n, i) => n + i.tokens, 0),
		};
		const sizes = infos.flatMap((i) => (i.width && i.height ? [`${i.width}×${i.height}`] : []));
		const replacement = [
			{ type: "text" as const, text: imageStub(item, sizes) },
			...message.content.filter((b) => b.type === "text").map((b) => ({ type: "text" as const, text: b.text ?? "" })),
		];
		items.push({ ...item, beforeChars: contentChars(message.content), afterChars: contentChars(replacement), replacement });
	});
	return items;
}

export const imageLabel = (item: Pick<ImageItem, "toolName" | "args" | "images">): string =>
	`${toolLabel({ toolName: item.toolName, args: item.args })} (${item.images === 1 ? "1 image" : `${item.images} images`})`;
