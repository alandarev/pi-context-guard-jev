#!/usr/bin/env python3
"""README charts from docs/data/real-usage.json → assets/*.png.  Usage: charts.py"""

import json
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

d = json.load(open("docs/data/real-usage.json"))
GREEN, GREY, INK = "#2e9e5b", "#b8bec6", "#1f2328"
plt.rcParams.update(
    {
        "font.size": 12,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.edgecolor": "#8c959f",
        "text.color": INK,
        "axes.labelcolor": INK,
        "xtick.color": INK,
        "ytick.color": INK,
    }
)

# 1. Context size over a long session, with and without the guard.
pts = d["contextCurve200plus"]["points"]
x = [p["request"] for p in pts]
w = [p["withGuard"] / 1000 for p in pts]
wo = [p["withoutGuard"] / 1000 for p in pts]
fig, ax = plt.subplots(figsize=(9, 4.2), dpi=150)
ax.fill_between(x, w, wo, color=GREEN, alpha=0.15, lw=0)
ax.plot(x, wo, color=GREY, lw=2.5, label="without context guard")
ax.plot(x, w, color=GREEN, lw=2.5, label="with context guard")
last = pts[-1]
ax.annotate(
    f"−{(1 - last['withGuard'] / last['withoutGuard']) * 100:.0f}%",
    xy=(x[-1], (w[-1] + wo[-1]) / 2),
    xytext=(8, 0),
    textcoords="offset points",
    va="center",
    fontsize=15,
    fontweight="bold",
    color=GREEN,
)
ax.set_xlabel("request # in the session")
ax.set_ylabel("context sent (k tokens)")
ax.set_title(
    f"Average context of {d['contextCurve200plus']['sessions']} real long sessions (200+ requests)",
    loc="left",
    fontsize=13,
)
ax.legend(frameon=False, loc="upper left")
ax.set_xlim(0, x[-1] + 30)
ax.set_ylim(0)
fig.tight_layout()
fig.savefig("assets/context-curve.png")

# 2. Context reduction by session length and role.
groups = [
    ("< 50 requests", d["bySessionLength"]["<50 requests"]),
    ("50–199", d["bySessionLength"]["50-199 requests"]),
    ("200+", d["bySessionLength"]["200+ requests"]),
    ("subagents", d["byRole"]["subagents"]),
    ("all", d["total"]),
]
fig, ax = plt.subplots(figsize=(9, 3.4), dpi=150)
labels = [g[0] for g in groups]
vals = [g[1]["contextReductionPct"] for g in groups]
bars = ax.barh(
    labels[::-1],
    vals[::-1],
    color=[GREEN if l == "all" else "#7cc49a" for l in labels[::-1]],
)
for b, v, g in zip(bars, vals[::-1], [g[1] for g in groups][::-1]):
    ax.text(
        b.get_width() + 0.4,
        b.get_y() + b.get_height() / 2,
        f"−{v:.0f}%  ({g['sessions']:,} sessions)",
        va="center",
        fontsize=11,
    )
ax.set_xlim(0, max(vals) * 1.45)
ax.set_xticks([])
ax.spines["bottom"].set_visible(False)
ax.set_title("Fewer context tokens sent, by session length", loc="left", fontsize=13)
fig.tight_layout()
fig.savefig("assets/reduction.png")
print("wrote assets/context-curve.png assets/reduction.png")
