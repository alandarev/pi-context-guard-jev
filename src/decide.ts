/**
 * Ask Jev which parts of one tool output are still needed (see docs/DESIGN.md).
 *
 * Answers are applied in this order:
 *   1. keep_whole — is the complete output still needed? (coarse)
 *   2. focus      — does the answer draw on most of the output, or on a few chunks (naming the key one)? (choice: whole / none / chunk_N)
 *   3. chunk_N    — is this chunk needed? (one yes/no per chunk)
 *
 * All three go in ONE System One request: the state (the expensive part) is billed once and
 * the answers match separate requests (measured, see docs/JEV.md). `focus` is single-choice, so it
 * can only name the most important chunk; the per-chunk yes/no questions add the others.
 */
import type { Chunk } from "./chunk.ts";
import type { CheckpointCandidate, CheckpointInfo } from "./checkpoint.ts";
import { recentNotes } from "./checkpoint.ts";
import { type Candidate, hasHistory, type RunHistory, type RunInfo } from "./run.ts";
import { type ClassifierQuestion, type ClassifierRequest, type ClassifierResponse, clip } from "./types.ts";

export interface DecideThresholds {
	keepWholeThreshold: number;
	focusWholeThreshold: number;
	chunkKeepThreshold: number;
	noneThreshold: number;
}

export type SegmentDecision =
	| { kind: "keep-all"; reason: "whole-needed" | "whole-chosen" | "no-answer" | "error" | "oversize"; detail?: string }
	| { kind: "select"; keep: Set<number>; reason: "chunks" | "none-needed" };

const QUESTION_LIMIT = 4_000;
const ANSWER_LIMIT = 6_000;
const NOTES_LIMIT = 2_000;
const ARGS_LIMIT = 600;

export const chunkLabel = (chunk: Chunk): string => `chunk_${chunk.index + 1}`;

function describeArgs(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const json = JSON.stringify(args);
	return json.length > ARGS_LIMIT ? `${json.slice(0, ARGS_LIMIT)}…` : json;
}

/** `earlier_conversation` state value: only the parts that are present. */
function describeHistory(history: RunHistory): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (history.summary) out.summary = history.summary;
	if (history.firstRequest) out.first_request = history.firstRequest;
	if (history.exchanges.length > 0) {
		out.recent_exchanges = history.exchanges.map((exchange) => (exchange.assistant ? { user: exchange.user, assistant: exchange.assistant } : { user: exchange.user }));
	}
	return out;
}

export function buildRequest(
	run: Pick<RunInfo, "question" | "answer" | "notes" | "history">,
	candidate: Candidate,
	segment: readonly Chunk[],
	segmentIndex: number,
	segmentCount: number,
	totalLines: number,
): ClassifierRequest {
	const withHistory = hasHistory(run.history);
	const state: Record<string, unknown> = {
		situation:
			"A coding agent answered user_question. To do so it called tools; this is the output of one call, split into chunks. " +
			"From now on the agent will only see the chunks we keep, plus a note that the rest was removed and can be fetched again." +
			(withHistory ? " earlier_conversation shows the session so far: the agent is likely to continue that work." : ""),
	};
	if (hasHistory(run.history)) state.earlier_conversation = describeHistory(run.history);
	state.user_question = clip(run.question, QUESTION_LIMIT);
	state.final_answer = clip(run.answer, ANSWER_LIMIT);
	if (run.notes.trim()) state.agent_notes_during_the_run = clip(run.notes, NOTES_LIMIT);
	state.tool = candidate.toolName;
	if (candidate.isError) {
		state.tool_status =
			"failed (the tool reported an error, e.g. a non-zero exit code). If final_answer shows the agent got past this failure, its details are usually no longer needed.";
	}
	const args = describeArgs(candidate.args);
	if (args) state.tool_arguments = args;
	state.output_size = `${totalLines} lines${segmentCount > 1 ? `; this is part ${segmentIndex + 1} of ${segmentCount}` : ""}`;
	state.chunks = Object.fromEntries(segment.map((chunk) => [chunkLabel(chunk), chunk.text]));

	const scope = segmentCount > 1 ? "this part of the tool output" : "the tool output";
	const focusCriteria: Record<string, string> = {
		whole: `Most of ${scope} is needed: the answer draws on many of its chunks`,
		none: `Nothing in ${scope} is needed any more`,
	};
	for (const chunk of segment) {
		const label = chunkLabel(chunk);
		focusCriteria[label] = `A few chunks are needed; ${label} is the most important of them`;
	}

	// Without history the wording is exactly the tuned single-run wording (docs/JEV.md).
	const followUp = withHistory ? "the ongoing work in earlier_conversation or a likely follow-up" : "a likely follow-up question";
	const questions: Record<string, ClassifierQuestion> = {
		keep_whole: {
			type: "bool",
			instructions:
				`Is all of ${scope} still needed, so that removing any chunk would lose evidence that final_answer relies on ` +
				`or information ${followUp} would need?`,
			criteria: { true: "Keep everything", false: "Some chunks are noise for this answer and can be removed" },
		},
		focus: {
			type: "choice",
			instructions:
				(withHistory
					? `Do final_answer and the ongoing work in earlier_conversation draw on most of ${scope}, or on a few chunks? `
					: `Does final_answer draw on most of ${scope}, or does it rest on a few chunks? `) +
				"If a few, pick the most important chunk. If nothing in it matters any more, pick none.",
			criteria: focusCriteria,
		},
	};
	for (const chunk of segment) {
		const label = chunkLabel(chunk);
		questions[label] = {
			type: "bool",
			instructions: withHistory
				? `Does ${label} contain lines that final_answer relies on, or that the user's ongoing task in earlier_conversation will need, even if the current question is about something else?`
				: `Does ${label} contain lines that final_answer relies on, or that a likely follow-up question about it would need?`,
			criteria: { true: `Keep ${label}`, false: `${label} is noise for this answer` },
		};
	}
	return { state, questions };
}

const PROGRESS_LIMIT = 2_000;

/**
 * Request for a mid-run checkpoint: there is no final answer yet, so Jev judges whether the agent
 * will still need the output to finish the task (docs/JEV.md → Checkpoint wording). The run-end
 * wording in `buildRequest` is untouched.
 */
export function buildCheckpointRequest(
	info: Pick<CheckpointInfo, "question" | "history" | "latest" | "notes">,
	candidate: CheckpointCandidate,
	segment: readonly Chunk[],
	segmentIndex: number,
	segmentCount: number,
	totalLines: number,
): ClassifierRequest {
	const withHistory = hasHistory(info.history);
	const state: Record<string, unknown> = {
		situation:
			"A coding agent is still working on user_question; it has not finished yet. This is the output of one of its earlier tool " +
			"calls, split into chunks. From now on the agent will only see the chunks we keep, plus a note that the rest was removed " +
			"and can be fetched again. later_tool_calls shows what the agent did after this call." +
			(withHistory ? " earlier_conversation shows the session before this task." : ""),
	};
	if (withHistory) state.earlier_conversation = describeHistory(info.history);
	state.user_question = clip(info.question, QUESTION_LIMIT);
	const progress: Record<string, string> = {};
	if (info.latest.trim()) progress.latest_note = clip(info.latest, PROGRESS_LIMIT);
	if (info.notes.trim()) progress.earlier_notes = recentNotes(info.notes, PROGRESS_LIMIT);
	if (Object.keys(progress).length > 0) state.agent_progress = progress;
	state.later_tool_calls = candidate.laterCalls.length > 0 ? candidate.laterCalls : "none yet";
	if (candidate.superseded) state.superseded = candidate.superseded;
	state.tool = candidate.toolName;
	if (candidate.isError) state.tool_status = "failed (the tool reported an error, e.g. a non-zero exit code).";
	const args = describeArgs(candidate.args);
	if (args) state.tool_arguments = args;
	state.output_size = `${totalLines} lines${segmentCount > 1 ? `; this is part ${segmentIndex + 1} of ${segmentCount}` : ""}`;
	state.chunks = Object.fromEntries(segment.map((chunk) => [chunkLabel(chunk), chunk.text]));

	const scope = segmentCount > 1 ? "this part of the tool output" : "the tool output";
	const focusCriteria: Record<string, string> = {
		whole: `Most of ${scope} will still be needed`,
		none: `Nothing in ${scope} will be needed again`,
	};
	for (const chunk of segment) {
		const label = chunkLabel(chunk);
		focusCriteria[label] = `A few chunks will still be needed; ${label} is the most important of them`;
	}
	const questions: Record<string, ClassifierQuestion> = {
		keep_whole: {
			type: "bool",
			instructions: `To finish user_question, will the agent still need all of ${scope}, so that removing any chunk would lose information it is likely to use again?`,
			criteria: { true: "Keep everything", false: "Some chunks will not be needed again and can be removed" },
		},
		focus: {
			type: "choice",
			instructions:
				`Will the rest of the agent's work draw on most of ${scope}, or on a few chunks? If a few, pick the most important chunk. ` +
				"If nothing in it will be needed again (for example because it is out of date or the agent has moved past it), pick none.",
			criteria: focusCriteria,
		},
	};
	for (const chunk of segment) {
		const label = chunkLabel(chunk);
		questions[label] = {
			type: "bool",
			instructions: `To finish user_question, will the agent still need the lines in ${label}? Lines that are out of date or that the agent has already acted on and moved past are not needed.`,
			criteria: { true: `Keep ${label}`, false: `${label} will not be needed again` },
		};
	}
	return { state, questions };
}

/** Basenames and paths mentioned in the answer, for the citation safety net. */
export function citedFiles(answer: string, chunks: readonly Chunk[]): Set<number> {
	const keep = new Set<number>();
	for (const chunk of chunks) {
		for (const file of chunk.files) {
			const base = file.split("/").at(-1) ?? file;
			// Paths and basenames (≥ 4 chars) must not be part of a longer name (`a.ts` ≠ `a.tsx`).
			if (mentions(answer, file) || (base.length >= 4 && mentions(answer, base))) {
				keep.add(chunk.index);
				break;
			}
		}
	}
	return keep;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const mentions = (answer: string, name: string): boolean => new RegExp(`(^|[^\\w.-])${escapeRegExp(name)}($|[^\\w-])`).test(answer);

const probabilityOf = (response: ClassifierResponse, id: string): number | undefined => {
	const answer = response.answers[id];
	return answer?.type === "bool" ? answer.probability : undefined;
};

export function interpret(response: ClassifierResponse, segment: readonly Chunk[], thresholds: DecideThresholds): SegmentDecision {
	if (response.stopReason !== "stop") return { kind: "keep-all", reason: "error", detail: response.errorMessage };

	const keepWhole = probabilityOf(response, "keep_whole");
	const focus = response.answers.focus;
	if (keepWhole === undefined || focus?.type !== "choice") return { kind: "keep-all", reason: "no-answer" };

	// 1. Coarse: the whole output is needed.
	if (keepWhole >= thresholds.keepWholeThreshold) return { kind: "keep-all", reason: "whole-needed" };
	// 2. Jev says the answer draws on most of the output. A weak "whole" (it often splits the vote
	//    with the key chunk) falls through to the per-chunk answers; maxKeepRatio still keeps the
	//    result untouched if most chunks turn out to be needed.
	if (focus.choice === "whole" && (focus.probabilities.whole ?? 0) >= thresholds.focusWholeThreshold) {
		return { kind: "keep-all", reason: "whole-chosen" };
	}

	// 3. The chunk Jev named, plus every chunk that passes its own yes/no question.
	const keep = new Set<number>();
	for (const chunk of segment) {
		const p = probabilityOf(response, chunkLabel(chunk));
		if (p !== undefined && p >= thresholds.chunkKeepThreshold) keep.add(chunk.index);
		if (focus.choice === chunkLabel(chunk)) keep.add(chunk.index);
	}
	if (focus.choice === "none" && keep.size === 0 && (focus.probabilities.none ?? 0) >= thresholds.noneThreshold) {
		return { kind: "select", keep, reason: "none-needed" };
	}
	if (keep.size === 0 && focus.choice === "whole") return { kind: "keep-all", reason: "whole-chosen" };
	if (keep.size === 0) {
		// Jev picked "none" without conviction: keep its best chunk rather than nothing.
		const best = segment
			.map((chunk) => ({ chunk, p: focus.probabilities[chunkLabel(chunk)] ?? 0 }))
			.sort((a, b) => b.p - a.p)[0];
		if (best) keep.add(best.chunk.index);
	}
	return { kind: "select", keep, reason: "chunks" };
}
