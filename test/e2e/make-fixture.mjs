#!/usr/bin/env node
/**
 * Generate a deterministic fake web-app repository for live end-to-end tests.
 *
 * The app has a `StatusBadge` UI component used in a handful of places, hidden among lots of
 * other "status" mentions (a similar `StatusBar`, reducers, API code, logs, JSON fixtures), so a
 * broad search for "status" returns a large, mostly irrelevant tool output.
 *
 *   node test/e2e/make-fixture.mjs <targetDir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const target = process.argv[2];
if (!target) {
	console.error("usage: make-fixture.mjs <targetDir>");
	process.exit(2);
}

let seed = 42;
const rand = () => {
	seed = (seed * 1103515245 + 12345) % 2 ** 31;
	return seed / 2 ** 31;
};
const pick = (list) => list[Math.floor(rand() * list.length)];

const files = new Map();
const put = (path, text) => files.set(path, `${text.trimEnd()}\n`);

// --- The component under investigation -----------------------------------------------------
put(
	"src/components/StatusBadge.tsx",
	`import React from "react";
import "./StatusBadge.css";

export type BadgeTone = "neutral" | "success" | "warning" | "danger";

export interface StatusBadgeProps {
  label: string;
  tone?: BadgeTone;
  pulse?: boolean;
}

/** Small coloured pill that shows the state of an entity. */
export function StatusBadge({ label, tone = "neutral", pulse = false }: StatusBadgeProps) {
  return (
    <span className={\`status-badge status-badge--\${tone}\${pulse ? " status-badge--pulse" : ""}\`}>
      {label}
    </span>
  );
}
`,
);
put(
	"src/components/StatusBadge.css",
	`.status-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
.status-badge--neutral { background: #eee; color: #333; }
.status-badge--success { background: #e3f9e5; color: #1f7a33; }
.status-badge--warning { background: #fff4d6; color: #8a5a00; }
.status-badge--danger { background: #fde2e1; color: #a21b16; }
.status-badge--pulse { animation: pulse 1.2s infinite; }`,
);

// --- Real usages (the answer) ------------------------------------------------------------------
const usages = [
	["src/pages/OrdersPage.tsx", `<StatusBadge label={order.status} tone={order.status === "failed" ? "danger" : "success"} />`, "OrdersPage"],
	["src/pages/ServerListPage.tsx", `<StatusBadge label={server.health} tone="warning" pulse={server.degraded} />`, "ServerListPage"],
	["src/widgets/DeploymentCard.tsx", `<StatusBadge label="Rolled back" tone="danger" />`, "DeploymentCard"],
	["src/widgets/InvoiceRow.tsx", `<StatusBadge label={invoice.paid ? "Paid" : "Due"} tone={invoice.paid ? "success" : "warning"} />`, "InvoiceRow"],
	["src/admin/UserTable.tsx", `<StatusBadge label={user.active ? "Active" : "Suspended"} tone={user.active ? "neutral" : "danger"} />`, "UserTable"],
];
for (const [path, jsx, name] of usages) {
	const depth = path.split("/").length - 2;
	const rel = `${"../".repeat(depth)}components/StatusBadge`;
	const body = [];
	body.push(`import React from "react";`, `import { StatusBadge } from "${rel.startsWith(".") ? rel : `./${rel}`}";`, `import { formatDate } from "${"../".repeat(depth)}lib/format";`, "");
	body.push(`export function ${name}(props: any) {`);
	for (let i = 0; i < 25; i++) body.push(`  // layout helper ${i}: spacing, grid and responsive tweaks for ${name}`);
	body.push(`  const { order, server, invoice, user } = props;`, "  return (", `    <div className="${name.toLowerCase()}">`, `      <h3>{formatDate(new Date())}</h3>`, `      ${jsx}`, "    </div>", "  );", "}");
	put(path, body.join("\n"));
}

// --- Look-alikes and noise -------------------------------------------------------------------
put(
	"src/components/StatusBar.tsx",
	`import React from "react";
/** Bottom bar of the main window; unrelated to StatusBadge despite the name. */
export function StatusBar({ text }: { text: string }) {
  return <footer className="status-bar">{text}</footer>;
}`,
);
put(
	"src/layout/AppShell.tsx",
	`import React from "react";
import { StatusBar } from "../components/StatusBar";
export function AppShell({ children }: any) {
  return (<div>{children}<StatusBar text="Connected" /></div>);
}`,
);

const nouns = ["order", "server", "invoice", "user", "deployment", "job", "payment", "ticket", "build", "shipment"];
const states = ["pending", "active", "failed", "done", "paused", "retrying", "archived"];
for (const noun of nouns) {
	const lines = [`// ${noun} status handling`, `export type ${noun[0].toUpperCase() + noun.slice(1)}Status = ${states.map((s) => `"${s}"`).join(" | ")};`, ""];
	lines.push(`export function ${noun}StatusReducer(state: any, action: any) {`);
	for (let i = 0; i < 10; i++) {
		const s = pick(states);
		lines.push(`  if (action.type === "${noun}/${s}/${i}") return { ...state, status: "${s}", statusChangedAt: Date.now() };`);
	}
	lines.push("  return state;", "}");
	put(`src/store/${noun}StatusReducer.ts`, lines.join("\n"));

	const api = [`// REST client for ${noun}s`, `export async function fetch${noun[0].toUpperCase() + noun.slice(1)}Status(id: string) {`];
	for (let i = 0; i < 8; i++) api.push(`  // retry ${i}: if response.status === ${pick([429, 500, 502, 503])} wait and poll /api/${noun}s/{id}/status again`);
	api.push(`  const res = await fetch(\`/api/${noun}s/\${id}/status\`);`, `  if (res.status !== 200) throw new Error("status " + res.status);`, "  return res.json();", "}");
	put(`src/api/${noun}Status.ts`, api.join("\n"));
}

const log = [];
for (let i = 0; i < 70; i++) {
	const noun = pick(nouns);
	log.push(`2026-10-0${1 + (i % 5)}T1${i % 10}:0${i % 6}:${String(i % 60).padStart(2, "0")}Z worker-${i % 7} ${noun} ${i} status=${pick(states)} http_status=${pick([200, 201, 429, 500])}`);
}
put("logs/worker.log", log.join("\n"));

const fixtures = [];
for (let i = 0; i < 40; i++) fixtures.push(`  { "id": ${i}, "kind": "${pick(nouns)}", "status": "${pick(states)}", "statusNote": "seeded" }`);
put("test/fixtures/entities.json", `[\n${fixtures.join(",\n")}\n]`);

put(
	"README.md",
	`# acme-dashboard

Internal dashboard. UI components live in \`src/components\`; pages in \`src/pages\`; admin views in \`src/admin\`.
The status of orders, servers and invoices is fetched from the REST API (\`src/api\`) and kept in reducers (\`src/store\`).`,
);
put("src/lib/format.ts", `export const formatDate = (d: Date) => d.toISOString().slice(0, 10);`);

for (const [path, text] of files) {
	const full = join(target, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}
console.log(`wrote ${files.size} files to ${target}`);
