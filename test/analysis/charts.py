#!/usr/bin/env python3
"""README charts from docs/data/real-usage.json → assets/*.png.  Usage: charts.py"""

import json
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

d = json.load(open("docs/data/real-usage.json"))
GREEN, GREY, MUTED, INK, RED = "#2e9e5b", "#8c959f", "#6e7781", "#1f2328", "#c2410c"
plt.rcParams.update(
    {
        "font.size": 12,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.edgecolor": GREY,
        "text.color": INK,
        "axes.labelcolor": INK,
        "xtick.color": INK,
        "ytick.color": INK,
    }
)

# 1. Context per request in long sessions: observed with the guard vs estimated without it.
c = d["contextCurve200plus"]
pts = c["points"]
x = [p["request"] for p in pts]
w = [p["withGuard"] / 1000 for p in pts]
wo = [p["withoutGuard"] / 1000 for p in pts]
cut = next(
    i for i, p in enumerate(pts) if p["n"] < 500
)  # fewer than 50 sessions reach this far: dashed tail
fig, ax = plt.subplots(figsize=(9, 4.4), dpi=150)
ax.fill_between(x, w, wo, color=GREEN, alpha=0.13, lw=0)
for seg, style in ((slice(0, cut + 1), "-"), (slice(cut, None), (0, (2, 2)))):
    ax.plot(
        x[seg],
        wo[seg],
        color=GREY,
        lw=2.5,
        ls=style,
        label="estimated without the guard" if style == "-" else None,
    )
    ax.plot(
        x[seg],
        w[seg],
        color=GREEN,
        lw=2.5,
        ls=style,
        label="with the guard" if style == "-" else None,
    )
i = x.index(200)
ax.annotate(
    f"−{(1 - w[i] / wo[i]) * 100:.0f}% at request 200",
    xy=(200, (w[i] + wo[i]) / 2),
    xytext=(-175, 60),
    textcoords="offset points",
    fontsize=14,
    fontweight="bold",
    color=GREEN,
    arrowprops=dict(arrowstyle="-", color=GREEN, lw=1),
)
ax.text(x[-1] + 6, wo[-1], f"{wo[-1]:.0f}k", va="center", color=MUTED)
ax.text(x[-1] + 6, w[-1], f"{w[-1]:.0f}k", va="center", color=GREEN, fontweight="bold")
ax.text(
    x[-1],
    12,
    "dashed: fewer than 50 sessions reach this far",
    ha="right",
    fontsize=9,
    color=MUTED,
)
ax.set_xlabel("request # in the session")
ax.set_ylabel("context sent (k tokens)")
ax.set_title(
    f"Context per request · {c['sessions']} real sessions of 200+ requests (no compaction)",
    loc="left",
    fontsize=13,
)
ax.legend(frameon=False, loc="upper left")
ax.set_xlim(0, x[-1] + 40)
ax.set_ylim(0)
fig.tight_layout()
fig.savefig("assets/context-curve.png")

# 2. Estimated net effect on the bill by session length.
L = d["bySessionLength"]
groups = [
    ("under 50 requests", L["<50 requests"]),
    ("50–199 requests", L["50-199 requests"]),
    ("200+ requests", L["200+ requests"]),
]
net = [g["netSavingPct"] for _, g in groups]
fig, ax = plt.subplots(figsize=(9, 3.2), dpi=150)
ax.barh(range(3), net, color=[RED if v < 0 else GREEN for v in net], height=0.6)
ax.set_yticks(range(3), [f"{n}\n{g['sessions']:,} sessions" for n, g in groups])
ax.invert_yaxis()
ax.axvline(0, color=INK, lw=0.8)
for k, v in enumerate(net):
    ax.text(
        max(v, 0) + 0.2,
        k,
        f"bill +{abs(v):.1f}%" if v < 0 else f"bill −{v:.1f}%",
        va="center",
        fontsize=12,
        fontweight="bold",
        color=RED if v < 0 else GREEN,
    )
ax.set_xlim(-3, 10)
ax.set_xticks([])
ax.spines["bottom"].set_visible(False)
ax.spines["left"].set_visible(False)
ax.tick_params(axis="y", length=0)
ax.set_title(
    "Estimated main-model bill, net of cache rewrites and Jev", loc="left", fontsize=13
)
fig.tight_layout()
fig.savefig("assets/bill-by-length.png")
print("wrote assets/context-curve.png assets/bill-by-length.png")
