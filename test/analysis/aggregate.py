import json, sys
from collections import Counter, defaultdict

rows = [
    json.loads(l)
    for l in open(sys.argv[1] if len(sys.argv) > 1 else "/tmp/cg-stats/sessions.jsonl")
]
rows = [r for r in rows if r.get("requests")]


def group(r):
    g = r.get("guard", {})
    if not g.get("passes"):
        return "no guard"
    return "jev ok" if g.get("jevOkPasses") else "jev failing"


def provider(r):
    m = r["models"]
    top = max(m, key=m.get)
    return top.split("/")[0]


def M(x):
    return f"{x / 1e6:,.1f}M"


def summarize(name, rs):
    if not rs:
        return
    req = sum(r["requests"] for r in rs)
    ctx = sum(r["ctxTokens"] for r in rs)
    saved = sum(r["edits"]["savedTokenRequests"] for r in rs)
    cost = sum(r["cost"] for r in rs)
    scost = sum(r["edits"]["savedCostEst"] for r in rs)
    pen = sum(r["edits"]["penaltyCostEst"] for r in rs)
    jev = sum(r["guard"].get("jevCost", 0) for r in rs)
    comp = sum(r["compactions"] for r in rs)
    print(
        f"{name:32} sess {len(rs):5} req {req:7} ctx {M(ctx):>9} saved {M(saved):>9} ({saved / (ctx + saved) * 100 if ctx else 0:4.1f}%) "
        f"cost ${cost:9.2f} savedCost ${scost:8.2f} penalty ${pen:8.2f} jev ${jev:6.2f} net ${scost - pen - jev:8.2f} compactions {comp}"
    )


groups = defaultdict(list)
for r in rows:
    groups[group(r)].append(r)
for g, rs in groups.items():
    summarize(g, rs)
print()
for g in ("jev ok", "jev failing", "no guard"):
    for p in ("anthropic", "openai-codex"):
        summarize(f"{g} / {p}", [r for r in groups[g] if provider(r) == p])
    others = Counter(
        provider(r)
        for r in groups[g]
        if provider(r) not in ("anthropic", "openai-codex")
    )
    if others:
        print("   other providers", dict(others))
print()
for lo, hi in ((0, 20), (20, 50), (50, 100), (100, 200), (200, 10**9)):
    summarize(
        f"jev ok, {lo}-{hi} requests",
        [r for r in groups["jev ok"] if lo <= r["requests"] < hi],
    )
print()
for s in (False, True):
    summarize(
        f"jev ok, subagent={s}", [r for r in groups["jev ok"] if r["subagent"] == s]
    )

# Edits by kind, recall and refetch (jev ok)
k = Counter()
ch = Counter()
rec = Counter()
ref = Counter()
base = Counter()
for r in groups["jev ok"]:
    e = r["edits"]
    for a, b in e["byKind"].items():
        k[a] += b
    for a, b in e["savedCharsByKind"].items():
        ch[a] += b
    for a, b in e["recalledByKind"].items():
        rec[a] += b
    for a, b in e["refetchedByKind"].items():
        ref[a] += b
    for a, b in e["baselineRefetch"].items():
        base[a] += b
print("\nedits (jev ok sessions):")
for a in k:
    print(
        f"  {a:9} items {k[a]:7} savedChars {M(ch[a]):>8} recalled {rec[a]:5} ({rec[a] / k[a] * 100:.2f}%) refetched {ref[a]:6} ({ref[a] / k[a] * 100:.1f}%)"
    )
print(
    f"  baseline refetch of unedited outputs >=400 chars: {base['refetched']}/{base['n']} ({base['refetched'] / max(1, base['n']) * 100:.1f}%)"
)
print("  recall calls total:", sum(r["recallCalls"] for r in groups["jev ok"]))

# Guard reasons (jev ok)
g = Counter()
for r in groups["jev ok"]:
    for a, b in r["guard"].items():
        if a.startswith(("items", "reason", "chars")):
            g[a] += b
print("\nguard results (jev ok):")
for a, b in sorted(g.items()):
    print(f"  {a:40} {b:,}")

# Composition (counterfactual, char-requests) across all sessions and jev ok
for name, rs in (("all", rows), ("jev ok", groups["jev ok"])):
    c = Counter()
    for r in rs:
        for a, b in r["composition"].items():
            c[a] += b
    tot = sum(v for a, v in c.items() if a != "thinking signature")
    print(f"\ncomposition ({name}), char-requests, % of total excl. signatures:")
    for a, b in c.most_common():
        print(
            f"  {a:28} {b / 1e9:9.1f}G  {b / tot * 100 if a != 'thinking signature' else float('nan'):5.1f}%"
        )
