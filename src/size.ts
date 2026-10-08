/**
 * Size estimates for model context, in "text characters": the unit tool output is measured in, so the
 * break-even rule (checkpoint.ts → paysOff) compares like with like.
 *
 * Blocks that are not plain text must not be counted by their serialized length:
 * - images are base64 (a 1280×960 JPEG is ~110k characters) but cost about w×h/750 tokens on Anthropic
 *   (measured on a real Opus session: 1280×960 → ~1.6k tokens), so they are counted by their pixels, at
 *   4 characters per token (Pi's own chars/4 estimate, so the footer shows image savings as tokens);
 * - thinking blocks carry an encrypted signature that grows with the hidden reasoning; it is counted at
 *   half its length (measured: ~0.25 tokens per signature character vs ~0.4 per character of tool text).
 */
import { Buffer } from "node:buffer";
import type { Block } from "./types.ts";

/** Text characters per image token: Pi's chars/4 estimate (tool output itself runs at ~2.5–3). */
export const IMAGE_CHARS_PER_TOKEN = 4;
/** Anthropic's image token estimate: width × height / 750. */
export const IMAGE_PIXELS_PER_TOKEN = 750;
/** Tokens assumed for an image whose size cannot be read (about a 1.15-megapixel image). */
export const DEFAULT_IMAGE_TOKENS = 1_600;
/** Upper bound for one image (a 2576-pixel long edge at 4:3). */
export const MAX_IMAGE_TOKENS = 6_700;
/** Base64 characters decoded to find the image header (JPEG headers can sit behind EXIF data). */
const HEADER_BASE64_CHARS = 65_536;

/** Width and height from the header of a PNG, JPEG, GIF or WebP image, or undefined. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
	const b = bytes;
	const u16be = (i: number) => (b[i] << 8) | b[i + 1];
	const u16le = (i: number) => b[i] | (b[i + 1] << 8);
	const u32be = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
	if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32be(16), height: u32be(20) };
	if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: u16le(6), height: u16le(8) };
	if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
		const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
		if (chunk === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
		if (chunk === "VP8L") return { width: 1 + (u16le(21) & 0x3fff), height: 1 + (((b[22] >> 6) | (b[23] << 2) | (b[24] << 10)) & 0x3fff) };
		if (chunk === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
		return undefined;
	}
	if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
		let i = 2;
		while (i + 9 < b.length) {
			if (b[i] !== 0xff) {
				i++;
				continue;
			}
			const marker = b[i + 1];
			if (marker === 0xff) {
				i++;
				continue;
			}
			// SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16be(i + 7), height: u16be(i + 5) };
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				i += 2;
				continue;
			}
			i += 2 + u16be(i + 2);
		}
	}
	return undefined;
}

export interface ImageInfo {
	width?: number;
	height?: number;
	/** Estimated input tokens. */
	tokens: number;
}

const imageInfoCache = new WeakMap<object, ImageInfo>();

/** Size (when the header is readable) and estimated input tokens of an image block (`{ type: "image", data: <base64> }`). */
export function imageInfo(block: Block): ImageInfo {
	const cached = imageInfoCache.get(block);
	if (cached) return cached;
	let info: ImageInfo = { tokens: DEFAULT_IMAGE_TOKENS };
	if (typeof block.data === "string") {
		const head = block.data.slice(0, HEADER_BASE64_CHARS);
		const size = imageSize(Buffer.from(head.slice(0, head.length - (head.length % 4)), "base64"));
		if (size && size.width > 0 && size.height > 0) {
			info = { ...size, tokens: Math.min(MAX_IMAGE_TOKENS, Math.max(1, Math.ceil((size.width * size.height) / IMAGE_PIXELS_PER_TOKEN))) };
		}
	}
	imageInfoCache.set(block, info);
	return info;
}

/** Estimated input tokens of an image block. */
export const imageTokens = (block: Block): number => imageInfo(block).tokens;

/** Estimated size of one content block in text characters. */
export function blockChars(block: Block): number {
	switch (block.type) {
		case "text":
			return typeof block.text === "string" ? block.text.length : 0;
		case "image":
			return imageTokens(block) * IMAGE_CHARS_PER_TOKEN;
		case "thinking": {
			const thinking = typeof block.thinking === "string" ? block.thinking.length : 0;
			const signature = typeof block.thinkingSignature === "string" ? block.thinkingSignature.length : 0;
			return thinking + Math.ceil(signature / 2);
		}
		case "toolCall":
			return String(block.name ?? "").length + JSON.stringify(block.arguments ?? {}).length;
		default:
			return JSON.stringify(block).length;
	}
}

/** Estimated size of message content in text characters. */
export const contentChars = (content: string | readonly Block[] | undefined): number =>
	typeof content === "string" ? content.length : (content ?? []).reduce((n, block) => n + blockChars(block), 0);
