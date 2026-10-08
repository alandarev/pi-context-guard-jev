import assert from "node:assert/strict";
import { test } from "node:test";
import { contextChars } from "../../src/checkpoint.ts";
import { blockChars, contentChars, DEFAULT_IMAGE_TOKENS, IMAGE_CHARS_PER_TOKEN, imageSize, imageTokens, MAX_IMAGE_TOKENS } from "../../src/size.ts";
import type { ProjectedEntryLike } from "../../src/types.ts";

const png = (width: number, height: number): Buffer => {
	const b = Buffer.alloc(64);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
	b.writeUInt32BE(13, 8);
	b.write("IHDR", 12, "latin1");
	b.writeUInt32BE(width, 16);
	b.writeUInt32BE(height, 20);
	return b;
};

/** SOI, an APP1 segment (as if EXIF), then SOF2 (progressive). */
const jpeg = (width: number, height: number): Buffer => {
	const app1 = Buffer.alloc(4 + 300);
	app1.writeUInt16BE(0xffe1, 0);
	app1.writeUInt16BE(302, 2);
	const sof = Buffer.alloc(12);
	sof.writeUInt16BE(0xffc2, 0);
	sof.writeUInt16BE(17, 2);
	sof[4] = 8;
	sof.writeUInt16BE(height, 5);
	sof.writeUInt16BE(width, 7);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.alloc(64)]);
};

const gif = (width: number, height: number): Buffer => {
	const b = Buffer.alloc(16);
	b.write("GIF89a", 0, "latin1");
	b.writeUInt16LE(width, 6);
	b.writeUInt16LE(height, 8);
	return b;
};

const webpVp8x = (width: number, height: number): Buffer => {
	const b = Buffer.alloc(40);
	b.write("RIFF", 0, "latin1");
	b.write("WEBP", 8, "latin1");
	b.write("VP8X", 12, "latin1");
	b.writeUIntLE(width - 1, 24, 3);
	b.writeUIntLE(height - 1, 27, 3);
	return b;
};

const image = (bytes: Buffer, padTo = 0) => ({ type: "image", mimeType: "image/png", data: bytes.toString("base64") + "A".repeat(padTo) });

test("imageSize reads PNG, JPEG (behind an APP segment), GIF and WebP headers", () => {
	assert.deepEqual(imageSize(png(1280, 960)), { width: 1280, height: 960 });
	assert.deepEqual(imageSize(jpeg(900, 675)), { width: 900, height: 675 });
	assert.deepEqual(imageSize(gif(320, 200)), { width: 320, height: 200 });
	assert.deepEqual(imageSize(webpVp8x(1000, 750)), { width: 1000, height: 750 });
	assert.equal(imageSize(Buffer.from("not an image")), undefined);
});

test("an image counts by its pixels, not by its base64 length", () => {
	// A 1280×960 screenshot is ~110k base64 characters but ~1.6k tokens (w×h/750).
	const block = image(png(1280, 960), 110_000);
	assert.equal(imageTokens(block), Math.ceil((1280 * 960) / 750));
	assert.equal(blockChars(block), Math.ceil((1280 * 960) / 750) * IMAGE_CHARS_PER_TOKEN);
	assert.ok(blockChars(block) < 7_000);
	// Unreadable data: the default; huge images: the cap.
	assert.equal(imageTokens({ type: "image", data: "@@@@" }), DEFAULT_IMAGE_TOKENS);
	assert.equal(imageTokens(image(png(20_000, 20_000))), MAX_IMAGE_TOKENS);
});

test("thinking counts its text plus half its signature; tool calls their name and arguments", () => {
	assert.equal(blockChars({ type: "thinking", thinking: "x".repeat(100), thinkingSignature: "s".repeat(400) }), 300);
	assert.equal(blockChars({ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }), 4 + JSON.stringify({ command: "ls" }).length);
	assert.equal(contentChars("hello"), 5);
	assert.equal(contentChars([{ type: "text", text: "abc" }, { type: "text", text: "de" }]), 5);
});

test("contextChars of a context with screenshots stays close to its token size", () => {
	const shot = image(png(1280, 960), 110_000);
	const entries: ProjectedEntryLike[] = Array.from({ length: 10 }, (_, i) => ({
		sourceEntry: { id: `r${i}`, type: "message" },
		messages: [{ role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: "ok" }, shot] }],
	}));
	assert.equal(contextChars(entries), 10 * (2 + Math.ceil((1280 * 960) / 750) * IMAGE_CHARS_PER_TOKEN));
});
