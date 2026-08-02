import json, collections
runs=collections.Counter(); last={}; err=collections.Counter()
scores=collections.defaultdict(list); recent=collections.Counter()
for l in open('/home/austin/agentic-os/audit/audit.log'):
    l=l.strip()
    if not l: continue
    try: d=json.loads(l)
    except: continue
    a=d.get('action'); ts=d.get('timestamp','')
    if ts.startswith('2026-08-02T1') and ts[12] in '789': recent[a]+=1
    if a=='skill_run':
        s=d.get('skill'); runs[s]+=1; last[s]=ts[:16]
        if str(d.get('output_preview','')).startswith('Error'): err[s]+=1
    elif a=='skill_scored':
        scores[d.get('skill')].append(d.get('score',0))
print('RUNS:')
for s,n in runs.most_common(): print(f'  {s}: {n} last={last[s]} errors={err[s]}')
print('SCORES:')
for k,v in sorted(scores.items(), key=lambda x:-sum(x[1])/len(x[1])): print(f'  {k}: {sum(v)/len(v):.1f} n={len(v)}')
print('SINCE 17:00 UTC:', dict(recent))
