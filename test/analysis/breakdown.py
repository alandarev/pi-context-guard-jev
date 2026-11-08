import json
from collections import defaultdict, Counter
exec(open('cost.py').read().split('def group')[0].split('print("control')[0])
pen=defaultdict(lambda:[0,0.0,0.0])
for r in rows:
    if not r.get('guard',{}).get('jevOkPasses'): continue
    for prov, rs, gap, unc, med, ctx, cr, pr, pu, isedit, saved in r["reqRows"]:
        if not isedit or med<0: continue
        exp = ratio.get((prov, rs, gb(gap)), 0) * ctx
        k=(prov, 'runStart' if rs else 'mid-run', gb(gap))
        pen[k][0]+=1; pen[k][1]+=max(0,max(0,unc-med)-exp)*max(0,pu-pr); pen[k][2]+=max(0,unc-med)*max(0,pu-pr)
print("edit batches: count, controlled penalty, raw")
for k in sorted(pen): print(f"  {k!s:45} {pen[k][0]:5} ${pen[k][1]:7.0f} ${pen[k][2]:7.0f}")
pot=Counter()
for r in rows:
    if not r.get('guard',{}).get('jevOkPasses'): continue
    for a,b in r['potential'].items(): pot[a]+=b
print("\nremaining tool-result char-requests (aged >4 req, unedited, >=400ch), jev ok sessions:")
for a,b in pot.most_common(25): print(f"  {a:30} {b/1e9:6.2f}G")
