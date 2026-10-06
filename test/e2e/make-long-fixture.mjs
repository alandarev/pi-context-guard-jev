#!/usr/bin/env node
/**
 * Generate a deterministic Node project for the "long" e2e scenario: an autonomous
 * "fix all failing tests" task that takes many turns.
 *
 * - ~230 tests (node:test, spec reporter): a full run prints well over 10k characters, mostly
 *   verbose passing tests, so every rerun is a large, quickly superseded tool output.
 * - Three independent bugs in different modules, plus a cascade: one test fails first because of
 *   bug 2 and, once that is fixed, fails again because of bug 3.
 * - Large modules and generated data, so searches and reads are big.
 *
 *   node test/e2e/make-long-fixture.mjs <targetDir> [--fixed] [--bugs 1,2,…] [--name pkg] [--no-git]
 *
 * `--fixed` writes the bug-free version (used to check that the fixture is solvable).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const target = process.argv[2];
const fixed = process.argv.includes("--fixed");
// --bugs 1,4,7: only these bugs (default: all ten). --name: package name.
const bugsArg = process.argv.indexOf("--bugs");
const enabled = new Set(bugsArg > 0 ? process.argv[bugsArg + 1].split(",").map(Number) : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const nameArg = process.argv.indexOf("--name");
const pkgName = nameArg > 0 ? process.argv[nameArg + 1] : "ledgerly";
/** True when bug n is fixed in this fixture (not injected). */
const ok = (n) => fixed || !enabled.has(n);
if (!target) {
	console.error("usage: make-long-fixture.mjs <targetDir> [--fixed]");
	process.exit(2);
}
const files = new Map();
const put = (path, text) => files.set(path, `${text.trim()}\n`);

put(
	"package.json",
	JSON.stringify({ name: pkgName, version: "2.3.1", private: true, type: "module", scripts: { test: "node --test --test-reporter=spec test/*.test.js" } }, null, 2),
);
put(
	"README.md",
	`# ledgerly

Small accounting helpers for the order service: money arithmetic in integer cents (\`src/money\`),
business-day calendars (\`src/calendar\`), price lists and promotions (\`src/pricing\`), CSV import/export
(\`src/csv\`) and text helpers (\`src/text\`). Locale data lives in \`src/data\`.

Run the tests with \`npm test\`.`,
);

// ---------------------------------------------------------------------------------------------
// src/money/round.js  — bug 1: half-even rounding is wrong for negative amounts
// ---------------------------------------------------------------------------------------------
put(
	"src/money/round.js",
	`/**
 * Rounding helpers for integer-cent arithmetic.
 *
 * All money in ledgerly is kept as integer cents. Fractions only appear in intermediate results
 * (tax rates, ratios), and are rounded with banker's rounding (round half to even) so that
 * rounding errors do not accumulate in one direction over many line items.
 */

/** Round half to even ("banker's rounding") to an integer. */
export function roundHalfEven(value) {
  if (!Number.isFinite(value)) throw new RangeError("roundHalfEven: value must be finite");
${
	ok(1)
		? `  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);`
		: `  const sign = 1;
  const abs = value;`
}
  const floor = ${ok(1) ? "Math.floor(abs)" : "Math.trunc(abs)"};
  const diff = abs - floor;
  const EPS = 1e-9;
  let rounded;
  if (diff > 0.5 + EPS) rounded = floor + 1;
  else if (diff < 0.5 - EPS) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  return sign * rounded || 0;
}

/** Round half away from zero (used only for display of percentages). */
export function roundHalfUp(value) {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** Multiply cents by a rate and round with banker's rounding. */
export function mulCents(cents, rate) {
  if (!Number.isInteger(cents)) throw new TypeError("mulCents: cents must be an integer");
  return roundHalfEven(cents * rate);
}

/** Clamp a number into [min, max]. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}`,
);

put(
	"src/money/money.js",
	`/**
 * Money values: { cents, currency }. Arithmetic never mixes currencies.
 */
import { mulCents, roundHalfEven } from "./round.js";

export const CURRENCIES = {
  EUR: { symbol: "€", decimals: 2, symbolFirst: false },
  USD: { symbol: "$", decimals: 2, symbolFirst: true },
  GBP: { symbol: "£", decimals: 2, symbolFirst: true },
  JPY: { symbol: "¥", decimals: 0, symbolFirst: true },
  CHF: { symbol: "CHF", decimals: 2, symbolFirst: true },
};

export function money(cents, currency = "EUR") {
  if (!Number.isInteger(cents)) throw new TypeError(\`money: cents must be an integer, got \${cents}\`);
  if (!CURRENCIES[currency]) throw new RangeError(\`money: unknown currency \${currency}\`);
  return Object.freeze({ cents, currency });
}

function same(a, b) {
  if (a.currency !== b.currency) throw new Error(\`currency mismatch: \${a.currency} vs \${b.currency}\`);
}

export const add = (a, b) => (same(a, b), money(a.cents + b.cents, a.currency));
export const sub = (a, b) => (same(a, b), money(a.cents - b.cents, a.currency));
export const neg = (a) => money(-a.cents, a.currency);
export const isZero = (a) => a.cents === 0;
export const sum = (list, currency = "EUR") => list.reduce((acc, m) => add(acc, m), money(0, currency));

/** Multiply by a factor (e.g. a tax rate), rounding half to even. */
export const times = (a, factor) => money(mulCents(a.cents, factor), a.currency);

/** Percentage of an amount, e.g. pct(m, 19) for 19 %. */
export const pct = (a, percent) => times(a, percent / 100);

/**
 * Split an amount into parts proportional to \`ratios\`, without losing or inventing cents.
 * Leftover cents go to the parts with the largest remainders (ties: earlier parts first).
 */
export function allocate(a, ratios) {
  if (!ratios.length) throw new RangeError("allocate: no ratios");
  const total = ratios.reduce((x, y) => x + y, 0);
  if (total <= 0) throw new RangeError("allocate: ratios must sum to a positive number");
  const exact = ratios.map((r) => (a.cents * r) / total);
  const parts = exact.map((x) => Math.trunc(x));
  let left = a.cents - parts.reduce((x, y) => x + y, 0);
  const order = exact
    .map((x, i) => ({ i, rem: Math.abs(x - Math.trunc(x)) }))
    .sort((p, q) => q.rem - p.rem || p.i - q.i);
  const step = Math.sign(left);
  for (let k = 0; left !== 0; k++, left -= step) parts[order[k % order.length].i] += step;
  return parts.map((c) => money(c, a.currency));
}

/** Format for display, e.g. "€12.50" style per currency settings. */
export function format(a, { showCurrency = true } = {}) {
  const info = CURRENCIES[a.currency];
  const negative = a.cents < 0;
  const abs = Math.abs(a.cents);
  const units = info.decimals === 0 ? String(abs) : \`\${Math.floor(abs / 100)}.\${String(abs % 100).padStart(2, "0")}\`;
  const grouped = units.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
  const body = !showCurrency ? grouped : info.symbolFirst ? \`\${info.symbol}\${grouped}\` : \`\${grouped} \${info.symbol}\`;
  return negative ? \`-\${body}\` : body;
}

/** Parse "12.50" or "-3" into cents. */
export function parseAmount(text, currency = "EUR") {
  const m = /^\\s*(-)?(\\d+)(?:\\.(\\d{1,2}))?\\s*$/.exec(text);
  if (!m) throw new SyntaxError(\`parseAmount: not an amount: \${JSON.stringify(text)}\`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "0").${ok(10) ? "padEnd" : "padStart"}(2, "0"));
  return money(m[1] ? -cents : cents, currency);
}

export { roundHalfEven };`,
);

// ---------------------------------------------------------------------------------------------
// src/calendar/business-days.js  — bug 2: Sunday not treated as a weekend day
// ---------------------------------------------------------------------------------------------
put(
	"src/calendar/business-days.js",
	`/**
 * Business-day arithmetic in UTC. A business day is a weekday that is not a holiday of the
 * given calendar (see ./holidays.js).
 */
import { holidaysFor } from "./holidays.js";

const DAY = 24 * 60 * 60 * 1000;

export function parseDate(text) {
  const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(text);
  if (!m) throw new SyntaxError(\`parseDate: expected YYYY-MM-DD, got \${text}\`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCMonth() !== Number(m[2]) - 1) throw new RangeError(\`parseDate: invalid date \${text}\`);
  return d;
}

export const formatDate = (d) => d.toISOString().slice(0, 10);

export function isWeekend(d) {
  const day = d.getUTCDay();
${ok(2) ? "  return day === 6 || day === 0;" : "  return day === 6 || d.getUTCDay === 0;"}
}

export function isBusinessDay(d, calendar = "DE") {
  if (isWeekend(d)) return false;
  return !holidaysFor(calendar, d.getUTCFullYear()).has(formatDate(d));
}

/** Add n business days (n may be negative). Starting on a non-business day counts from the next one. */
export function addBusinessDays(d, n, calendar = "DE") {
  let current = new Date(d.getTime());
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    current = new Date(current.getTime() + step * DAY);
    if (isBusinessDay(current, calendar)) left--;
  }
  return current;
}

/** Business days in [from, to). */
export function businessDaysBetween(from, to, calendar = "DE") {
  let n = 0;
  for (let t = from.getTime(); t < to.getTime(); t += DAY) if (isBusinessDay(new Date(t), calendar)) n++;
  return n;
}

/** ISO 8601 week number. */
export function isoWeek(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / DAY + 1) / 7);
}

/** Last business day of a month (1-12). */
export function lastBusinessDay(year, month, calendar = "DE") {
  let d = new Date(Date.UTC(year, month, 0));
  while (!isBusinessDay(d, calendar)) d = new Date(d.getTime() - DAY);
  return d;
}`,
);

put(
	"src/calendar/holidays.js",
	`/**
 * Public holidays per calendar. Fixed dates plus Easter-based ones (Gauss/Meeus algorithm).
 */
const FIXED = {
  DE: ["01-01", "05-01", "10-03", "12-25", "12-26"],
  FR: ["01-01", "05-01", "05-08", "07-14", "08-15", "11-01", "11-11", "12-25"],
  UK: ["01-01", "12-25", "12-26"],
  US: ["01-01", "07-04", "11-11", "12-25"],
};
const EASTER_OFFSETS = { DE: [-2, 1, 39, ${ok(8) ? 50 : 49}], FR: [1, 39, 50], UK: [-2, 1], US: [] };

export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const cache = new Map();
export function holidaysFor(calendar, year) {
  const key = \`\${calendar}:\${year}\`;
  if (cache.has(key)) return cache.get(key);
  if (!FIXED[calendar]) throw new RangeError(\`unknown calendar \${calendar}\`);
  const set = new Set(FIXED[calendar].map((md) => \`\${year}-\${md}\`));
  const easter = easterSunday(year).getTime();
  for (const off of EASTER_OFFSETS[calendar]) set.add(new Date(easter + off * 864e5).toISOString().slice(0, 10));
  cache.set(key, set);
  return set;
}`,
);

// ---------------------------------------------------------------------------------------------
// src/csv/parse.js — bug 3: doubled quotes inside a quoted field are not unescaped
// ---------------------------------------------------------------------------------------------
put(
	"src/csv/parse.js",
	`/**
 * RFC 4180 CSV parsing: comma separator, CRLF or LF line ends, fields may be quoted with ",
 * and a quote inside a quoted field is written as two quotes ("").
 */
export function parseCsv(text, { header = true } = {}) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
${ok(3) ? `        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;` : `        inQuotes = false;`}
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\\n" || ch === "\\r") {
      if (ch === "\\r" && text[i + 1] === "\\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!header) return rows;
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1 || r[0] !== "").map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}`,
);
put(
	"src/csv/write.js",
	`/** Serialize rows (arrays or objects) as RFC 4180 CSV. */
export function quote(value) {
  const s = value == null ? "" : String(value);
  return /[",\\r\\n]/.test(s) ? \`"\${s.replaceAll('"', '""')}"\` : s;
}

export function toCsv(rows, columns) {
  if (!rows.length) return columns ? \`\${columns.map(quote).join(",")}\\n\` : "";
  const cols = columns ?? (Array.isArray(rows[0]) ? null : Object.keys(rows[0]));
  const lines = [];
  if (cols) lines.push(cols.map(quote).join(","));
  for (const r of rows) lines.push((cols ? cols.map((c) => r[c]) : r).map(quote).join(","));
  return \`\${lines.join("\\n")}\\n\`;
}`,
);

// ---------------------------------------------------------------------------------------------
// src/pricing/* — uses money, calendar and csv (the cascade lives here)
// ---------------------------------------------------------------------------------------------
put(
	"src/pricing/tax.js",
	`/** VAT per country, in percent. Reduced rates apply to the "reduced" category. */
import { money, pct, sub } from "../money/money.js";

export const VAT = {
  DE: { standard: 19, reduced: 7 },
  FR: { standard: 20, reduced: 5.5 },
  AT: { standard: 20, reduced: 10 },
  NL: { standard: 21, reduced: 9 },
  CH: { standard: 8.1, reduced: 2.6 },
};

export function vatRate(country, category = "standard") {
  const rates = VAT[country];
  if (!rates) throw new RangeError(\`no VAT rates for \${country}\`);
  return category === "reduced" ? rates.reduced : rates.standard;
}

/** VAT on a net amount (may be negative for refunds). */
export const vatOf = (net, country, category) => pct(net, vatRate(country, category));

/** Net amount contained in a gross amount: net = gross / (1 + rate). */
export function netOf(gross, country, category) {
  const rate = vatRate(country, category);
  const vat = money(Math.round((gross.cents * rate) / (100 + rate)), gross.currency);
  return sub(gross, vat);
}`,
);

put(
	"src/pricing/promotions.js",
	`/**
 * Promotions: a percentage discount valid for a number of business days from its start date.
 */
import { addBusinessDays, formatDate, parseDate } from "../calendar/business-days.js";
import { pct, sub } from "../money/money.js";

export function promotionWindow(promo, calendar = "DE") {
  const start = parseDate(promo.start);
  const end = addBusinessDays(start, promo.businessDays, calendar);
  return { start: formatDate(start), end: formatDate(end) };
}

export function isActive(promo, day, calendar = "DE") {
  const { start, end } = promotionWindow(promo, calendar);
  return day >= start && day < end;
}

export function applyPromotion(price, promo, day, calendar = "DE") {
  if (!isActive(promo, day, calendar)) return price;
  return sub(price, pct(price, promo.percent));
}`,
);

put(
	"src/pricing/price-list.js",
	`/**
 * Price lists: import from CSV (sku,name,price,currency,category[,promo_start,promo_days,promo_percent]),
 * look up and apply promotions.
 */
import { parseCsv } from "../csv/parse.js";
import { parseAmount } from "../money/money.js";
import { promotionWindow } from "./promotions.js";

export function importPriceList(csvText, { calendar = "DE" } = {}) {
  const rows = parseCsv(csvText);
  return rows.map((r) => {
    const item = {
      sku: r.sku.trim(),
      name: r.name,
      price: parseAmount(r.price, r.currency || "EUR"),
      category: r.category || "standard",
    };
    if (r.promo_start) {
      item.promotion = { start: r.promo_start, businessDays: Number(r.promo_days), percent: Number(r.promo_percent) };
      item.promotionWindow = promotionWindow(item.promotion, calendar);
    }
    return item;
  });
}

export function bySku(list) {
  return new Map(list.map((item) => [item.sku, item]));
}`,
);

put(
	"src/pricing/invoice.js",
	`/**
 * Invoices: lines with quantity and unit price, VAT per line, totals, and refunds.
 */
import { add, allocate, money, neg, sum, times } from "../money/money.js";
import { vatOf } from "./tax.js";

export function line(sku, unit, quantity, category = "standard") {
  return { sku, unit, quantity, category, net: times(unit, quantity) };
}

export function invoice(lines, country, currency = "EUR") {
  const withVat = lines.map((l) => ({ ...l, vat: vatOf(l.net, country, l.category) }));
  const net = sum(withVat.map((l) => l.net), currency);
  const vat = sum(withVat.map((l) => l.vat), currency);
  return { country, currency, lines: withVat, net, vat, gross: add(net, vat) };
}

/** A refund is an invoice with negated lines. */
export function refund(inv) {
  return invoice(inv.lines.map((l) => ({ ...l, net: neg(l.net) })), inv.country, inv.currency);
}

/** Split an invoice's gross amount across payment installments. */
export function installments(inv, n) {
  return allocate(inv.gross, Array.from({ length: n }, () => 1));
}

export const zero = (currency = "EUR") => money(0, currency);`,
);

// ---------------------------------------------------------------------------------------------
// src/reports/* — bug 4: import-time ReferenceError hides every report test; behind it bug 5
// (ledger sort), bug 6 (accounting format of negatives) and bug 7 (per-currency totals), where
// bug 7 is masked by bug 6 inside the same test.
// ---------------------------------------------------------------------------------------------
put(
	"src/reports/columns.js",
	`/** Column layout of the plain-text ledger report. */
${ok(4) ? "" : "export const WIDTHS = Object.fromEntries(COLUMNS.map((c) => [c.key, c.width]));\n"}export const COLUMNS = [
  { key: "date", title: "Date", width: 10, align: "left" },
  { key: "id", title: "Ref", width: 6, align: "left" },
  { key: "memo", title: "Memo", width: 28, align: "left" },
  { key: "amount", title: "Amount", width: 14, align: "right" },
  { key: "balance", title: "Balance", width: 14, align: "right" },
];
${ok(4) ? "export const WIDTHS = Object.fromEntries(COLUMNS.map((c) => [c.key, c.width]));\n" : ""}
export function cell(text, column) {
  const s = String(text);
  const clipped = s.length > column.width ? \`\${s.slice(0, column.width - 1)}…\` : s;
  return column.align === "right" ? clipped.padStart(column.width) : clipped.padEnd(column.width);
}`,
);
put(
	"src/reports/ledger.js",
	`/**
 * Ledger report: entries { id, date (YYYY-MM-DD), memo, amount (money) } sorted by date (then id),
 * with a running balance per currency, rendered as a fixed-width text table.
 *
 * Negative amounts use accounting notation: (12.50 €) instead of -12.50 €.
 */
import { add, format, money, neg } from "../money/money.js";
import { COLUMNS, cell } from "./columns.js";

export function buildLedger(entries) {
  const sorted = [...entries].sort(${ok(5) ? "(a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)" : "(a, b) => a.date - b.date || a.id.localeCompare(b.id)"});
  const balances = new Map();
  return sorted.map((e) => {
    const previous = balances.get(e.amount.currency) ?? money(0, e.amount.currency);
    const balance = add(previous, e.amount);
    balances.set(e.amount.currency, balance);
    return { ...e, balance };
  });
}

/** Accounting notation for display. */
export function accounting(m) {
  return m.cents < 0 ? ${ok(6) ? '"(" + format(neg(m)) + ")"' : '"(" + format(m) + ")"'} : format(m);
}

export function formatLedger(lines) {
  const header = COLUMNS.map((c) => cell(c.title, c)).join(" ");
  const rule = COLUMNS.map((c) => "-".repeat(c.width)).join(" ");
  const rows = lines.map((l) =>
    COLUMNS.map((c) => cell(c.key === "amount" || c.key === "balance" ? accounting(l[c.key]) : l[c.key], c)).join(" "),
  );
  return [header, rule, ...rows].join("\\n");
}

/** Totals per currency. */
export function summarize(lines) {
  const totals = {};
${
	ok(7)
		? `  for (const l of lines) totals[l.amount.currency] = add(totals[l.amount.currency] ?? money(0, l.amount.currency), l.amount);`
		: `  const zero = money(0, "EUR");
  for (const l of lines) totals[l.amount.currency] = add(totals[l.amount.currency] ?? zero, l.amount);`
}
  return Object.fromEntries(Object.entries(totals).map(([cur, m]) => [cur, accounting(m)]));
}`,
);

// ---------------------------------------------------------------------------------------------
// src/text/* and generated locale data (big files for reads/searches)
// ---------------------------------------------------------------------------------------------
put(
	"src/text/slug.js",
	`/** URL slugs and display helpers. */
const MAP = { ä: "ae", ö: "oe", ü: "ue", ß: "ss", é: "e", è: "e", à: "a", ç: "c", ñ: "n", ø: "o", å: "a" };
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[äöü${ok(9) ? "ß" : ""}éèàçñøå]/g, (c) => MAP[c])
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
export function truncate(text, max) {
  if (text.length <= max) return text;
  return \`\${text.slice(0, Math.max(0, max - 1)).trimEnd()}…\`;
}
export const titleCase = (text) => text.replace(/\\b\\w/g, (c) => c.toUpperCase());`,
);

let seed = 7;
const rand = () => {
	seed = (seed * 1103515245 + 12345) % 2 ** 31;
	return seed / 2 ** 31;
};
const pick = (list) => list[Math.floor(rand() * list.length)];
const words = ["amount", "round", "total", "price", "date", "invoice", "refund", "currency", "business", "holiday", "promo", "quote", "field"];
{
	const locales = ["de-DE", "de-AT", "de-CH", "fr-FR", "fr-CH", "en-GB", "en-US", "nl-NL", "it-IT", "es-ES", "pt-PT", "pl-PL", "cs-CZ", "da-DK", "sv-SE", "fi-FI"];
	const lines = ["/** Generated locale strings. Do not edit by hand. */", "export const MESSAGES = {"];
	for (const loc of locales) {
		lines.push(`  "${loc}": {`);
		for (let i = 0; i < 120; i++) {
			const a = pick(words);
			const b = pick(words);
			lines.push(`    "${a}.${b}.${i}": "${loc} ${a} ${b} label ${i}: the ${a} of the ${b} is rounded to the business date",`);
		}
		lines.push("  },");
	}
	lines.push("};");
	put("src/data/messages.js", lines.join("\n"));
}

// ---------------------------------------------------------------------------------------------
// Tests: many table-driven, verbosely named tests
// ---------------------------------------------------------------------------------------------
const halfEvenCases = [
	[0.5, 0], [1.5, 2], [2.5, 2], [3.5, 4], [4.4, 4], [4.6, 5], [10.5, 10], [11.5, 12], [99.5, 100], [100.49, 100],
	[-0.5, 0], [-1.5, -2], [-2.5, -2], [-3.4, -3], [-3.6, -4], [-10.5, -10],
];
put(
	"test/round.test.js",
	`import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clamp, mulCents, roundHalfEven, roundHalfUp } from "../src/money/round.js";

describe("roundHalfEven", () => {
  for (const [input, expected] of ${JSON.stringify(halfEvenCases.filter(([x]) => x >= 0))}) {
    test(\`rounds \${input} to \${expected} (half to even, positive amounts)\`, () => assert.equal(roundHalfEven(input), expected));
  }
  test("rejects NaN and infinities with a RangeError", () => {
    assert.throws(() => roundHalfEven(Number.NaN), RangeError);
    assert.throws(() => roundHalfEven(Number.POSITIVE_INFINITY), RangeError);
  });
});

describe("roundHalfUp", () => {
  for (const [input, expected] of [[0.5, 1], [1.5, 2], [2.5, 3], [-2.5, -3], [2.4, 2]]) {
    test(\`rounds \${input} to \${expected} (half away from zero, display only)\`, () => assert.equal(roundHalfUp(input), expected));
  }
});

describe("mulCents", () => {
  for (const [cents, rate, expected] of [[1000, 0.19, 190], [999, 0.19, 190], [1250, 0.07, 88], [5, 0.5, 2], [15, 0.5, 8], [0, 0.19, 0]]) {
    test(\`multiplies \${cents} cents by \${rate} giving \${expected}\`, () => assert.equal(mulCents(cents, rate), expected));
  }
  test("rejects non-integer cents with a TypeError", () => assert.throws(() => mulCents(1.5, 2), TypeError));
});

describe("clamp", () => {
  for (const [v, lo, hi, e] of [[5, 0, 10, 5], [-1, 0, 10, 0], [11, 0, 10, 10]]) {
    test(\`clamps \${v} into [\${lo}, \${hi}] as \${e}\`, () => assert.equal(clamp(v, lo, hi), e));
  }
});`,
);

put(
	"test/money.test.js",
	`import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { add, allocate, format, money, neg, parseAmount, pct, sub, sum, times } from "../src/money/money.js";

const cents = (list) => list.map((m) => m.cents);

describe("money basics", () => {
  test("creates frozen values with integer cents", () => assert.ok(Object.isFrozen(money(100))));
  test("rejects fractional cents", () => assert.throws(() => money(1.5), TypeError));
  test("rejects unknown currencies", () => assert.throws(() => money(1, "XXX"), RangeError));
  test("adds amounts of the same currency", () => assert.equal(add(money(150), money(250)).cents, 400));
  test("subtracts amounts of the same currency", () => assert.equal(sub(money(150), money(250)).cents, -100));
  test("refuses to add different currencies", () => assert.throws(() => add(money(1, "EUR"), money(1, "USD"))));
  test("negates an amount", () => assert.equal(neg(money(42)).cents, -42));
  test("sums a list of amounts", () => assert.equal(sum([money(1), money(2), money(3)]).cents, 6));
  for (const [c, f, e] of [[1000, 3, 3000], [333, 0.5, 166], [335, 0.5, 168], [-335, 0.5, -168], [-333, 0.5, -166]]) {
    test(\`times(\${c}, \${f}) is \${e} cents\`, () => assert.equal(times(money(c), f).cents, e));
  }
  for (const [c, p, e] of [[10000, 19, 1900], [1999, 19, 380], [-1999, 19, -380], [250, 7, 18], [-250, 7, -18]]) {
    test(\`pct(\${c}, \${p}%) is \${e} cents\`, () => assert.equal(pct(money(c), p).cents, e));
  }
});

describe("allocate", () => {
  const cases = [
    [100, [1, 1, 1], [34, 33, 33]],
    [101, [1, 1, 1], [34, 34, 33]],
    [5, [3, 7], [2, 3]],
    [1000, [1, 2, 3, 4], [100, 200, 300, 400]],
    [-100, [1, 1, 1], [-34, -33, -33]],
    [7, [1, 1, 1, 1], [2, 2, 2, 1]],
  ];
  for (const [amount, ratios, expected] of cases) {
    test(\`allocates \${amount} cents over \${JSON.stringify(ratios)} as \${JSON.stringify(expected)}\`, () => {
      const parts = allocate(money(amount), ratios);
      assert.deepEqual(cents(parts), expected);
      assert.equal(parts.reduce((n, m) => n + m.cents, 0), amount);
    });
  }
  test("rejects an empty ratio list", () => assert.throws(() => allocate(money(1), []), RangeError));
});

describe("format and parse", () => {
  const cases = [[money(1250, "EUR"), "12.50 €"], [money(1250, "USD"), "$12.50"], [money(-5, "GBP"), "-£0.05"], [money(123456789, "USD"), "$1,234,567.89"], [money(1500, "JPY"), "¥1,500"]];
  for (const [m, text] of cases) test(\`formats \${m.cents} \${m.currency} as \${text}\`, () => assert.equal(format(m), text));
  for (const [text, c] of [["12.50", 1250], ["-3", -300], ["0.5", 50], ["  7.05 ", 705]]) {
    test(\`parses \${JSON.stringify(text)} as \${c} cents\`, () => assert.equal(parseAmount(text).cents, c));
  }
  test("rejects malformed amounts", () => assert.throws(() => parseAmount("12,50"), SyntaxError));
});`,
);

const bdCases = [
	["2026-03-02", 1, "2026-03-03", "Monday + 1"],
	["2026-03-02", 5, "2026-03-09", "Monday + 5 skips the weekend"],
	["2026-03-06", 1, "2026-03-09", "Friday + 1 is the next Monday"],
	["2026-03-06", 2, "2026-03-10", "Friday + 2 is the next Tuesday"],
	["2026-03-07", 1, "2026-03-09", "Saturday + 1 is Monday"],
	["2026-03-08", 1, "2026-03-09", "Sunday + 1 is Monday"],
	["2026-03-09", -1, "2026-03-06", "Monday - 1 is the previous Friday"],
	["2026-04-02", 1, "2026-04-07", "Thursday before Easter + 1 skips Good Friday, the weekend and Easter Monday"],
	["2026-12-23", 2, "2026-12-28", "two days before Christmas skip the holidays"],
	["2025-10-02", 1, "2025-10-06", "German Unity Day (Friday) is skipped"],
];
put(
	"test/business-days.test.js",
	`import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addBusinessDays, businessDaysBetween, formatDate, isBusinessDay, isWeekend, isoWeek, lastBusinessDay, parseDate } from "../src/calendar/business-days.js";
import { easterSunday, holidaysFor } from "../src/calendar/holidays.js";

describe("addBusinessDays (DE calendar)", () => {
  for (const [start, n, expected, why] of ${JSON.stringify(bdCases)}) {
    test(\`\${start} \${n >= 0 ? "+" : ""}\${n} business days is \${expected} (\${why})\`, () => assert.equal(formatDate(addBusinessDays(parseDate(start), n)), expected));
  }
});

describe("weekends and holidays", () => {
  for (const [day, weekend] of [["2026-03-07", true], ["2026-03-04", false], ["2026-03-06", false], ["2026-03-09", false]]) {
    test(\`isWeekend(\${day}) is \${weekend}\`, () => assert.equal(isWeekend(parseDate(day)), weekend));
  }
  for (const [day, cal, business] of [["2026-10-03", "DE", false], ["2026-07-14", "FR", false], ["2026-07-14", "DE", true], ["2026-07-04", "US", false], ["2026-12-26", "UK", false]]) {
    test(\`\${day} is \${business ? "" : "not "}a business day in \${cal}\`, () => assert.equal(isBusinessDay(parseDate(day), cal), business));
  }
  for (const [year, easter] of [[2024, "2024-03-31"], [2025, "2025-04-20"], [2026, "2026-04-05"], [2027, "2027-03-28"], [2030, "2030-04-21"]]) {
    test(\`Easter Sunday \${year} is \${easter}\`, () => assert.equal(formatDate(easterSunday(year)), easter));
  }
  test("German holidays 2026 include Good Friday and Whit Monday", () => {
    const set = holidaysFor("DE", 2026);
    assert.ok(set.has("2026-04-03"));
    assert.ok(set.has("2026-05-25"));
  });
  test("unknown calendars are rejected", () => assert.throws(() => holidaysFor("XX", 2026), RangeError));
});

describe("calendar helpers", () => {
  for (const [day, week] of [["2026-01-01", 1], ["2026-03-06", 10], ["2026-12-31", 53], ["2027-01-04", 1]]) {
    test(\`ISO week of \${day} is \${week}\`, () => assert.equal(isoWeek(parseDate(day)), week));
  }
  for (const [y, m, e] of [[2026, 1, "2026-01-30"], [2026, 2, "2026-02-27"], [2026, 10, "2026-10-30"], [2026, 12, "2026-12-31"]]) {
    test(\`last business day of \${y}-\${m} is \${e}\`, () => assert.equal(formatDate(lastBusinessDay(y, m)), e));
  }
  test("counts business days in March 2026", () => assert.equal(businessDaysBetween(parseDate("2026-03-01"), parseDate("2026-04-01")), 22));
  test("parseDate rejects 2026-02-30", () => assert.throws(() => parseDate("2026-02-30"), RangeError));
  test("parseDate rejects other formats", () => assert.throws(() => parseDate("03/06/2026"), SyntaxError));
});`,
);

put(
	"test/csv.test.js",
	`import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseCsv } from "../src/csv/parse.js";
import { quote, toCsv } from "../src/csv/write.js";

describe("parseCsv", () => {
  test("parses a header and rows", () => assert.deepEqual(parseCsv("a,b\\n1,2\\n3,4\\n"), [{ a: "1", b: "2" }, { a: "3", b: "4" }]));
  test("handles CRLF line ends", () => assert.deepEqual(parseCsv("a,b\\r\\n1,2\\r\\n"), [{ a: "1", b: "2" }]));
  test("keeps commas inside quoted fields", () => assert.deepEqual(parseCsv('a,b\\n"x, y",2\\n'), [{ a: "x, y", b: "2" }]));
  test("keeps newlines inside quoted fields", () => assert.deepEqual(parseCsv('a\\n"line 1\\nline 2"\\n'), [{ a: "line 1\\nline 2" }]));
  test("returns raw rows without a header", () => assert.deepEqual(parseCsv("1,2\\n3,4", { header: false }), [["1", "2"], ["3", "4"]]));
  test("ignores a trailing empty line", () => assert.equal(parseCsv("a\\n1\\n\\n").length, 1));
  test("fills missing trailing fields with empty strings", () => assert.deepEqual(parseCsv("a,b,c\\n1\\n"), [{ a: "1", b: "", c: "" }]));
});

describe("toCsv", () => {
  for (const [v, e] of [["plain", "plain"], ["a,b", '"a,b"'], ['say "hi"', '"say ""hi"""'], [null, ""], [42, "42"]]) {
    test(\`quotes \${JSON.stringify(v)} as \${e}\`, () => assert.equal(quote(v), e));
  }
  test("writes objects with a header row", () => assert.equal(toCsv([{ a: 1, b: "x" }]), "a,b\\n1,x\\n"));
  test("writes arrays without a header", () => assert.equal(toCsv([[1, 2]]), "1,2\\n"));
});`,
);

put(
	"test/pricing.test.js",
	`import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { money } from "../src/money/money.js";
import { installments, invoice, line, refund } from "../src/pricing/invoice.js";
import { bySku, importPriceList } from "../src/pricing/price-list.js";
import { applyPromotion, isActive, promotionWindow } from "../src/pricing/promotions.js";
import { netOf, vatOf, vatRate } from "../src/pricing/tax.js";

describe("VAT", () => {
  for (const [country, cat, rate] of [["DE", "standard", 19], ["DE", "reduced", 7], ["FR", "reduced", 5.5], ["CH", "standard", 8.1], ["NL", "standard", 21]]) {
    test(\`VAT rate \${country}/\${cat} is \${rate}%\`, () => assert.equal(vatRate(country, cat), rate));
  }
  for (const [net, country, cat, vat] of [[10000, "DE", "standard", 1900], [1999, "DE", "standard", 380], [1250, "DE", "reduced", 88], [999, "FR", "reduced", 55]]) {
    test(\`VAT on \${net} cents in \${country}/\${cat} is \${vat}\`, () => assert.equal(vatOf(money(net), country, cat).cents, vat));
  }
  test("net of 119.00 gross in DE is 100.00", () => assert.equal(netOf(money(11900), "DE").cents, 10000));
  test("unknown countries are rejected", () => assert.throws(() => vatRate("XX"), RangeError));
});

describe("invoices", () => {
  const inv = invoice([line("A-1", money(1999), 3), line("B-2", money(450), 2, "reduced"), line("C-3", money(1250), 1)], "DE");
  test("invoice net is the sum of the line nets", () => assert.equal(inv.net.cents, 1999 * 3 + 450 * 2 + 1250));
  test("invoice VAT is computed per line and summed", () => assert.equal(inv.vat.cents, 1139 + 63 + 238));
  test("invoice gross is net plus VAT", () => assert.equal(inv.gross.cents, inv.net.cents + inv.vat.cents));
  test("a refund mirrors the invoice VAT exactly (negated)", () => {
    const r = refund(inv);
    assert.equal(r.net.cents, -inv.net.cents);
    assert.equal(r.vat.cents, -inv.vat.cents);
  });
  test("a refund of a half-cent VAT line is the exact negation", () => {
    const small = invoice([line("D-4", money(250), 1, "reduced")], "DE");
    assert.equal(refund(small).vat.cents, -small.vat.cents);
  });
  test("installments split the gross amount without losing cents", () => {
    const parts = installments(inv, 3);
    assert.equal(parts.reduce((n, m) => n + m.cents, 0), inv.gross.cents);
  });
});

describe("promotions", () => {
  const promo = { start: "2026-03-05", businessDays: 2, percent: 10 };
  test("a 2-business-day promotion from Thursday ends on Monday", () => assert.deepEqual(promotionWindow(promo), { start: "2026-03-05", end: "2026-03-09" }));
  test("the promotion is active on Friday", () => assert.equal(isActive(promo, "2026-03-06"), true));
  test("the promotion is not active on its end day", () => assert.equal(isActive(promo, "2026-03-09"), false));
  test("applying a 10% promotion to 19.99 gives 17.99", () => assert.equal(applyPromotion(money(1999), promo, "2026-03-06").cents, 1799));
});

describe("price list import", () => {
  const csv = [
    "sku,name,price,currency,category,promo_start,promo_days,promo_percent",
    'TB-01,"Tote bag, canvas",12.50,EUR,standard,,,',
    'MG-02,"Mug ""Ledgerly"" 300 ml",9.90,EUR,standard,2026-03-06,1,15',
    "BK-03,Book of numbers,24.00,EUR,reduced,,,",
  ].join("\\n");
  test("imports every row of the price list", () => assert.equal(importPriceList(csv).length, 3));
  test("parses prices into cents", () => assert.deepEqual(importPriceList(csv).map((i) => i.price.cents), [1250, 990, 2400]));
  test("imports a promotional item with its window and its exact name", () => {
    const mug = bySku(importPriceList(csv)).get("MG-02");
    assert.deepEqual(mug.promotionWindow, { start: "2026-03-06", end: "2026-03-09" });
    assert.equal(mug.name, 'Mug "Ledgerly" 300 ml');
  });
});`,
);

{
	const memos = ["Opening balance", "Office chairs", "Refund order 1182", "Cloud hosting", "Coffee beans", "Client payment", "Bank fees", "Train tickets"];
	const entries = [];
	for (let i = 0; i < 24; i++) {
		const day = String(1 + ((i * 7) % 28)).padStart(2, "0");
		const cents = (i % 3 === 0 ? -1 : 1) * (1000 + ((i * 3779) % 90000));
		entries.push({ id: `R${String(100 + i)}`, date: `2026-0${1 + (i % 3)}-${day}`, memo: memos[i % memos.length], cents, currency: i % 5 === 4 ? "USD" : "EUR" });
	}
	put(
		"test/fixtures/ledger-entries.json",
		JSON.stringify(entries, null, 2),
	);
}
put(
	"test/ledger.test.js",
	`import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { money } from "../src/money/money.js";
import { COLUMNS, WIDTHS, cell } from "../src/reports/columns.js";
import { accounting, buildLedger, formatLedger, summarize } from "../src/reports/ledger.js";

const raw = JSON.parse(readFileSync(new URL("./fixtures/ledger-entries.json", import.meta.url), "utf8"));
const entries = raw.map((e) => ({ ...e, amount: money(e.cents, e.currency) }));

describe("columns", () => {
  test("has five columns", () => assert.equal(COLUMNS.length, 5));
  for (const c of COLUMNS) test(\`column \${c.key} is \${c.width} wide\`, () => assert.equal(WIDTHS[c.key], c.width));
  test("right-aligned cells are padded on the left", () => assert.equal(cell("7", { width: 3, align: "right" }), "  7"));
  test("long cells are clipped with an ellipsis", () => assert.equal(cell("abcdefgh", { width: 5, align: "left" }), "abcd…"));
});

describe("buildLedger", () => {
  const ledger = buildLedger(entries);
  test("sorts entries by date, then by reference", () => {
    const keys = ledger.map((l) => \`\${l.date} \${l.id}\`);
    assert.deepEqual(keys, [...keys].sort());
  });
  test("keeps every entry", () => assert.equal(ledger.length, entries.length));
  for (const currency of ["EUR", "USD"]) {
    test(\`the final \${currency} balance is the sum of all \${currency} amounts\`, () => {
      const last = ledger.filter((l) => l.amount.currency === currency).at(-1);
      const total = entries.filter((e) => e.currency === currency).reduce((n, e) => n + e.cents, 0);
      assert.equal(last.balance.cents, total);
    });
  }
  test("running balances never skip an entry (EUR)", () => {
    const eur = ledger.filter((l) => l.amount.currency === "EUR");
    for (let i = 1; i < eur.length; i++) assert.equal(eur[i].balance.cents, eur[i - 1].balance.cents + eur[i].amount.cents);
  });
});

describe("accounting notation", () => {
  for (const [c, cur, text] of [[1250, "EUR", "12.50 €"], [-1250, "EUR", "(12.50 €)"], [-5, "USD", "($0.05)"], [0, "EUR", "0.00 €"], [-123456, "GBP", "(£1,234.56)"]]) {
    test(\`accounting(\${c} \${cur}) is \${text}\`, () => assert.equal(accounting(money(c, cur)), text));
  }
});

describe("ledger report", () => {
  test("renders a header, a rule and one row per entry", () => {
    const text = formatLedger(buildLedger(entries));
    assert.equal(text.split("\\n").length, entries.length + 2);
  });
  test("renders the first three rows exactly", () => {
    const sample = buildLedger(entries.slice(0, 3));
    assert.equal(
      formatLedger(sample),
      [
        "Date       Ref    Memo                                 Amount        Balance",
        "---------- ------ ---------------------------- -------------- --------------",
        "2026-01-01 R100   Opening balance                   (10.00 €)      (10.00 €)",
        "2026-02-08 R101   Office chairs                       47.79 €        37.79 €",
        "2026-03-15 R102   Refund order 1182                   85.58 €       123.37 €",
      ].join("\\n"),
    );
  });
  test("summarizes totals per currency in accounting notation", () => {
    const ledger = buildLedger(entries);
    assert.match(formatLedger(ledger), /\\(\\d/);
    const totals = summarize(ledger);
    assert.deepEqual(Object.keys(totals).sort(), ["EUR", "USD"]);
    assert.ok(Object.values(totals).every((t) => !t.includes("-")));
  });
});`,
);

put(
	"test/text.test.js",
	`import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MESSAGES } from "../src/data/messages.js";
import { slugify, titleCase, truncate } from "../src/text/slug.js";

describe("slugify", () => {
  for (const [input, slug] of [["Hello World", "hello-world"], ["Größe & Maße", "groesse-masse"], ["  --a--b--  ", "a-b"], ["Crème fraîche", "creme-fra-che"], ["Año Nuevo", "ano-nuevo"]]) {
    test(\`slugify(\${JSON.stringify(input)}) is \${slug}\`, () => assert.equal(slugify(input), slug));
  }
});

describe("truncate and titleCase", () => {
  for (const [t, n, e] of [["short", 10, "short"], ["a longer sentence", 8, "a longe…"], ["exact", 5, "exact"]]) {
    test(\`truncate(\${JSON.stringify(t)}, \${n}) is \${JSON.stringify(e)}\`, () => assert.equal(truncate(t, n), e));
  }
  test("titleCase capitalizes each word", () => assert.equal(titleCase("hello big world"), "Hello Big World"));
});

describe("locale messages", () => {
  for (const locale of Object.keys(MESSAGES)) {
    test(\`locale \${locale} has 120 messages, each mentioning the locale\`, () => {
      const entries = Object.values(MESSAGES[locale]);
      assert.equal(entries.length, 120);
      assert.ok(entries.every((m) => m.startsWith(locale)));
    });
  }
});`,
);

for (const [path, text] of files) {
	const full = join(target, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}
if (!process.argv.includes("--no-git")) {
spawnSync("git", ["init", "-q"], { cwd: target });
spawnSync("git", ["add", "-A"], { cwd: target });
spawnSync("git", ["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-qm", "ledgerly 2.3.1"], { cwd: target });
}
console.log(`wrote ${files.size} files to ${target}${fixed ? " (fixed)" : ` (bugs ${[...enabled].join(",")})`}`);
