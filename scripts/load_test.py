"""TC-13 local load profile: 100 authenticated users, GET + new answer, 10 minutes.
Isolated temporary database and server. Never touches application data or OpenAI.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
import json
import math
from pathlib import Path
import secrets
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from manyvo.core import Store, password_hash
from manyvo.moderation import DemoModerator
from manyvo.server import AppServer


def run(duration, users):
    with tempfile.TemporaryDirectory() as folder:
        store=Store(Path(folder)/'load.sqlite',DemoModerator())
        encoded=password_hash('load-test-password')
        clients=[]
        with store.tx() as db:
            db.execute('INSERT INTO users VALUES (?,?,?,?,?,?,?)',('owner','owner@load.local','Owner','owner',25,'Россия',encoded))
            for i in range(users):
                user_id='u%d'%i
                db.execute('INSERT INTO users VALUES (?,?,?,?,?,?,?)',(user_id,user_id+'@load.local',user_id,'participant',25,'Россия',encoded))
                token,csrf=secrets.token_urlsafe(32),secrets.token_urlsafe(24)
                db.execute('INSERT INTO sessions VALUES (?,?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),user_id,csrf,time.time()+86400))
                clients.append({'Cookie':'manyvo_session='+token,'X-CSRF-Token':csrf,'X-Manyvo-Client':'web','Content-Type':'application/json'})
        owner=store.user('owner')
        server=AppServer(('127.0.0.1',0),store,demo=True)
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        base='http://127.0.0.1:'+str(server.server_port)
        # HTTP duration is measured on the client, including queueing and network,
        # a stricter bound than application processing time alone.
        samples={'get':[],'answer':[]}
        errors=[]
        start=time.monotonic()
        rounds=0
        def client_round(args):
            headers,study,barrier=args
            barrier.wait()
            for kind in ['get','answer']:
                payload={'personal_id':study['options'][0]['id'],'prediction_id':study['options'][0]['id']}
                req=urllib.request.Request(base+'/api/studies/'+study['id']+('/answer' if kind=='answer' else ''),
                    data=json.dumps(payload).encode() if kind=='answer' else None,headers=headers,method='POST' if kind=='answer' else 'GET')
                before=time.monotonic()
                try:
                    with urllib.request.urlopen(req,timeout=20) as response:
                        response.read()
                        code=response.status
                except urllib.error.HTTPError as error:
                    code=error.code
                except Exception as error:
                    code=0
                elapsed=time.monotonic()-before
                samples[kind].append(elapsed)
                if code!=200: errors.append({'operation':kind,'status':code})
        try:
            with ThreadPoolExecutor(max_workers=users) as pool:
                while time.monotonic()-start < duration:
                    study=store.create(owner)
                    study=store.save(owner,study['id'],dict(study,title='Load test',question='A or B?',quota=max(2,users),age_min=18,age_max=65,country='Россия',options=[{'text':'A'},{'text':'B'}]))
                    study=store.publish(owner,study['id'])
                    barrier=threading.Barrier(users)
                    list(pool.map(client_round,[(h,study,barrier) for h in clients]))
                    rounds+=1
                    if rounds%10==0:
                        print('Progress: %ds, %d rounds, %d requests, %d errors' % (time.monotonic()-start,rounds,sum(map(len,samples.values())),len(errors)),flush=True)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        elapsed=time.monotonic()-start
        summary={kind:{'requests':len(values),'p95_seconds':round(sorted(values)[max(0,math.ceil(len(values)*.95)-1)],4),'max_seconds':round(max(values),4)} for kind,values in samples.items()}
        count=sum(map(len,samples.values()))
        failed=sum(e['status']==0 or e['status']>=500 for e in errors)
        result={'profile':'Concurrent waves of authenticated users. Every wave GETs one new study and submits a new valid pair per user.',
                'users':users,'requested_duration_seconds':duration,'elapsed_seconds':round(elapsed,2),'rounds':rounds,
                'operations':summary,'non_200':len(errors),'server_or_transport_error_percent':round(100*failed/count,3),
                'passed':all(v['p95_seconds']<=2 for v in summary.values()) and failed/count<=.01 and not errors,
                'full_tc13_profile':users==100 and duration>=600}
        print(json.dumps(result,indent=2),flush=True)
        return result


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--seconds',type=int,default=600)
    parser.add_argument('--users',type=int,default=100)
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    result=run(args.seconds,args.users)
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    sys.exit(0 if result['passed'] else 1)
