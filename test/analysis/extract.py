#!/usr/bin/env python3
"""Per-session stats for context-guard analysis. Reads Pi session JSONL files, writes one JSON line per
session with aggregate numbers only (no content). Usage: extract.py OUT.jsonl SINCE(YYYY-MM-DD) [UNTIL]"""

import glob, hashlib, json, os, statistics, sys
from collections import Counter, defaultdict
from multiprocessing import Pool

IMAGE_CHARS = 4800  # Pi's own compaction estimate per image
ROOT = os.path.expanduser("~/.pi/agent/sessions")


def text_chars(content):
    if isinstance(content, str):
        return len(content), 0
    n = imgs = 0
    for b in content or []:
        t = b.get("type")
        if t == "text":
            n += len(b.get("text") or "")
        elif t == "image":
            imgs += 1
    return n, imgs


def bucket(n):
    return (
        "<400"
        if n < 400
        else "400-4k"
        if n < 4000
        else "4k-20k"
        if n < 20000
        else "20k+"
    )


def call_key(name, args):
    if not isinstance(args, dict):
        return name
    for k in ("command", "path", "file_path", "pattern", "url", "query", "code"):
        if k in args:
            return f"{name}:{str(args[k])[:300]}"
    return f"{name}:{json.dumps(args, sort_keys=True)[:300]}"


def analyse(path):
    try:
        entries = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    except Exception as ex:
        return {"file": path, "error": str(ex)}
    if not entries:
        return None
    by_id = {e["id"]: e for e in entries if e.get("id")}
    # Final branch: leaf = last entry with an id.
    leaf = next((e for e in reversed(entries) if e.get("id")), None)
    branch = []
    seen = set()
    while leaf is not None and leaf["id"] not in seen:
        seen.add(leaf["id"])
        branch.append(leaf)
        leaf = by_id.get(leaf.get("parentId"))
    branch.reverse()
    pos = {e["id"]: i for i, e in enumerate(branch)}
    header = entries[0] if entries[0].get("type") == "session" else {}
    rel = os.path.relpath(path, ROOT)
    project = rel.split("/")[0]
    out = {
        "file": rel,
        "projectHash": hashlib.sha1(project.encode()).hexdigest()[:8],
        "subagent": "/run-" in rel or "subagent" in rel,
        "start": header.get("timestamp") or entries[0].get("timestamp"),
        "branchEntries": len(branch),
        "allEntries": len(entries),
    }
    assistant_idx = [
        i
        for i, e in enumerate(branch)
        if e.get("type") == "message" and e["message"].get("role") == "assistant"
    ]
    # number of assistant requests strictly after position i
    import bisect

    def requests_between(a, b):
        return bisect.bisect_left(assistant_idx, b) - bisect.bisect_right(
            assistant_idx, a
        )

    # compactions: entries before firstKept are dropped from that compaction on
    compactions = []
    for i, e in enumerate(branch):
        if e.get("type") == "compaction":
            fk = pos.get(e.get("firstKeptEntryId"), i)
            compactions.append((i, fk))
    out["compactions"] = len(compactions)

    def drop_at(i):
        """Position from which entry at i is no longer in context (compaction), else len(branch)."""
        for ci, fk in compactions:
            if ci > i and i < fk:
                return ci
        return len(branch)

    models = Counter()
    usage_rows = []  # per request
    for i in assistant_idx:
        m = branch[i]["message"]
        u = m.get("usage") or {}
        c = u.get("cost") or {}
        models[f"{m.get('provider')}/{m.get('model')}"] += 1
        inp, cr, cw = (
            u.get("input", 0) or 0,
            u.get("cacheRead", 0) or 0,
            u.get("cacheWrite", 0) or 0,
        )
        prev = branch[i - 1] if i > 0 else {}
        run_start = prev.get("type") == "message" and prev["message"].get("role") == "user"
        row = {"ts": m.get("timestamp") or 0, "runStart": run_start,
            "i": i,
            "ctx": inp + cr + cw,
            "uncached": inp + cw,
            "cr": cr,
            "out": u.get("output", 0) or 0,
            "cost": c.get("total", 0) or 0,
            "pRead": (c.get("cacheRead", 0) / cr) if cr else None,
            "pUncached": ((c.get("input", 0) + c.get("cacheWrite", 0)) / (inp + cw))
            if (inp + cw)
            else None,
            "provider": m.get("provider"),
        }
        usage_rows.append(row)
    out["models"] = dict(models)
    out["requests"] = len(usage_rows)
    out["ctxTokens"] = sum(r["ctx"] for r in usage_rows)
    out["peakCtx"] = max((r["ctx"] for r in usage_rows), default=0)
    out["cost"] = sum(r["cost"] for r in usage_rows)
    out["outTokens"] = sum(r["out"] for r in usage_rows)
    reads = [r["pRead"] for r in usage_rows if r["pRead"]]
    uncs = [r["pUncached"] for r in usage_rows if r["pUncached"]]
    p_read = statistics.median(reads) if reads else None
    p_unc = statistics.median(uncs) if uncs else None
    out["pRead"], out["pUncached"] = p_read, p_unc

    # Original sizes of entries and lifetime-weighted context composition (char-requests).
    comp = Counter()
    orig_chars = {}
    tool_calls = {}  # toolCallId -> (name, key)
    call_keys_after = defaultdict(list)  # key -> positions where called
    recall_targets = Counter()
    recall_calls = 0
    tr_stats = Counter()
    for i, e in enumerate(branch):
        t = e.get("type")
        life = requests_between(i, drop_at(i))
        if t == "message":
            m = e["message"]
            role = m.get("role")
            if role == "assistant":
                for b in m.get("content") or []:
                    bt = b.get("type")
                    if bt == "text":
                        comp["assistant text"] += len(b.get("text") or "") * life
                    elif bt == "thinking":
                        comp["thinking text"] += len(b.get("thinking") or "") * life
                        comp["thinking signature"] += (
                            len(b.get("thinkingSignature") or "") * life
                        )
                    elif bt == "toolCall":
                        name = b.get("name")
                        args = b.get("arguments")
                        n = len(json.dumps(args))
                        cat = (
                            "call args: edit/write"
                            if name in ("edit", "write")
                            else "call args: other"
                        )
                        comp[cat] += n * life
                        tool_calls[b.get("id")] = (name, call_key(name, args))
                        call_keys_after[call_key(name, args)].append(i)
                        if name == "recall":
                            recall_calls += 1
                            if isinstance(args, dict) and args.get("entryId"):
                                recall_targets[args["entryId"]] += 1
            elif role == "toolResult":
                n, imgs = text_chars(m.get("content"))
                name = m.get("toolName") or "?"
                orig_chars[e["id"]] = n + imgs * IMAGE_CHARS
                if name in ("edit", "write"):
                    cat = "tool result: edit/write"
                elif name == "recall":
                    cat = "tool result: recall"
                else:
                    cat = f"tool result: {bucket(n)}"
                comp[cat] += n * life
                if imgs:
                    comp["images (tool results)"] += imgs * IMAGE_CHARS * life
                tr_stats["count"] += 1
                tr_stats["chars"] += n
                tr_stats["images"] += imgs
                tr_stats["errors"] += bool(m.get("isError"))
            elif role == "user":
                n, imgs = text_chars(m.get("content"))
                orig_chars[e["id"]] = n + imgs * IMAGE_CHARS
                comp["user"] += (n + imgs * IMAGE_CHARS) * life
            elif role == "system":
                pass  # system prompt is not a regular projected message; counted from usage remainder
            else:
                n, imgs = text_chars(m.get("content"))
                comp[f"other ({role})"] += (n + imgs * IMAGE_CHARS) * life
        elif t == "custom_message":
            n, imgs = text_chars(e.get("content"))
            orig_chars[e["id"]] = n
            comp["custom messages"] += n * life
        elif t in ("compaction", "branch_summary"):
            comp["summaries"] += len(e.get("summary") or "") * requests_between(
                i, len(branch)
            )
    for e in branch:
        if e.get("type") == "message" and e["message"].get("role") == "assistant":
            orig_chars[e["id"]] = sum(
                len(json.dumps(b))
                for b in e["message"].get("content") or []
                if b.get("type") != "thinking"
            )
    out["composition"] = dict(comp)
    out["toolResults"] = dict(tr_stats)
    out["recallCalls"] = recall_calls

    # Guard records and edits.
    recs = [
        e
        for e in branch
        if e.get("type") == "custom" and e.get("customType") == "context-guard"
    ]
    g = Counter()
    result_by_target = {}
    for e in recs:
        d = e.get("data") or {}
        g["passes"] += 1
        g["midRun"] += d.get("phase") == "mid-run"
        g["jevRequests"] += d.get("requests", 0)
        g["jevOkPasses"] += (d.get("inputTokens", 0) or 0) > 0
        g["jevCost"] += d.get("costUsd", 0) or 0
        g["jevMs"] += d.get("ms", 0) or 0
        g["recordSavedChars"] += d.get("savedChars", 0) or 0
        for r in d.get("results") or []:
            kind = r.get("kind") or "large"
            g[f"items {kind} {r.get('outcome')}"] += 1
            g[f"chars {kind} {r.get('outcome')}"] += r.get("beforeChars", 0)
            reason = (r.get("reason") or "").split(",")[0]
            g[f"reason {kind} {reason}"] += 1
            if r.get("outcome") != "kept":
                result_by_target[r.get("entryId")] = (
                    kind,
                    r.get("beforeChars", 0) - r.get("afterChars", 0),
                )
    out["guard"] = dict(g)

    # Edits applied on the branch: tokens kept out x requests carrying the smaller context.
    last_edit = {}
    edit_phase = {}
    pending = []
    for i, e in enumerate(branch):
        if e.get("type") == "context_edit":
            last_edit.setdefault(e.get("targetId"), []).append(i)
            pending.append(i)
        elif e.get("type") == "custom" and e.get("customType") == "context-guard":
            ph = (e.get("data") or {}).get("phase") or "run-end"
            for j in pending:
                edit_phase[j] = ph
            pending = []
    for j in pending:
        edit_phase[j] = "other"
    # blended price per request (edit-request priced at read, see cost.py)
    prices = []
    for r in usage_rows:
        f = r["cr"] / r["ctx"] if r["ctx"] else 1.0
        prices.append(f * (r["pRead"] or p_read or 0) + (1 - f) * (r["pUncached"] or p_unc or 0))
    pre = [0.0]
    for x in prices:
        pre.append(pre[-1] + x)
    phase_val = Counter()
    phase_tok = Counter()
    batch_phase = {}
    edit_spans = []
    saved_tok_req = 0.0
    saved_cost = 0.0
    saved_diff = [0.0] * (len(assistant_idx) + 1)
    edit_kinds = Counter()
    edit_saved_chars = Counter()
    recalled = Counter()
    refetched = Counter()
    edited_total = Counter()
    edit_positions = set()
    for target, idxs in last_edit.items():
        tpos = pos.get(target)
        if tpos is None:
            continue
        kind, saved = result_by_target.get(target, ("other", None))
        if saved is None:
            # edit by another extension or unmatched: estimate from replacement size
            e = branch[idxs[0]]
            rep = e.get("replacement")
            rc = 0 if rep is None else text_chars(rep.get("content"))[0]
            saved = max(0, orig_chars.get(target, 0) - rc)
        start = idxs[0]
        end = drop_at(tpos)
        edit_positions.add(start)
        reqs = requests_between(start, end)
        k0 = bisect.bisect_right(assistant_idx, start)
        k1 = bisect.bisect_left(assistant_idx, end)
        if k0 < k1:
            saved_diff[k0] += saved / 4
            saved_diff[k1] -= saved / 4
            ph = edit_phase.get(start, "other")
            batch_phase[k0] = ph
            edit_spans.append((ph, saved, k0, k1))
            phase_tok[ph] += saved / 4 * (k1 - k0)
        saved_tok_req += saved / 4 * reqs
        if p_read:
            saved_cost += saved / 4 * reqs * p_read
        edit_kinds[kind] += 1
        edit_saved_chars[kind] += saved
        edited_total[kind] += 1
        if recall_targets.get(target):
            recalled[kind] += 1
        # re-fetch: the same call issued again after the edit
        tm = branch[tpos]["message"] if branch[tpos].get("type") == "message" else {}
        tc = tool_calls.get(tm.get("toolCallId"))
        if tc and any(p > start for p in call_keys_after.get(tc[1], [])):
            refetched[kind] += 1
    # Baseline re-fetch rate for large/small tool results that were never edited (same rules).
    base = Counter()
    for i, e in enumerate(branch):
        if (
            e.get("type") == "message"
            and e["message"].get("role") == "toolResult"
            and e["id"] not in last_edit
        ):
            n = orig_chars.get(e["id"], 0)
            if n < 400 or (e["message"].get("toolName") in ("edit", "write", "recall")):
                continue
            tc = tool_calls.get(e["message"].get("toolCallId"))
            base["n"] += 1
            if tc and any(p > i + 1 for p in call_keys_after.get(tc[1], [])):
                base["refetched"] += 1
    # Cache-rewrite penalty: first request after each edit batch, excess uncached tokens over the median of the 3 before.
    penalty_tokens = 0
    penalty_cost = 0.0
    req_positions = [r["i"] for r in usage_rows]
    batches = sorted({bisect.bisect_right(req_positions, ep) for ep in edit_positions})
    for k in batches:
        if k >= len(usage_rows) or k < 1:
            continue
        prev = [usage_rows[j]["uncached"] for j in range(max(0, k - 3), k)]
        excess = max(0, usage_rows[k]["uncached"] - statistics.median(prev))
        penalty_tokens += excess
        r = usage_rows[k]
        if r["pUncached"] and (r["pRead"] or p_read):
            penalty_cost += excess * (r["pUncached"] - (r["pRead"] or p_read))
    # Phase values: requests right after an edit batch priced at the read price (the break is the edit's own cost).
    bs = set(batches)
    pre = [0.0]
    for k, x in enumerate(prices):
        pre.append(pre[-1] + ((usage_rows[k]["pRead"] or p_read or 0) if k in bs else x))
    for ph, saved, k0, k1 in edit_spans:
        phase_val[ph] += saved / 4 * (pre[k1] - pre[k0])
    # Per-request rows for the cost model (aggregate.py): saved tokens active at each request.
    batch_set = set(batches)
    acc = 0.0
    req_rows = []
    for k, r in enumerate(usage_rows):
        acc += saved_diff[k]
        prev_unc = [usage_rows[j]["uncached"] for j in range(max(0, k - 3), k)]
        gap = (r["ts"] - usage_rows[k - 1]["ts"]) / 1000 if k > 0 and r["ts"] and usage_rows[k - 1]["ts"] else -1
        req_rows.append([r["provider"], int(r["runStart"]), round(gap, 1), r["uncached"], statistics.median(prev_unc) if prev_unc else -1, r["ctx"], r["cr"],
                         r["pRead"] or p_read or 0, r["pUncached"] or p_unc or 0, int(k in batch_set), round(acc), batch_phase.get(k, "")])
    out["phaseValue"] = dict(phase_val)
    out["phaseTokens"] = dict(phase_tok)
    out["reqRows"] = req_rows
    # Remaining potential: tool results >= 400 chars (not edit/write/recall) never edited, char-requests after 4 requests of age.
    judged = set()
    for e in recs:
        for r in (e.get("data") or {}).get("results") or []:
            judged.add(r.get("entryId"))
    pot = Counter()
    for i, e in enumerate(branch):
        if e.get("type") != "message" or e["message"].get("role") != "toolResult" or e["id"] in last_edit:
            continue
        name = e["message"].get("toolName") or "?"
        n, imgs = text_chars(e["message"].get("content"))
        if n < 400 or name in ("edit", "write", "recall"):
            continue
        life = requests_between(i, drop_at(i))
        aged = max(0, life - 4)
        status = "judged-kept" if e["id"] in judged else "never-judged"
        pot[f"{status} {bucket(n)}"] += n * aged
        pot[f"tool {name}"] += n * aged
    out["potential"] = dict(pot)
    out["edits"] = {
        "targets": sum(edit_kinds.values()),
        "byKind": dict(edit_kinds),
        "savedCharsByKind": dict(edit_saved_chars),
        "savedTokenRequests": saved_tok_req,
        "savedCostEst": saved_cost,
        "recalledByKind": dict(recalled),
        "refetchedByKind": dict(refetched),
        "baselineRefetch": dict(base),
        "penaltyTokens": penalty_tokens,
        "penaltyCostEst": penalty_cost,
        "editBatches": len(batches),
    }
    return out


def main():
    out_path, since = sys.argv[1], sys.argv[2]
    until = sys.argv[3] if len(sys.argv) > 3 else "9999"
    files = []
    for f in glob.glob(os.path.join(ROOT, "**/*.jsonl"), recursive=True):
        base = os.path.basename(f)
        # session files carry their start time in the name (or the parent dir for subagent runs)
        stamp = next(
            (p[:10] for p in os.path.relpath(f, ROOT).split("/") if p[:4] == "2026"),
            None,
        )
        if stamp is None:
            continue
        if since <= stamp < until:
            files.append(f)
    files.sort(key=lambda f: -os.path.getsize(f))
    with Pool(24) as pool, open(out_path, "w") as out:
        for n, r in enumerate(pool.imap_unordered(analyse, files, chunksize=1)):
            if r:
                out.write(json.dumps(r) + "\n")
            if n % 200 == 0:
                print(f"{n}/{len(files)}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
