/**
 * E2E helper for the "long" scenario: strip pipes and filters after `npm test` in bash commands,
 * so every suite run returns its full log (as the prompt asks, and as GPT does on its own).
 * Claude tends to append `| grep …` or `| head`, which keeps its outputs too small for mid-run
 * checkpoints to matter. Load it with `--ext test/e2e/plain-test-runs.ts`; the run summary
 * counts how many commands it rewrote (stderr line "plain-test-runs:").
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** `npm test …| grep x; next` → `npm test …; next` (only the pipe that follows the test command). */
export function stripTestPipes(command: string): string {
	let out = command;
	const re = /\bnpm (?:run )?test\b/g;
	for (let match = re.exec(out); match; match = re.exec(out)) {
		let i = match.index + match[0].length;
		// Scan to the end of this simple command; `>&` (as in 2>&1) is a redirect, not a separator.
		while (i < out.length && out[i] !== "\n" && out[i] !== ";" && out[i] !== "|" && !(out[i] === "&" && out[i - 1] !== ">")) i++;
		if (out[i] !== "|" || out[i + 1] === "|") continue;
		let end = i;
		while (end < out.length && out[end] !== "\n" && out[end] !== ";" && !(out[end] === "&" && out[end + 1] === "&")) end++;
		out = `${out.slice(0, i).trimEnd()}${end < out.length ? ` ${out.slice(end).trimStart()}` : ""}`;
		re.lastIndex = i;
	}
	return out;
}

export default function plainTestRuns(pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		const input = event.input as { command?: unknown };
		if (typeof input.command !== "string") return;
		const rewritten = stripTestPipes(input.command);
		if (rewritten !== input.command) {
			process.stderr.write(`plain-test-runs: ${JSON.stringify(input.command)} -> ${JSON.stringify(rewritten)}\n`);
			input.command = rewritten;
		}
	});
}
