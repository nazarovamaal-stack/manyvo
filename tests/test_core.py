import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

from manyvo.core import Problem, Store, password_hash
from manyvo.moderation import DemoModerator, ModerationUnavailable, OpenAIModerator


class Clock:
    def __init__(self):
        self.now = 1800000000.0
    def __call__(self):
        return self.now


class DomainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password = password_hash('test-password')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.clock = Clock()
        self.path = Path(self.temp.name) / 'test.sqlite'
        self.store = Store(self.path, DemoModerator(), self.clock)
        with self.store.tx() as db:
            for user_id, role, age, country in [('owner','owner',25,'Россия'), ('other','owner',25,'Россия'),
                                              ('young','participant',17,'Россия'), ('foreign','participant',24,'Грузия'),
                                              ('incomplete','participant',None,None)] + [('p%d'%i,'participant',20+i,'Россия') for i in range(8)]:
                db.execute('INSERT INTO users VALUES (?,?,?,?,?,?,?)', (user_id,user_id+'@test.local',user_id,role,age,country,self.password))
        self.owner = self.store.user('owner')
        self.people = [self.store.user('p%d'%i) for i in range(8)]

    def draft(self, quota=5, variants=3):
        s = self.store.create(self.owner)
        return self.store.save(self.owner, s['id'], {'version':s['version'], 'title':'Выбираем заголовок', 'question':'Что выберете вы?',
            'quota':quota,'age_min':18,'age_max':65,'country':'Россия','options':[{'text':chr(65+i)} for i in range(variants)]})

    def opened(self, quota=5, variants=3):
        s = self.draft(quota, variants)
        return self.store.publish(self.owner, s['id'])

    def answer(self, s, person=0, personal=0, prediction=1):
        return self.store.answer(self.people[person], s['id'], {'personal_id':s['options'][personal]['id'], 'prediction_id':s['options'][prediction]['id']})

    def closed_tie(self):
        s = self.opened()
        for person, (personal, prediction) in enumerate(zip([0,0,1,1,2], [0,1,1,1,2])):
            self.answer(s, person, personal, prediction)
        return self.store.detail(self.owner,s['id'])

    def fact(self, s, values=(1,3,2), **changes):
        result = {'metric':'Заказы','unit':'шт.','start_date':'2026-10-01','end_date':'2026-10-07','is_rate':False,
                  'values':[{'option_id':o['id'],'value':v} for o,v in zip(s['options'], values)]}
        result.update(changes)
        return result

    def test_tc01_incomplete_draft_can_be_saved_and_completed(self):
        s = self.store.create(self.owner)
        for variants in [[],[{'text':'A'}]]:
            s = self.store.save(self.owner,s['id'],{'version':s['version'],'options':variants})
            self.assertEqual(s['status'],'draft')
            self.assertEqual(len(s['options']),len(variants))
        for count in [2,5]:
            for quota in [2,50,500]:
                s = self.store.save(self.owner,s['id'],{'version':s['version'],'options':[{'text':'A'}]*count,'quota':quota})
                self.assertEqual(s['quota'],quota)

    def test_tc01_invalid_save_preserves_previous_version(self):
        s = self.draft()
        bads = [{'quota':1}, {'quota':501}, {'quota':2.5}, {'quota':True}, {'options':[{'text':'A'}]*6},
                {'options':[{'text':'A'*501}]}, {'options':[{'image':'data:image/svg+xml;base64,abc'}]},
                {'options':[{'image':'data:image/png;base64,AAAA'}]}]
        for bad in bads:
            with self.subTest(bad=list(bad)):
                payload = dict(s, **bad)
                with self.assertRaises(Problem): self.store.save(self.owner,s['id'],payload)
                self.assertEqual(self.store.detail(self.owner,s['id']),s)

    def test_tc01_accepts_png_and_rejects_oversize_file(self):
        s=self.draft()
        png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTr0AAAAASUVORK5CYII='
        s=self.store.save(self.owner,s['id'],dict(s,options=[{'text':'A','image':png}]))
        self.assertEqual(s['options'][0]['image'],png)
        with self.assertRaises(Problem):
            self.store.save(self.owner,s['id'],dict(s,options=[{'image':'data:image/png;base64,'+'A'*(7*1024*1024)}]))

    def test_tc02_incomplete_publication_does_not_call_moderator(self):
        s=self.store.create(self.owner)
        with patch.object(self.store.moderator,'check') as moderator:
            with self.assertRaises(Problem): self.store.publish(self.owner,s['id'])
            moderator.assert_not_called()

    def test_tc02_default_quota_deadline_and_edit_protection(self):
        s=self.opened(quota=None)
        self.assertEqual(s['quota'],50)
        self.assertEqual(s['deadline']-s['published_at'],86400)
        with self.assertRaises(Problem): self.store.save(self.owner,s['id'],s)
        with self.assertRaises(Problem): self.store.publish(self.owner,s['id'])

    def test_tc02_rejection_timeout_and_full_recheck(self):
        s=self.draft()
        for outcome in [(False,'Запрещено'), ModerationUnavailable('Таймаут')]:
            with patch.object(self.store.moderator,'check',side_effect=outcome if isinstance(outcome,Exception) else None,
                              return_value=outcome) as moderator:
                result=self.store.publish(self.owner,s['id'])
                self.assertEqual(result['status'],'draft')
                self.assertTrue(result['moderation_reason'])
                self.assertEqual(len(moderator.call_args[0][1]),3)
        result=self.store.publish(self.owner,s['id'])
        self.assertEqual(result['status'],'open')

    def test_tc02_expired_old_approval_cannot_publish_new_version(self):
        s=self.draft()
        def late(study,options):
            with self.assertRaises(Problem): self.store.save(self.owner,s['id'],s)
            self.clock.now+=121
            self.store.settle()
            current=self.store.detail(self.owner,s['id'])
            self.store.save(self.owner,s['id'],dict(current,title='Новая версия'))
            return True,''
        with patch.object(self.store.moderator,'check',side_effect=late):
            result=self.store.publish(self.owner,s['id'])
        self.assertEqual(result['status'],'draft')
        self.assertEqual(result['title'],'Новая версия')

    def test_tc03_audience_role_and_age_enforced(self):
        s=self.opened()
        for name in ['young','foreign','incomplete','owner','other']:
            with self.subTest(name=name), self.assertRaises(Problem):
                self.store.answer(self.store.user(name),s['id'],{'personal_id':s['options'][0]['id'],'prediction_id':s['options'][0]['id']})
        self.answer(s)
        self.assertEqual(len(self.store.listing(self.store.user('foreign'))),0)

    def test_tc04_pair_required_same_option_allowed(self):
        s=self.opened()
        other=self.opened()
        for payload in [{'personal_id':s['options'][0]['id']}, {'prediction_id':s['options'][0]['id']},
                        {'personal_id':s['options'][0]['id'],'prediction_id':other['options'][0]['id']}]:
            with self.assertRaises(Problem): self.store.answer(self.people[0],s['id'],payload)
        self.assertEqual(self.store.detail(self.owner,s['id'])['count'],0)
        result=self.answer(s,personal=0,prediction=0)
        self.assertEqual(result['my_answer']['personal_id'],result['my_answer']['prediction_id'])

    def test_tc05_parallel_same_account_and_retries_are_idempotent(self):
        s=self.opened()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.answer(s),range(2)))
        self.assertEqual(results[0]['my_answer'],results[1]['my_answer'])
        self.answer(s,personal=2,prediction=2)
        self.assertEqual(self.store.detail(self.owner,s['id'])['count'],1)
        self.assertEqual(self.store.me(self.people[0])['balance'],1)

    def test_tc06_no_aggregates_for_owner_or_participant_before_close(self):
        s=self.opened()
        self.answer(s)
        owner=self.store.detail(self.owner,s['id'])
        participant=self.store.detail(self.people[0],s['id'])
        for response in [owner,participant]:
            self.assertFalse({'personal','predictions','personal_leaders','prediction_leaders','comparison'} & response.keys())
        self.assertEqual(owner['count'],1)
        self.assertNotIn('count',participant)
        self.assertIsNotNone(participant['my_answer'])

    def test_tc07_concurrent_last_slot_exactly_one_wins(self):
        s=self.opened(quota=2)
        self.answer(s,0)
        def send(person):
            try: self.answer(s,person); return 'accepted'
            except Problem as error: return error.status
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(send,[1,2]))
        self.assertEqual(results.count('accepted'),1)
        report=self.store.detail(self.owner,s['id'])
        self.assertEqual(report['count'],2)
        self.assertEqual(report['status'],'closed')

    def test_tc07_deadline_rejects_even_before_background_work(self):
        s=self.opened()
        self.answer(s)
        self.clock.now=s['deadline']
        with self.assertRaises(Problem): self.answer(s,1)
        report=self.store.detail(self.owner,s['id'])
        self.assertEqual(report['status'],'closed')
        self.assertFalse(report['complete'])
        self.assertEqual(report['count'],1)

    def test_tc08_two_distributions_and_tie(self):
        s=self.closed_tie()
        self.assertEqual([r['percent'] for r in s['personal']],[40,40,20])
        self.assertEqual([r['percent'] for r in s['predictions']],[20,60,20])
        self.assertEqual(s['personal_leaders'],[s['options'][0]['id'],s['options'][1]['id']])
        self.assertEqual(s['prediction_leaders'],[s['options'][1]['id']])

    def test_tc08_zero_answers_no_leaders(self):
        s=self.opened()
        self.clock.now=s['deadline']
        report=self.store.detail(self.owner,s['id'])
        self.assertEqual(report['personal'],[])
        self.assertEqual(report['personal_leaders'],[])
        self.assertEqual(report['comparison']['code'],'empty')

    def test_tc09_tc10_base_and_tie_bonus_no_duplicate_on_restart(self):
        s=self.closed_tie()
        self.assertEqual([self.store.me(u)['balance'] for u in self.people[:5]],[2,2,2,2,1])
        self.store=Store(self.path,DemoModerator(),self.clock)
        self.store.settle()
        self.answer(s,0,personal=2,prediction=2)
        self.assertEqual(self.store.me(self.people[0])['balance'],2)
        receipt=self.store.detail(self.people[0],s['id'])
        self.assertEqual(receipt['points'],{'base':1,'bonus':1})
        self.assertNotIn('comparison',receipt)
        self.assertNotIn('predictions',receipt)

    def test_tc10_incomplete_sample_still_awards_bonus(self):
        s=self.opened()
        self.answer(s,personal=0,prediction=0)
        self.clock.now=s['deadline']
        self.store.settle()
        self.assertEqual(self.store.me(self.people[0])['balance'],2)

    def test_tc11_invalid_fact_preserves_previous_full_version(self):
        s=self.closed_tie()
        s=self.store.save_fact(self.owner,s['id'],self.fact(s))
        old=s['comparison']['fact']
        bads=[{'values':self.fact(s)['values'][:2]}, {'values':[dict(v,value=-1) for v in self.fact(s)['values']]},
              {'values':[dict(v,value=float('nan')) for v in self.fact(s)['values']]},
              {'is_rate':True,'values':[dict(v,denominator=0) for v in self.fact(s)['values']]},
              {'start_date':'2026-12-01','end_date':'2026-01-01'}]
        for changes in bads:
            with self.assertRaises(Problem): self.store.save_fact(self.owner,s['id'],self.fact(s,**changes))
            self.assertEqual(self.store.detail(self.owner,s['id'])['comparison']['fact'],old)

    def test_tc12_all_comparison_outcomes_fact_versions_do_not_change_points(self):
        s=self.closed_tie()
        balances=[self.store.me(u)['balance'] for u in self.people]
        self.assertEqual(s['comparison']['code'],'no_fact')
        for version,(values,code) in enumerate([((1,3,2),'match'),((3,1,2),'mismatch'),((3,3,1),'tie')],1):
            result=self.store.save_fact(self.owner,s['id'],self.fact(s,values))
            self.assertEqual(result['comparison']['code'],code)
            self.assertEqual(result['comparison']['fact']['version'],version)
        self.assertEqual([self.store.me(u)['balance'] for u in self.people],balances)
        with closing(self.store.connect()) as db:
            self.assertEqual([r[0] for r in db.execute("SELECT fact_version FROM events WHERE type='fact_saved' ORDER BY rowid")],[1,2,3])

    def test_tc12_zero_answers_has_precedence_over_fact(self):
        s=self.opened()
        self.clock.now=s['deadline']
        s=self.store.detail(self.owner,s['id'])
        s=self.store.save_fact(self.owner,s['id'],self.fact(s))
        self.assertEqual(s['comparison']['code'],'empty')

    def test_tc14_transaction_rollback_preserves_answer_points_consistency(self):
        s=self.opened()
        with patch.object(self.store,'award',side_effect=RuntimeError('simulated crash')):
            with self.assertRaises(RuntimeError): self.answer(s)
        self.store=Store(self.path,DemoModerator(),self.clock)
        self.assertEqual(self.store.detail(self.owner,s['id'])['count'],0)
        self.assertEqual(self.store.me(self.people[0])['balance'],0)
        self.answer(s)
        self.assertEqual(self.store.me(self.people[0])['balance'],1)

    def test_tc14_failure_during_closing_rolls_back_and_recovers(self):
        s=self.opened(quota=2)
        self.answer(s,personal=0,prediction=0)
        original=self.store.award
        def fail_bonus(db,study,user,kind):
            if kind=='bonus': raise RuntimeError('simulated crash')
            original(db,study,user,kind)
        with patch.object(self.store,'award',side_effect=fail_bonus):
            with self.assertRaises(RuntimeError): self.answer(s,person=1,personal=0,prediction=0)
        self.store=Store(self.path,DemoModerator(),self.clock)
        self.assertEqual(self.store.detail(self.owner,s['id'])['count'],1)
        self.answer(s,person=1,personal=0,prediction=0)
        self.assertEqual(self.store.me(self.people[0])['balance'],2)
        self.assertEqual(self.store.me(self.people[1])['balance'],2)

    def test_tc15_owner_and_report_permissions(self):
        s=self.draft()
        for user in [self.people[0],self.store.user('other')]:
            with self.assertRaises(Problem): self.store.detail(user,s['id'])
            with self.assertRaises(Problem): self.store.save(user,s['id'],s)
            with self.assertRaises(Problem): self.store.publish(user,s['id'])
        s=self.closed_tie()
        with self.assertRaises(Problem): self.store.save_fact(self.people[0],s['id'],self.fact(s))
        with self.assertRaises(Problem): self.store.detail(self.store.user('other'),s['id'])
        with self.assertRaises(Problem): self.store.metrics(self.people[0])

    def test_tc16_unique_starts_completion_and_privacy(self):
        s=self.opened()
        for _ in range(3): self.store.detail(self.people[0],s['id'],opened=True)
        self.store.detail(self.people[1],s['id'],opened=True)
        self.answer(s)
        m=self.store.metrics(self.owner)
        self.assertEqual((m['starts'],m['pairs'],m['completion_percent']),(2,1,50))
        with closing(self.store.connect()) as db:
            events=[dict(r) for r in db.execute('SELECT * FROM events')]
        serialized=json.dumps(events)
        self.assertNotIn('p0@test.local',serialized)
        self.assertNotIn(s['question'],serialized)
        self.assertNotIn('test-password',serialized)
        self.assertTrue(all(e['event_id'] and e['at'] and e['study_id'] for e in events))

    def test_tc16_no_starts_is_no_data_and_latest_fact_used(self):
        self.assertIsNone(self.store.metrics(self.owner)['completion_percent'])
        s=self.closed_tie()
        self.store.save_fact(self.owner,s['id'],self.fact(s))
        self.assertEqual(self.store.metrics(self.owner)['agreement_percent'],100)
        self.store.save_fact(self.owner,s['id'],self.fact(s,(3,1,2)))
        self.assertEqual(self.store.metrics(self.owner)['agreement_percent'],0)
        self.store.save_fact(self.owner,s['id'],self.fact(s,(3,3,1)))
        self.assertIsNone(self.store.metrics(self.owner)['agreement_percent'])
        self.assertEqual(self.store.metrics(self.owner)['ties'],1)

    def test_tc17_deadline_closes_and_awards_within_one_worker_pass(self):
        s=self.opened()
        self.answer(s,personal=0,prediction=0)
        self.clock.now=s['deadline']+1
        self.store.settle()
        result=self.store.detail(self.owner,s['id'])
        self.assertEqual(result['status'],'closed')
        self.assertLessEqual(result['closed_at']-s['deadline'],10)
        self.assertEqual(self.store.me(self.people[0])['balance'],2)

    def test_login_session_expires_logout_and_no_password_exposure(self):
        token,csrf=self.store.login('OWNER@test.local','test-password')
        session=self.store.session(token)
        self.assertEqual(session['id'],'owner')
        self.assertNotIn('password_hash',self.store.me(session))
        self.assertTrue(csrf)
        self.store.logout(token)
        with self.assertRaises(Problem): self.store.session(token)
        token,_=self.store.login('owner@test.local','test-password')
        self.clock.now+=86401
        with self.assertRaises(Problem): self.store.session(token)
        with self.assertRaises(Problem): self.store.login('owner@test.local','wrong')


class OpenAIModerationTests(unittest.TestCase):
    def test_each_variant_text_and_image_sent_with_server_authorization(self):
        requests=[]
        def send(request,timeout):
            requests.append(request)
            return io.BytesIO(b'{"results":[{"flagged":false}]}')
        moderator=OpenAIModerator('test-key',transport=send)
        self.assertEqual(moderator.check({'title':'T','question':'Q'},[{'text':'A','image':'data:image/png;base64,test'},{'text':'B'}]),(True,''))
        self.assertEqual(len(requests),2)
        self.assertEqual(requests[0].full_url,'https://api.openai.com/v1/moderations')
        self.assertEqual(requests[0].get_header('Authorization'),'Bearer test-key')
        payload=json.loads(requests[0].data)
        self.assertEqual(payload['model'],'omni-moderation-latest')
        self.assertEqual(payload['input'][1]['type'],'image_url')

    def test_flagged_variant_rejected(self):
        m=OpenAIModerator('test',transport=lambda *args,**kw:io.BytesIO(b'{"results":[{"flagged":true}]}'))
        allowed,reason=m.check({'title':'T','question':'Q'},[{'text':'A'}])
        self.assertFalse(allowed)
        self.assertIn('1',reason)

    def test_missing_key_bad_response_timeout_and_http_error_fail_closed(self):
        cases=[OpenAIModerator(''),OpenAIModerator('test',transport=lambda *a,**kw:io.BytesIO(b'{"results":[]}')),
               OpenAIModerator('test',transport=lambda *a,**kw:io.BytesIO(b'{"results":[{"flagged":"false"}]}'))]
        def timeout(*args,**kwargs): raise TimeoutError('secret from remote')
        def unauth(*args,**kwargs): raise urllib.error.HTTPError('https://api.openai.com/v1/moderations',401,'secret',{},None)
        cases += [OpenAIModerator('test',transport=timeout),OpenAIModerator('test',transport=unauth)]
        for moderator in cases:
            with self.subTest(moderator=moderator), self.assertRaises(ModerationUnavailable) as error:
                moderator.check({'title':'T','question':'Q'},[{'text':'A'}])
            self.assertNotIn('secret',str(error.exception))


if __name__=='__main__':
    unittest.main()
