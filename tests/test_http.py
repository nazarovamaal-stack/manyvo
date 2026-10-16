"""HTTP-level checks of access, CSRF, sessions, API privacy and full journey."""
from contextlib import closing
from http.cookiejar import CookieJar
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from manyvo.core import Store, password_hash
from manyvo.moderation import DemoModerator
from manyvo.server import AppServer


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        cls.store=Store(Path(cls.temp.name)/'http.sqlite',DemoModerator())
        encoded=password_hash('test-password')
        with cls.store.tx() as db:
            for user,role in [('owner','owner'),('p0','participant'),('p1','participant')]:
                db.execute('INSERT INTO users VALUES (?,?,?,?,?,?,?)',(user,user+'@test.local',user,role,25,'Россия',encoded))
        cls.server=AppServer(('127.0.0.1',0),cls.store,demo=True)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.base='http://127.0.0.1:'+str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def client(self):
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def request(self,client,path,method='GET',body=None,csrf='',headers=None):
        req=urllib.request.Request(self.base+path,method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Content-Type':'application/json','X-Manyvo-Client':'web','X-CSRF-Token':csrf,**(headers or {})})
        try:
            with client.open(req,timeout=5) as response:
                raw=response.read()
                return response.status,json.loads(raw) if 'application/json' in response.headers.get('Content-Type','') else raw,response.headers
        except urllib.error.HTTPError as error:
            return error.code,json.load(error),error.headers

    def login(self,client,user):
        status,payload,headers=self.request(client,'/api/login','POST',{'email':user+'@test.local','password':'test-password'})
        self.assertEqual(status,200)
        self.assertIn('HttpOnly',headers['Set-Cookie'])
        return payload['csrf']

    def test_guest_blocked_invalid_origin_and_csrf_rejected(self):
        client=self.client()
        self.assertEqual(self.request(client,'/api/studies')[0],401)
        self.assertEqual(self.request(client,'/api/login','POST',{},headers={'Origin':'https://other.example'})[0],403)
        self.login(client,'owner')
        self.assertEqual(self.request(client,'/api/studies','POST',{})[0],403)
        self.assertEqual(self.request(client,'/api/studies','POST',{},headers={'Host':'evil.example'})[0],400)

    def test_complete_journey_from_draft_to_fact_and_participant_receipt(self):
        owner,p0,p1=self.client(),self.client(),self.client()
        csrf_owner=self.login(owner,'owner')
        csrf_p0=self.login(p0,'p0')
        csrf_p1=self.login(p1,'p1')
        status,s,_=self.request(owner,'/api/studies','POST',{},csrf_owner)
        self.assertEqual(status,201)
        path='/api/studies/'+s['id']
        payload={'version':s['version'],'title':'HTTP test','question':'A или B?','quota':2,'age_min':18,'age_max':65,'country':'Россия','options':[{'text':'A'},{'text':'B'}]}
        self.assertEqual(self.request(owner,path,'PUT',payload,csrf_owner)[0],200)
        _,s,_=self.request(owner,path+'/publish','POST',{},csrf_owner)
        self.assertEqual(s['status'],'open')
        ids=[o['id'] for o in s['options']]
        self.assertNotIn('personal',s)
        _,view,_=self.request(p0,path)
        self.assertNotIn('predictions',view)
        self.assertNotIn('count',view)
        for client,csrf in [(p0,csrf_p0),(p1,csrf_p1)]:
            status,receipt,_=self.request(client,path+'/answer','POST',{'personal_id':ids[0],'prediction_id':ids[0]},csrf)
            self.assertEqual(status,200)
        _,s,_=self.request(owner,path)
        self.assertEqual((s['status'],s['count']),('closed',2))
        self.assertEqual(s['personal'][0]['percent'],100)
        self.assertEqual(s['comparison']['code'],'no_fact')
        fact={'metric':'Заказы','unit':'шт.','start_date':'2026-10-01','end_date':'2026-10-02','is_rate':False,'values':[{'option_id':ids[0],'value':10},{'option_id':ids[1],'value':5}]}
        status,s,_=self.request(owner,path+'/fact','POST',fact,csrf_owner)
        self.assertEqual(status,200)
        self.assertEqual(s['comparison']['code'],'match')
        _,receipt,_=self.request(p0,path)
        self.assertEqual(receipt['points'],{'base':1,'bonus':1})
        self.assertNotIn('comparison',receipt)
        self.assertEqual(self.request(p0,path+'/fact','POST',fact,csrf_p0)[0],403)
        self.assertEqual(self.request(p0,'/api/me')[1]['balance'],2)
        self.assertEqual(len(self.request(p0,'/api/history')[1]['history']),2)
        self.request(p0,'/api/logout','POST',{},csrf_p0)
        self.assertEqual(self.request(p0,'/api/me')[0],401)

    def test_static_assets_and_private_files_not_served(self):
        client=self.client()
        for path in ['/','/app.js','/style.css','/favicon.svg']:
            status,body,headers=self.request(client,path)
            self.assertEqual(status,200)
            self.assertIn("frame-ancestors 'none'",headers['Content-Security-Policy'])
        for path in ['/.env','/data/manyvo.sqlite3','/manyvo/core.py','/../.env']:
            self.assertEqual(self.request(client,path)[0],404)
        config=self.request(client,'/api/config')[1]
        self.assertNotIn('api_key',config)

    def test_bad_json_and_non_json_are_rejected(self):
        client=self.client()
        req=urllib.request.Request(self.base+'/api/login',data=b'{}',headers={'Content-Type':'text/plain','X-Manyvo-Client':'web'})
        with self.assertRaises(urllib.error.HTTPError) as caught: client.open(req)
        self.assertEqual(caught.exception.code,415)
        req=urllib.request.Request(self.base+'/api/login',data=b'{bad',headers={'Content-Type':'application/json','X-Manyvo-Client':'web'})
        with self.assertRaises(urllib.error.HTTPError) as caught: client.open(req)
        self.assertEqual(caught.exception.code,400)
