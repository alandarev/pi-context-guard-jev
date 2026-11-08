/**
 * Jev health: when every Jev request of a pass fails (no credits, revoked key, provider outage), the
 * guard keeps every output and saves nothing. Without a signal the footer would just read "0 saved",
 * so the failure is surfaced in the status bar, a warning and `/guard status`, with the provider's error.
 *
 * Pure: index.ts holds the state and talks to Pi.
 */

/** HTTP statuses that will not fix themselves within a run: pause Jev requests for a while. */
const PERSISTENT_STATUSES = new Set([401, 402, 403]);
/** How long Jev requests are paused after a pass failed with a persistent status. */
export const JEV_PAUSE_MS = 5 * 60_000;
/** Most characters of the provider's error kept in a record. */
export const ERROR_MAX_CHARS = 400;

export interface JevFailure {
	/** HTTP status, when the error message carries one. */
	status?: number;
	/** Short reason for the status bar, e.g. "402 insufficient credits". */
	short: string;
	/** The provider's error message (clipped). */
	message: string;
	/** Requests that failed in the pass that set this. */
	failed: number;
	/** Jev requests are skipped until this time (ms since epoch); 0 = not paused. */
	pausedUntil: number;
}

/**
 * Short form of a classifier error message. Pi's System One provider reports
 * `System One API error (402): {"error":{"message":"Insufficient credits. Add more …","code":402}}`.
 */
export function summarizeJevError(message: string): { status?: number; short: string } {
	const statusMatch = message.match(/\((\d{3})\)/) ?? message.match(/"code"\s*:\s*(\d{3})/) ?? message.match(/\b(4\d\d|5\d\d)\b/);
	const status = statusMatch ? Number(statusMatch[1]) : undefined;
	const inner = message.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
	let text = (inner ?? message.replace(/^.*?API error \(\d{3}\):\s*/, "")).replace(/\\"/g, '"').replace(/\s+/g, " ").trim();
	// First sentence, lower-cased start: "Insufficient credits. Add more …" → "insufficient credits".
	text = text.split(/(?<=[a-z])\.\s/)[0].replace(/\.$/, "");
	if (text.length > 48) text = `${text.slice(0, 47)}…`;
	text = text.charAt(0).toLowerCase() + text.slice(1);
	const short = status ? `${status} ${text}`.trim() : text || "request failed";
	return { status, short };
}

/** Request tally of one pass (process.ts → ProcessOutcome). */
export interface RequestTally {
	/** Requests answered with `stopReason: "stop"`. */
	okRequests: number;
	/** Requests that failed with an error (not timeouts or aborts). */
	failedRequests: number;
	/** First error message of the pass. */
	error?: string;
}

/**
 * New failure state after a pass: a failure when requests failed and none succeeded, `undefined` once a
 * request succeeds again, `previous` unchanged when the pass says nothing (no requests, or only timeouts).
 */
export function nextJevFailure(previous: JevFailure | undefined, tally: RequestTally, now: number): JevFailure | undefined {
	if (tally.okRequests > 0) return undefined;
	if (tally.failedRequests === 0) return previous;
	const message = clipError(tally.error ?? "unknown error");
	const { status, short } = summarizeJevError(message);
	return { status, short, message, failed: tally.failedRequests, pausedUntil: status && PERSISTENT_STATUSES.has(status) ? now + JEV_PAUSE_MS : 0 };
}

/** Failure state from the last record on the branch (after a restart), never paused. */
export function failureFromRecord(record: { requests?: number; errors?: number; error?: string } | undefined): JevFailure | undefined {
	if (!record?.error || !record.errors || record.errors < (record.requests ?? 0)) return undefined;
	const { status, short } = summarizeJevError(record.error);
	return { status, short, message: record.error, failed: record.errors, pausedUntil: 0 };
}

export const clipError = (message: string): string => (message.length > ERROR_MAX_CHARS ? `${message.slice(0, ERROR_MAX_CHARS - 1)}…` : message);

/** Footer text for a failure: "Jev failing: 402 insufficient credits". */
export const failureStatus = (failure: JevFailure): string => `Jev failing: ${failure.short}`;

/** Warning text for a failure. */
export function failureWarning(failure: JevFailure, now: number): string {
	const paused = failure.pausedUntil > now ? ` Jev requests are paused for ${Math.round((failure.pausedUntil - now) / 60_000)} min (/guard reload retries now).` : "";
	return `every Jev request failed (${failure.failed}), so nothing is being distilled: ${failure.message}${paused}`;
}
