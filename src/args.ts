/**
 * Long arguments of old tool calls (docs/DESIGN.md → Arguments). A `write` sends the whole file, a
 * heredoc the whole script, an `edit` both versions of the code; once the call has run, every later
 * request still carries it. String arguments of tool calls that are `argKeepTurns` turns old (assistant
 * messages after the call) are shortened in place: their head and tail stay and one marker line in the
 * middle says how much was left out and that the call ran with the full value. The model still recognises
 * its own call and sees that only the record was shortened (live probes: a whole-value stub made Claude
 * believe it had written the stub and redo the write). No Jev request is needed: age decides. `recall`
 * with the assistant entry's id returns the original calls.
 */
import { formatChars, RECALL_TOOL, toolLabel } from "./render.ts";
import { contentChars } from "./size.ts";
import type { Block, MessageLike, ProjectedEntryLike } from "./types.ts";

/** Start of the marker line put in the middle of a shortened argument (also how our edits are recognised). */
export const ARG_MARKER = "[context-guard: ";
/** Lines and characters kept at the head and tail of a shortened argument. */
export const ARG_HEAD_LINES = 12;
export const ARG_TAIL_LINES = 6;
export const ARG_KEEP_CHARS = 600;

export interface ArgsItem {
	/** Session entry id of the assistant message. */
	entryId: string;
	/** Tool name and arguments of the first shortened call (for the label). */
	toolName: string;
	args?: Record<string, unknown>;
	/** Tool calls and string arguments shortened. */
	calls: number;
	strings: number;
	/** Position in the projection. */
	index: number;
	/** Assistant messages after this one. */
	age: number;
	/** Model-visible size before and after, in text characters (size.ts). */
	beforeChars: number;
	afterChars: number;
	/** The whole content array, unchanged except the shortened arguments. */
	replacement: Block[];
}

const lineCount = (text: string): number => text.split("\n").length;

/**
 * `text` with its middle replaced by one marker line, keeping up to ARG_HEAD_LINES / ARG_TAIL_LINES
 * lines (at most ARG_KEEP_CHARS characters each side), or undefined when that would remove fewer than
 * `minSaving` characters.
 */
export function elideString(text: string, entryId: string, minSaving: number): string | undefined {
	if (text.length < minSaving || text.includes(ARG_MARKER)) return undefined;
	const lines = text.split("\n");
	let head = lines.slice(0, ARG_HEAD_LINES).join("\n");
	if (head.length > ARG_KEEP_CHARS) {
		const cut = head.lastIndexOf("\n", ARG_KEEP_CHARS);
		head = cut > 0 ? head.slice(0, cut) : head.slice(0, ARG_KEEP_CHARS);
	}
	let tail = lines.slice(-ARG_TAIL_LINES).join("\n");
	if (tail.length > ARG_KEEP_CHARS) {
		const cut = tail.indexOf("\n", tail.length - ARG_KEEP_CHARS);
		tail = cut >= 0 ? tail.slice(cut + 1) : tail.slice(-ARG_KEEP_CHARS);
	}
	const omitted = text.length - head.length - tail.length;
	if (omitted <= 0) return undefined;
	const omittedLines = lineCount(text) - (head ? lineCount(head) : 0) - (tail ? lineCount(tail) : 0);
	const what = omittedLines > 1 ? `${formatChars(omitted)} chars / ${omittedLines} lines` : `${formatChars(omitted)} chars`;
	const marker = `${ARG_MARKER}${what} omitted here afterwards to save context; the call ran with the full value and succeeded. recall({"entryId":"${entryId}"}) shows it]`;
	const result = `${head}\n${marker}\n${tail}`;
	return text.length - result.length >= minSaving ? result : undefined;
}

/** `value` with every long string leaf shortened (elideString); objects and arrays keep their structure. */
function elideValue(value: unknown, entryId: string, minSaving: number, count: { strings: number }): unknown {
	if (typeof value === "string") {
		const short = elideString(value, entryId, minSaving);
		if (short === undefined) return value;
		count.strings++;
		return short;
	}
	if (Array.isArray(value)) return value.map((v) => elideValue(v, entryId, minSaving, count));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, elideValue(v, entryId, minSaving, count)]));
	return value;
}

/** True when some string inside `value` carries our marker line. */
function hasElision(value: unknown): boolean {
	if (typeof value === "string") return value.includes(ARG_MARKER);
	if (Array.isArray(value)) return value.some(hasElision);
	if (value && typeof value === "object") return Object.values(value).some(hasElision);
	return false;
}

/** Tool calls of an assistant message whose arguments we shortened. */
export const elidedCalls = (message: MessageLike | undefined): number =>
	message?.role === "assistant" && Array.isArray(message.content) ? message.content.filter((b) => b.type === "toolCall" && hasElision(b.arguments)).length : 0;

/**
 * True for an assistant message the model sees with our shortened arguments: `projected` has our marker
 * lines, `raw` (the session entry) has none, and nothing else differs.
 */
export function argsElided(projected: MessageLike | undefined, raw: MessageLike | undefined): boolean {
	if (projected?.role !== "assistant" || raw?.role !== "assistant" || !Array.isArray(projected.content) || !Array.isArray(raw.content)) return false;
	if (projected.content.length !== raw.content.length || elidedCalls(projected) === 0 || elidedCalls(raw) > 0) return false;
	return projected.content.every((block, i) => {
		const original = raw.content[i] as Block;
		if (block.type !== "toolCall") return JSON.stringify(block) === JSON.stringify(original);
		return original.type === "toolCall" && block.id === original.id && block.name === original.name;
	});
}

/**
 * Assistant messages in `entries` (the whole projection, earlier runs included) with tool calls that are
 * at least `keepTurns` turns old and have string arguments that shorten by at least `minChars`. Only
 * calls whose tool result is in the projection and not an error are touched (a failed call is often
 * retried with a corrected value, which the model must still see). Skipped: `recall` calls and messages
 * the model sees changed (by us or another extension), including those of omitted exchanges.
 */
export function collectArgs(entries: readonly ProjectedEntryLike[], keepTurns: number, minChars: number): ArgsItem[] {
	if (keepTurns <= 0) return [];
	const succeeded = new Set<string>();
	for (const entry of entries) {
		for (const m of entry.messages) if (m.role === "toolResult" && m.toolCallId && !m.isError) succeeded.add(m.toolCallId);
	}
	// Assistant messages after each position.
	const after = new Array<number>(entries.length + 1).fill(0);
	for (let i = entries.length - 1; i >= 0; i--) after[i] = after[i + 1] + entries[i].messages.filter((m) => m.role === "assistant").length;
	const items: ArgsItem[] = [];
	entries.forEach((entry, index) => {
		const message = entry.messages[0];
		if (entry.messages.length !== 1 || message?.role !== "assistant" || !Array.isArray(message.content)) return;
		const age = after[index + 1];
		if (age < keepTurns) return;
		const raw = entry.sourceEntry.message;
		if (raw && raw !== message && JSON.stringify(raw.content) !== JSON.stringify(message.content)) return;
		const entryId = entry.sourceEntry.id;
		const count = { strings: 0 };
		let calls = 0;
		let first: Block | undefined;
		const replacement = message.content.map((block) => {
			if (block.type !== "toolCall" || block.name === RECALL_TOOL || typeof block.id !== "string" || !succeeded.has(block.id)) return block;
			if (!block.arguments || typeof block.arguments !== "object") return block;
			const before = count.strings;
			const args = elideValue(block.arguments, entryId, minChars, count);
			if (count.strings === before) return block;
			calls++;
			first ??= block;
			return { ...block, arguments: args };
		});
		if (!first) return;
		items.push({
			entryId,
			toolName: String(first.name ?? "tool"),
			...(first.arguments && typeof first.arguments === "object" ? { args: first.arguments as Record<string, unknown> } : {}),
			calls,
			strings: count.strings,
			index,
			age,
			beforeChars: contentChars(message.content),
			afterChars: contentChars(replacement),
			replacement,
		});
	});
	return items;
}

/** e.g. "write src/a.ts (1 arg)", "bash `cat <<EOF …` +1 call (3 args)". */
export const argsLabel = (item: Pick<ArgsItem, "toolName" | "args" | "calls" | "strings">): string =>
	`${toolLabel({ toolName: item.toolName, args: item.args })}${item.calls > 1 ? ` +${item.calls - 1} call${item.calls > 2 ? "s" : ""}` : ""} (${item.strings === 1 ? "1 arg" : `${item.strings} args`})`;

/**
 * What `recall` returns for an assistant entry: its tool calls with their original arguments. String
 * arguments are shown as they are (a written file stays readable line by line), other values as JSON.
 */
export function originalCalls(message: MessageLike): string {
	const calls = Array.isArray(message.content) ? message.content.filter((b) => b.type === "toolCall") : [];
	return calls
		.map((b) => {
			const args = b.arguments && typeof b.arguments === "object" ? Object.entries(b.arguments as Record<string, unknown>) : [];
			return [`[tool call] ${String(b.name ?? "tool")}`, ...args.map(([k, v]) => `--- ${k} ---\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`)].join("\n");
		})
		.join("\n\n");
}
