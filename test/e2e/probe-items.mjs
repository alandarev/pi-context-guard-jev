#!/usr/bin/env node
/**
 * Offline Jev probe for whole-item questions (docs/JEV.md → Old exchanges, Small outputs).
 *
 *   node test/e2e/probe-items.mjs [--reps 2] [--sessions <e2e out dir>...]
 *
 * Exchanges: the hand-written sessions in test/e2e/probe-data/exchanges.json, plus, for every
 * `--sessions` directory of a no-guard `topics` e2e run (public fixture), the exchanges eligible at
 * prompts 4 and 5 (labels: task 1 is relevant to prompt 5 only). Small outputs:
 * test/e2e/probe-data/small.json. Prints P per item and the accuracy per threshold. Needs
 * OPENROUTER_API_KEY; sends only this synthetic or fixture content.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildExchangeRequest, buildSmallRequest, collectExchanges, exchangeLabel, itemLabel } from "../../src/items.ts";
import { collectHistory } from "../../src/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const reps = Number(args[args.indexOf("--reps") + 1] || 2);
const sessionDirs = args.flatMap((a, i) => (args[i - 1] === "--sessions" ? [a] : []));
const key = process.env.OPENROUTER_API_KEY;

async function classify(request) {
	const wire = { model: "~typesafe/jev-latest", state: request.state, questions: Object.fromEntries(Object.entries(request.questions).map(([k, q]) => [k, q.type === "bool" ? { ...q, type: "noul" } : q])) };
	const res = await fetch("https://openrouter.ai/api/v1/systemone", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(wire) });
	const body = await res.json();
	if (!res.ok) throw new Error(JSON.stringify(body).slice(0, 300));
	return { p: Object.fromEntries(Object.entries(body.answers).map(([k, a]) => [k, a.noul])), tokens: body.usage.input_tokens, cost: body.usage.cost ?? 0 };
}

const results = { exchanges: [], small: [] };
let cost = 0;

// --- exchanges --------------------------------------------------------------------------------
const exchangeCases = [];
for (const s of JSON.parse(readFileSync(join(HERE, "probe-data/exchanges.json"), "utf8")).sessions) {
	exchangeCases.push({ name: s.name, work: { question: s.current.question, history: { exchanges: [] }, latest: s.current.latest }, items: s.exchanges });
}
const findJsonl = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? findJsonl(p) : n.endsWith(".jsonl") ? [p] : []; });
for (const dir of sessionDirs) {
	const entries = readFileSync(findJsonl(join(dir, "sessions"))[0], "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "message");
	const projected = entries.map((e) => ({ sourceEntry: e, messages: [e.message] }));
	const users = projected.map((e, i) => (e.messages[0].role === "user" ? i : -1)).filter((i) => i >= 0);
	for (const prompt of [4, 5]) {
		const runStart = users[prompt - 1];
		if (runStart === undefined) continue;
		const items = collectExchanges(projected, runStart, 2, new Set()).map((x) => ({ ...x, label: prompt === 5 && x.prompt.includes("retry on HTTP 503") ? "relevant" : "unrelated" }));
		const question = projected[runStart].messages[0].content.map((b) => b.text).join("");
		exchangeCases.push({ name: `${dir.split("/").at(-1).slice(20, 40)} prompt ${prompt}`, work: { question, history: collectHistory(projected.slice(0, runStart), 3), latest: "" }, items });
	}
}
for (const c of exchangeCases) {
	for (let r = 0; r < reps; r++) {
		const { p, cost: c1 } = await classify(buildExchangeRequest(c.work, c.items));
		cost += c1;
		c.items.forEach((item, i) => results.exchanges.push({ case: c.name, rep: r, label: item.label, prompt: item.prompt.slice(0, 50), p: p[exchangeLabel(i)] }));
	}
}

// --- small outputs ----------------------------------------------------------------------------
for (const s of JSON.parse(readFileSync(join(HERE, "probe-data/small.json"), "utf8")).states) {
	const items = s.items.map((it, i) => ({ entryId: `s${i}`, toolName: it.tool, args: it.args, text: it.output, turn: 0, label: it.label }));
	for (let r = 0; r < reps; r++) {
		const { p, cost: c1 } = await classify(buildSmallRequest({ question: s.question, history: { exchanges: [] }, latest: s.latest }, items));
		cost += c1;
		items.forEach((item, i) => results.small.push({ case: s.name, rep: r, label: item.label, tool: `${item.toolName} ${JSON.stringify(item.args).slice(0, 40)}`, p: p[itemLabel(i)] }));
	}
}

const accuracy = (rows, positive, thresholds) =>
	thresholds.map((t) => {
		// Decision: keep when p ≥ t. Correct when keep ⇔ label is positive.
		const correct = rows.filter((r) => (r.p >= t) === (r.label === positive)).length;
		const lostPositives = rows.filter((r) => r.label === positive && r.p < t).length;
		const droppedNegatives = rows.filter((r) => r.label !== positive && r.p < t).length;
		return `t=${t}: accuracy ${correct}/${rows.length}, wrongly dropped ${lostPositives}/${rows.filter((r) => r.label === positive).length}, correctly dropped ${droppedNegatives}/${rows.filter((r) => r.label !== positive).length}`;
	});
for (const r of results.exchanges) console.log(`exchange ${r.case} rep${r.rep} ${r.label.padEnd(9)} p=${r.p?.toFixed(2)} ${r.prompt}`);
console.log(accuracy(results.exchanges, "relevant", [0.1, 0.2, 0.3, 0.4, 0.5]).join("\n"));
for (const r of results.small) console.log(`small ${r.case} rep${r.rep} ${r.label.padEnd(10)} p=${r.p?.toFixed(2)} ${r.tool}`);
console.log(accuracy(results.small, "needed", [0.3, 0.4, 0.5, 0.6, 0.7]).join("\n"));
console.log(`Jev cost: $${cost.toFixed(5)}`);
