/**
 * E2E helper: API-validity probe for omitted exchanges. When the run of turn CG_OMIT_AT_TURN settles,
 * it omits the session's first exchange the way context-guard does: the user prompt becomes a one-line
 * stub, every other entry of the exchange gets `replacement: null`. The next turn then sends a stub user
 * message directly followed by the next user message, with the assistant and tool-result messages gone.
 *
 *   CG_OMIT_AT_TURN=2 node test/e2e/run-e2e.mjs --model … --no-guard --ext test/e2e/omit-probe.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function omitProbe(pi: ExtensionAPI) {
	const at = process.env.CG_OMIT_AT_TURN;
	if (!at || process.env.CG_TURN !== at) return;
	pi.on("agent_before_settle", async (event, ctx) => {
		const branch = ctx.sessionManager.getBranch() as unknown as { type: string; id: string; message?: { role: string } }[];
		const users = branch.filter((e) => e.type === "message" && e.message?.role === "user");
		if (users.length < 2) return;
		const start = branch.indexOf(users[0]);
		const end = branch.indexOf(users[1]);
		const drafts: unknown[] = [];
		for (const entry of branch.slice(start, end)) {
			if (entry === users[0]) {
				drafts.push({ type: "context_edit", targetId: entry.id, replacement: { content: [{ type: "text", text: "[context-guard] Omitted an earlier exchange judged unrelated to the current work: \"probe\" (n messages). Full exchange: recall({\"entryId\":\"" + entry.id + "\"})." }] } });
			} else if (entry.type === "message" || entry.type === "custom_message") {
				drafts.push({ type: "context_edit", targetId: entry.id, replacement: null });
			}
		}
		process.stderr.write(`omit-probe: omitting ${drafts.length} entries of the first exchange\n`);
		return { entries: [...event.entries, ...(drafts as never[])] };
	});
}
