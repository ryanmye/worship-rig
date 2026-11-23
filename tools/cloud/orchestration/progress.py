import json,os,glob,time,subprocess
W='/root/.claude/projects/-home-claude/7e62a35d-8374-53c8-b5e9-fdad80c27279/subagents/workflows/'
RUNS=[r.strip() for r in open(os.path.join(os.path.dirname(__file__),'runs.txt')) if r.strip()]
R='/home/claude/worship-rig'
parts=[]
for run in RUNS:
    J=W+run; st={}; order=[]; DONE=set()
    try:
        for l in open(J+'/journal.jsonl'):
            try: e=json.loads(l)
            except: continue
            lab=e.get('label')
            if lab:
                st.setdefault(lab,{})[e.get('type')]=e.get('agentId')
                if lab not in order: order.append(lab)
            if e.get('type')=='result': DONE.add(e.get('agentId'))
    except FileNotFoundError: continue
    for lab in order:
        aid=st[lab].get('started')
        if aid in DONE: parts.append(f"{lab}=DONE"); continue
        f=glob.glob(f"{J}/agent-{aid}.jsonl"); last='';tools=0;age=''
        if f:
            age=int(time.time()-os.path.getmtime(f[0]))
            for l in open(f[0]):
                try: m=json.loads(l)
                except: continue
                c=(m.get('message') or {}).get('content')
                if isinstance(c,list):
                    for b in c:
                        if b.get('type')=='tool_use': tools+=1
                        if b.get('type')=='text' and len(b.get('text',''))>15: last=b['text'].strip().replace('\n',' ')[:80]
        parts.append(f"{lab}=running({tools} calls, idle {age}s): {last}")
def sh(c):
    try: return subprocess.run(c,shell=True,cwd=R,capture_output=True,text=True,timeout=25).stdout.strip()
    except Exception: return '?'
core=sh("find native/core/src native/core/tests -name '*.cpp' -o -name '*.h' 2>/dev/null | wc -l")
dirty=sh("git status --short | wc -l"); tip=sh("git rev-parse --short v2-native"); load=sh("cut -d' ' -f1 /proc/loadavg")
print(time.strftime('%H:%MZ',time.gmtime())+" | "+" || ".join(parts)+f" || core_files={core} load={load} | local={tip} uncommitted={dirty}")
