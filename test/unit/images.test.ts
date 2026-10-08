import assert from "node:assert/strict";
import { test } from "node:test";
import { collectImages, imagesRemoved, imageStub } from "../../src/images.ts";
import { MARKER } from "../../src/render.ts";
import { contentChars } from "../../src/size.ts";
import { assistant, entry, pngData, screenshotResult, user } from "./fixtures.ts";

const shotRun = () => [
	user("Check the login page", "u1"),
	assistant("", [{ id: "c1", name: "screenshot", arguments: { url: "/login" } }], "a1"),
	screenshotResult("c1", "screenshot", "login page captured", "r1"),
	assistant("The button is cut off.", [{ id: "c2", name: "screenshot", arguments: { url: "/signup" } }], "a2"),
	screenshotResult("c2", "screenshot", "signup page captured", "r2", 2),
	assistant("", [{ id: "c3", name: "bash", arguments: { command: "ls" } }], "a3"),
	entry({ role: "toolResult", toolCallId: "c3", toolName: "bash", content: [{ type: "text", text: "a b" }] }, "r3"),
	assistant("", [{ id: "c4", name: "screenshot", arguments: { url: "/home" } }], "a4"),
	screenshotResult("c4", "screenshot", "home captured", "r4"),
	assistant("Done.", [], "a5"),
];

test("collectImages: tool results whose images are at least keepTurns old", () => {
	const items = collectImages(shotRun(), 3);
	// r1: 4 assistant messages after it, r2: 3, r4: 1.
	assert.deepEqual(
		items.map((i) => [i.entryId, i.age, i.images, i.imageTokens]),
		[
			["r1", 4, 1, 2_000],
			["r2", 3, 2, 4_000],
		],
	);
	const [r1] = items;
	assert.equal(r1.toolName, "screenshot");
	assert.deepEqual(r1.args, { url: "/login" });
	assert.equal(r1.beforeChars, "login page captured".length + 2_000 * 4);
	assert.deepEqual(r1.replacement.at(-1), { type: "text", text: "login page captured" });
	assert.equal(r1.replacement[0].text, `${MARKER} Removed 1 image from this output (1500×1000; ~2.0k tokens), 4 turns old. recall({"entryId":"r1"}) shows it again.`);
	assert.equal(r1.afterChars, contentChars(r1.replacement));
	assert.equal(collectImages(shotRun(), 0).length, 0, "0 turns it off");
	assert.equal(collectImages(shotRun(), 1).length, 3);
});

test("collectImages: user images, already removed and foreign-edited results are skipped", () => {
	const entries = [
		entry({ role: "user", content: [{ type: "text", text: "like this" }, { type: "image", data: pngData(800, 600) }] }, "u1"),
		...shotRun().slice(1),
		assistant("a", [], "x1"),
		assistant("b", [], "x2"),
		assistant("c", [], "x3"),
	];
	// Removed by us: the model sees our stub and no image.
	const removed = entries.map((e) => (e.sourceEntry.id === "r1" ? { ...e, messages: [{ ...e.messages[0], content: [{ type: "text", text: `${MARKER} Removed 1 image` }] }] } : e));
	assert.ok(imagesRemoved(removed[2].messages[0], removed[2].sourceEntry.message));
	assert.deepEqual(
		collectImages(removed, 3).map((i) => i.entryId),
		["r2", "r4"],
	);
	// Another extension changed the text: left alone.
	const foreign = entries.map((e) => (e.sourceEntry.id === "r2" ? { ...e, messages: [{ ...e.messages[0], content: [{ type: "text", text: "redacted" }, ...(e.messages[0].content as never[]).slice(1)] }] } : e));
	assert.deepEqual(
		collectImages(foreign, 3).map((i) => i.entryId),
		["r1", "r4"],
	);
});

test("imageStub: several images, unknown sizes", () => {
	assert.equal(
		imageStub({ entryId: "x", images: 5, imageTokens: 9_000, age: 7 }, ["1×1", "2×2", "3×3", "4×4"]),
		`${MARKER} Removed 5 images from this output (1×1, 2×2, 3×3, …; ~9.0k tokens), 7 turns old. recall({"entryId":"x"}) shows them again.`,
	);
	assert.equal(imageStub({ entryId: "x", images: 1, imageTokens: 1_600, age: 3 }, []), `${MARKER} Removed 1 image from this output (~1.6k tokens), 3 turns old. recall({"entryId":"x"}) shows it again.`);
});
