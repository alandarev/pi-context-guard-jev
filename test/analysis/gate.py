import json
from collections import defaultdict
src=open('cost.py').read()
exec(src.split('print("control')[0])
res=defaultdict(lambda: defaultdict(float))
for r in rows:
    if not r.get('guard',{}).get('jevOkPasses'): continue
    rr=r['reqRows']
    for k,(saved,val,ph) in ((int(a),b) for a,b in r.get('batchValues',{}).items()):
        if ph!='run-end' or k>=len(rr): continue
        p, rs, gap, unc, med, ctx, cr, pr, pu, isedit, acc, _ = rr[k]
        if med<0: continue
        exp = ratio.get((p, rs, gb(gap)), 0) * ctx
        pen = max(0,max(0,unc-med)-exp)*max(0,pu-pr)
        reqs_so_far=k
        for factor in (0, 4, 8, 13, 16, 26):
            ok = saved*max(1,reqs_so_far) >= factor*ctx  # ctx ~ rewrite on codex
            t=res[(p,factor)]
            if ok: t['val']+=val; t['pen']+=pen; t['n']+=1
            else: t['skipVal']+=val; t['skipPen']+=pen; t['skipped']+=1
for k in sorted(res):
    t=res[k]
    print(f"{k!s:24} applied {int(t['n']):5} net ${t['val']-t['pen']:7.0f} (val {t['val']:6.0f} pen {t['pen']:6.0f}) | skipped {int(t['skipped']):5} would-be net ${t['skipVal']-t['skipPen']:7.0f}")
