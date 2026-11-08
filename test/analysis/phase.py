import json
from collections import defaultdict
src=open('cost.py').read()
exec(src.split('print("control')[0])
def group(r):
    g=r.get('guard',{})
    return 'jev ok' if g.get('jevOkPasses') else ('jev failing' if g.get('passes') else 'no guard')
def prov(r):
    m=r['models']; return max(m,key=m.get).split('/')[0]
T=defaultdict(lambda: defaultdict(float))
for r in rows:
    g=group(r)
    if g=='no guard': continue
    for ph,v in r.get('phaseValue',{}).items(): T[(g,prov(r),ph)]['value']+=v
    for ph,v in r.get('phaseTokens',{}).items(): T[(g,prov(r),ph)]['tokens']+=v
    for row in r['reqRows']:
        p, rs, gap, unc, med, ctx, cr, pr, pu, isedit, saved, ph = row
        if not isedit or med<0: continue
        exp = ratio.get((p, rs, gb(gap)), 0) * ctx
        t=T[(g,prov(r),ph or 'other')]
        t['penalty']+=max(0,max(0,unc-med)-exp)*max(0,pu-pr); t['batches']+=1
for k in sorted(T):
    t=T[k]
    print(f"{k!s:45} batches {int(t['batches']):5} saved {t['tokens']/1e9:5.2f}B value ${t['value']:7.0f} penalty ${t['penalty']:6.0f} net ${t['value']-t['penalty']:7.0f}")
