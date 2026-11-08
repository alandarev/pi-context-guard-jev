"""Cost model with a control group for the cache-rewrite penalty (see extract.py reqRows)."""

import json, sys
from collections import defaultdict

rows = [json.loads(l) for l in open("/tmp/cg-stats/sessions.jsonl")]
rows = [r for r in rows if r.get("requests")]


def gb(g):
    if g < 0:
        return "none"
    for lim, name in ((60, "<1m"), (300, "1-5m"), (1800, "5-30m"), (3600, "30-60m")):
        if g < lim:
            return name
    return ">1h"


# Control: non-edit requests (no edit batch right before them) -> mean excess ratio by group.
ctl = defaultdict(lambda: [0.0, 0])
for r in rows:
    for prov, rs, gap, unc, med, ctx, cr, pr, pu, isedit, saved, *_ in r["reqRows"]:
        if med < 0 or isedit or not ctx:
            continue
        key = (prov, rs, gb(gap))
        ctl[key][0] += max(0, unc - med) / ctx
        ctl[key][1] += 1
ratio = {k: v[0] / v[1] for k, v in ctl.items() if v[1] >= 30}
print("control mean excess-uncached ratio (non-edit requests):")
for k in sorted(ratio):
    print(f"  {k!s:40} {ratio[k]:.3f}  n={ctl[k][1]}")


def group(r):
    g = r.get("guard", {})
    if not g.get("passes"):
        return "no guard"
    return "jev ok" if g.get("jevOkPasses") else "jev failing"


def provider(r):
    m = r["models"]
    return max(m, key=m.get).split("/")[0]


def model(r, rs_label):
    tot = defaultdict(float)
    for r in rs_label:
        tot["sessions"] += 1
        tot["jev"] += r["guard"].get("jevCost", 0)
        tot["cost"] += r["cost"]
        for prov, rs, gap, unc, med, ctx, cr, pr, pu, isedit, saved, *_ in r["reqRows"]:
            tot["ctx"] += ctx
            tot["requests"] += 1
            tot["saved"] += saved
            if saved:
                f = 1.0 if isedit else (cr / ctx if ctx else 1.0)
                tot["savedCost"] += saved * (f * pr + (1 - f) * pu)
                tot["savedCostRead"] += saved * pr
            if isedit and med >= 0:
                exp = ratio.get((prov, rs, gb(gap)), 0) * ctx
                ex = max(0, unc - med)
                tot["penaltyRaw"] += ex * max(0, pu - pr)
                tot["penalty"] += max(0, ex - exp) * max(0, pu - pr)
                tot["editBatches"] += 1
    return tot


def line(name, t):
    if not t.get("requests"):
        return
    net = t["savedCost"] - t["penalty"] - t["jev"]
    print(
        f"{name:28} sess {int(t['sessions']):5} req {int(t['requests']):7} ctx {t['ctx'] / 1e9:6.2f}B saved {t['saved'] / 1e9:5.2f}B "
        f"({t['saved'] / (t['ctx'] + t['saved']) * 100:4.1f}%) cost ${t['cost']:8.0f} savedCost ${t['savedCost']:7.0f} (at read price ${t['savedCostRead']:6.0f}) "
        f"penalty ${t['penalty']:6.0f} (raw ${t['penaltyRaw']:6.0f}) jev ${t['jev']:5.1f} net ${net:7.0f} ({net / (t['cost'] + net) * 100 if t['cost'] else 0:+.1f}%) batches {int(t['editBatches'])}"
    )


groups = defaultdict(list)
for r in rows:
    groups[group(r)].append(r)
print()
for g in ("jev ok", "jev failing"):
    line(g, model(None, groups[g]))
    for p in ("anthropic", "openai-codex"):
        line(f"  {p}", model(None, [r for r in groups[g] if provider(r) == p]))
    for s in (False, True):
        line(
            f"  subagent={s}", model(None, [r for r in groups[g] if r["subagent"] == s])
        )
    for lo, hi in ((0, 50), (50, 200), (200, 10**9)):
        line(
            f"  {lo}-{hi} req",
            model(None, [r for r in groups[g] if lo <= r["requests"] < hi]),
        )
