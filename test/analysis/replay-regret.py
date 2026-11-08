#!/usr/bin/env python3
"""Savings and proxy regret of a jev-replay.ts items file.

  replay-regret.py items.jsonl [items2.jsonl ...]

Proxy for "the agent needed what was removed": distinctive tokens (identifiers, paths, numbers, hashes)
that first appeared in the session in the removed part of an output, and that the agent later wrote in
its own text or tool-call arguments after the decision point. The sessions replayed are from a period
where the guard edited nothing, so the agent's later use is not influenced by the removal.
"""

import json, os, re, sys
from collections import defaultdict

TOKEN = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_./:\-]{5,}")
CAMEL = re.compile(r"[a-z][A-Z]")


STRICT = os.environ.get("STRICT") == "1"


def tokens(text):
    out = set()
    for t in TOKEN.findall(text or ""):
        t = t.rstrip(".:-/")
        if len(t) < 6:
            continue
        # Strict: only specific tokens (paths, identifiers with digits or underscores, long camelCase).
        if STRICT and not (len(t) >= 8 and (("/" in t or "_" in t) or (any(c.isdigit() for c in t) and any(c.isalpha() for c in t)) or (CAMEL.search(t) and len(t) >= 12))):
            continue
        if any(c.isdigit() or c in "_./:-" for c in t) or CAMEL.search(t):
            out.add(t)
    return out


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(
        b.get("text") or "" for b in content or [] if b.get("type") == "text"
    )


sessions = {}


def session(file):
    if file in sessions:
        return sessions[file]
    raw = [json.loads(l) for l in open(file) if l.strip()]
    entries = [
        e
        for e in raw
        if not (
            e.get("type") == "context_edit"
            or (e.get("type") == "custom" and e.get("customType") == "context-guard")
        )
    ]
    first_seen, last_use = {}, {}
    sources, uses = defaultdict(list), defaultdict(list)
    index_of = {}
    result_text = {}
    assistant_pos = []
    user_pos = []
    compactions = []
    for i, e in enumerate(entries):
        index_of[e.get("id")] = i
        t = e.get("type")
        texts, used = [], []
        if t == "message":
            m = e["message"]
            role = m.get("role")
            if role == "assistant":
                assistant_pos.append(i)
                for b in m.get("content") or []:
                    if b.get("type") == "text":
                        used.append(b.get("text") or "")
                    elif b.get("type") == "toolCall":
                        used.append(json.dumps(b.get("arguments")))
                texts = used
            else:
                texts = [text_of(m.get("content"))]
                if role == "toolResult":
                    result_text[e.get("id")] = texts[0]
                if role == "user":
                    user_pos.append(i)
        elif t == "custom_message":
            texts = [text_of(e.get("content"))]
        elif t == "compaction":
            compactions.append((i, e.get("firstKeptEntryId")))
        for tok in tokens("\n".join(texts)):
            first_seen.setdefault(tok, i)
            if not used:
                sources[tok].append(i)
        for tok in tokens("\n".join(used)):
            last_use[tok] = i
            uses[tok].append(i)
    comp = [(ci, index_of.get(fk, ci)) for ci, fk in compactions]
    s = {
        "first": first_seen,
        "last": last_use,
        "sources": sources,
        "uses": uses,
        "index": index_of,
        "assistant": assistant_pos,
        "user": user_pos,
        "comp": comp,
        "n": len(entries),
        "text": result_text,
    }
    sessions[file] = s
    return s


def dependent(s, tok, idx, pos):
    """The agent wrote `tok` after `pos` before any later tool result or message brought it in again."""
    import bisect

    u = s["uses"].get(tok, [])
    k = bisect.bisect_right(u, pos)
    if k >= len(u):
        return False
    src = s["sources"].get(tok, [])
    j = bisect.bisect_right(src, idx)
    return j >= len(src) or u[k] < src[j]


def remaining_requests(s, item_index, pos):
    end = s["n"]
    for ci, fk in s["comp"]:
        if ci > pos and item_index < fk:
            end = ci
            break
    import bisect

    return bisect.bisect_left(s["assistant"], end) - bisect.bisect_right(
        s["assistant"], pos
    )


def analyse(path):
    final = {}  # (file, entryId) -> first removal record, else last kept record
    for line in open(path):
        r = json.loads(line)
        key = (r["file"], r["entryId"], r["kind"])
        prev = final.get(key)
        if r["outcome"] != "kept":
            if not prev or prev["outcome"] == "kept":
                final[key] = r
        elif not prev:
            final[key] = r
    tot = defaultdict(float)
    for (file, entry_id, kind), r in final.items():
        if "error" in r["reason"] or "timeout" in r["reason"]:
            tot["errors"] += 1
            continue
        s = session(file)
        idx = s["index"].get(entry_id)
        if idx is None:
            continue
        pos = r["pos"]
        tot[f"{kind} items"] += 1
        if kind != "exchange":
            all_distinct = {t for t in tokens(s["text"].get(entry_id, "")) if s["first"].get(t) == idx}
            all_used = {t for t in all_distinct if dependent(s, t, idx, pos)}
            tot[f"{kind} usedTokens"] += len(all_used)
            tot[f"{kind} distinctTokens"] += len(all_distinct)
            if r["outcome"] != "kept":
                removed_lines = set(r["removed"].split("\n"))
                kept_text = "\n".join(l for l in s["text"].get(entry_id, "").split("\n") if l not in removed_lines)
                rem = {t for t in tokens(r["removed"]) if t in all_distinct} - tokens(kept_text)
                tot[f"{kind} lostUsed"] += len(rem & all_used)
                tot[f"{kind} removedTokens"] += len(rem)
        if r["outcome"] == "kept":
            continue
        saved = r["beforeChars"] - r["afterChars"]
        tot[f"{kind} removed"] += 1
        tot[f"{kind} savedTokReq"] += saved / 4 * remaining_requests(s, idx, pos)
        tot["savedTokReq"] += saved / 4 * remaining_requests(s, idx, pos)
        if kind == "exchange":
            continue
        distinct = [t for t in tokens(r["removed"]) if s["first"].get(t) == idx]
        used = [t for t in distinct if s["last"].get(t, -1) > pos]
        if used:
            tot[f"{kind} regret1"] += 1
        if len(used) >= 3:
            tot[f"{kind} regret3"] += 1
    return tot


def fmt(name, t):
    parts = [f"{name:34}", f"saved {t['savedTokReq'] / 1e6:8.1f}M tok·req"]
    for k in ("large", "small", "exchange"):
        n, rm = t[f"{k} items"], t[f"{k} removed"]
        if not n:
            continue
        reg = ""
        if rm and k != "exchange":
            lost = t[f"{k} lostUsed"] / max(1, t[f"{k} usedTokens"]) * 100
            share = t[f"{k} removedTokens"] / max(1, t[f"{k} distinctTokens"]) * 100
            pu_r = t[f"{k} lostUsed"] / max(1, t[f"{k} removedTokens"])
            pu_k = (t[f"{k} usedTokens"] - t[f"{k} lostUsed"]) / max(1, t[f"{k} distinctTokens"] - t[f"{k} removedTokens"])
            reg = f" removed {share:4.1f}% of new info, {lost:4.1f}% of later-used info (use rate removed {pu_r*100:.2f}% vs kept {pu_k*100:.2f}%)"
        parts.append(
            f"{k}: {int(rm)}/{int(n)} removed, {t[f'{k} savedTokReq'] / 1e6:6.1f}M{reg}"
        )
    return " | ".join(parts)


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(fmt(p.split("/")[-1], analyse(p)))
