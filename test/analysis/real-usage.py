#!/usr/bin/env python3
"""Anonymized aggregate numbers of real usage, for docs/data/real-usage.json and the README charts.

  real-usage.py /tmp/cg-stats/sessions.jsonl docs/data/real-usage.json

Input: extract.py output for the period in which Jev was working. Output holds aggregates only: counts,
token totals, percentages, provider families. No project names, file names, prompts or content.
"""

import json, statistics, sys
from collections import Counter, defaultdict

src, dst = sys.argv[1], sys.argv[2]
rows = [json.loads(l) for l in open(src)]
rows = [r for r in rows if r.get("requests") and r.get("guard", {}).get("jevOkPasses")]


def provider(r):
    m = r["models"]
    return max(m, key=m.get).split("/")[0]


# Control for the cache-rewrite penalty (as in cost.py).
def gb(g):
    if g < 0:
        return "none"
    for lim, name in ((60, "<1m"), (300, "1-5m"), (1800, "5-30m"), (3600, "30-60m")):
        if g < lim:
            return name
    return ">1h"


ctl = defaultdict(lambda: [0.0, 0])
for r in rows:
    for prov, rs, gap, unc, med, ctx, cr, pr, pu, isedit, saved, *_ in r["reqRows"]:
        if med < 0 or isedit or not ctx:
            continue
        ctl[(prov, rs, gb(gap))][0] += max(0, unc - med) / ctx
        ctl[(prov, rs, gb(gap))][1] += 1
ratio = {k: v[0] / v[1] for k, v in ctl.items() if v[1] >= 30}


def money(rs):
    t = defaultdict(float)
    for r in rs:
        t["spend"] += r["cost"]
        t["jev"] += r["guard"].get("jevCost", 0)
        for prov, rsf, gap, unc, med, ctx, cr, pr, pu, isedit, saved, *_ in r[
            "reqRows"
        ]:
            t["ctx"] += ctx
            t["saved"] += saved
            t["requests"] += 1
            if saved:
                f = 1.0 if isedit else (cr / ctx if ctx else 1.0)
                t["savedCost"] += saved * (f * pr + (1 - f) * pu)
            if isedit and med >= 0:
                exp = ratio.get((prov, rsf, gb(gap)), 0) * ctx
                t["penalty"] += max(0, max(0, unc - med) - exp) * max(0, pu - pr)
    t["sessions"] = len(rs)
    return t


def block(rs):
    t = money(rs)
    return {
        "sessions": int(t["sessions"]),
        "requests": int(t["requests"]),
        "contextTokensProcessed": round(t["ctx"]),
        "contextTokensKeptOut": round(t["saved"]),
        "contextReductionPct": round(t["saved"] / (t["ctx"] + t["saved"]) * 100, 1)
        if t["ctx"]
        else 0,
        "mainModelSpendUsd": round(t["spend"]),
        "cheaperContextUsd": round(t["savedCost"]),
        "cacheRewritePenaltyUsd": round(t["penalty"]),
        "jevCostUsd": round(t["jev"], 2),
        "netSavingUsd": round(t["savedCost"] - t["penalty"] - t["jev"]),
        "netSavingPct": round(
            (t["savedCost"] - t["penalty"] - t["jev"])
            / (t["spend"] + t["savedCost"] - t["penalty"] - t["jev"])
            * 100,
            1,
        ),
    }


out = {
    "description": "Aggregates of one heavy user's real Pi sessions with pi-context-guard-jev 0.3.x, while the Jev classifier was working. Counterfactual = the same sessions without the guard's edits. Dollar figures are estimates priced with each request's own cache prices; the cache-rewrite penalty is the extra uncached input after an edit beyond what requests without an edit show at the same idle gap.",
    "period": {
        "from": min(r["start"] for r in rows)[:10],
        "to": max(r["start"] for r in rows)[:10],
    },
    "methodology": "test/analysis (extract.py, cost.py, real-usage.py)",
    "total": block(rows),
    "byProvider": {
        p: block([r for r in rows if provider(r) == p])
        for p in ("anthropic", "openai-codex")
    },
    "bySessionLength": {
        name: block([r for r in rows if lo <= r["requests"] < hi])
        for name, lo, hi in (
            ("<50 requests", 0, 50),
            ("50-199 requests", 50, 200),
            ("200+ requests", 200, 10**9),
        )
    },
    "byRole": {
        name: block([r for r in rows if r["subagent"] == sub])
        for name, sub in (("main sessions", False), ("subagents", True))
    },
}

# Items edited and how often the model asked for them back.
k, ch, rec = Counter(), Counter(), Counter()
for r in rows:
    e = r["edits"]
    for a, b in e["byKind"].items():
        k[a] += b
    for a, b in e["savedCharsByKind"].items():
        ch[a] += b
    for a, b in e["recalledByKind"].items():
        rec[a] += b
names = {
    "large": "large tool outputs (distilled)",
    "small": "small tool outputs (omitted)",
    "exchange": "old exchanges (omitted)",
    "image": "old screenshots (removed)",
}
out["itemsEdited"] = {
    names[a]: {
        "items": k[a],
        "charsRemoved": ch[a],
        "recalledPct": round(rec[a] / k[a] * 100, 1),
    }
    for a in names
    if k[a]
}

# Average context size by request number for long sessions, with and without the guard.
curve = defaultdict(lambda: [0.0, 0.0, 0])
for r in rows:
    if r["requests"] < 200 or r["compactions"]:
        continue
    for n, row in enumerate(r["reqRows"]):
        b = n // 10 * 10
        if b > 400:
            break
        curve[b][0] += row[5]
        curve[b][1] += row[5] + row[10]
        curve[b][2] += 1
out["contextCurve200plus"] = {
    "note": "Mean context tokens per request, sessions with 200+ requests and no compaction, bucketed by 10 requests",
    "sessions": sum(1 for r in rows if r["requests"] >= 200 and not r["compactions"]),
    "points": [
        {
            "request": b,
            "withGuard": round(v[0] / v[2]),
            "withoutGuard": round(v[1] / v[2]),
            "n": v[2],
        }
        for b, v in sorted(curve.items())
        if v[2] >= 20
    ],
}

# Context composition (counterfactual, char x requests), excluding encrypted thinking signatures.
comp = Counter()
for r in rows:
    for a, b in r["composition"].items():
        if a != "thinking signature":
            comp[a] += b
tot = sum(comp.values())
out["contextComposition"] = {a: round(b / tot * 100, 1) for a, b in comp.most_common()}
json.dump(out, open(dst, "w"), indent=1)
print(json.dumps({k: out[k] for k in ("period", "total")}, indent=1))
