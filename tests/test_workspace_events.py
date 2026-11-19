"""Actual streamed WSGI/auth/storage invalidations. No real vendor or external send."""
import io
import json
import unittest
from openteamily.events import EventStream,Limits,snapshot
from tests import test_social_message_tools as helpers
from tests.test_management import Client,ORIGIN

class WorkspaceEventTests(unittest.TestCase):
    setUp=helpers.MessageToolTests.setUp
    send=helpers.MessageToolTests.send
    def env(self,client=None,**headers):
        client=client or self.alice
        return {'REQUEST_METHOD':'GET','PATH_INFO':f'/v1/workspaces/{self.wid}/events','QUERY_STRING':'','HTTP_HOST':'management.test','REMOTE_ADDR':client.peer,'HTTP_ORIGIN':ORIGIN,'HTTP_COOKIE':'; '.join(f'{k}={v}' for k,v in client.cookies.items()),'wsgi.input':io.BytesIO(),**headers}
    def stream(self,client=None,**headers):
        response={}
        def start(status,values):response.update(status=int(status.split()[0]),headers=dict(values))
        result=self.app(self.env(client,**headers),start)
        self.addCleanup(getattr(result,'close',lambda:None))
        return response,result
    def test_real_wsgi_stream_has_no_content_length_reconnect_digest_and_closes_without_leak(self):
        response,stream=self.stream();self.assertEqual(response['status'],200,response)
        self.assertNotIn('Content-Length',response['headers']);self.assertEqual(response['headers']['Cache-Control'],'no-store')
        self.assertIn('text/event-stream',response['headers']['Content-Type'])
        self.assertIn(b'connected',next(stream));packet=next(stream)
        self.assertIn(b'event: invalidate',packet)
        digest=packet.decode().split('id: ')[1].split('\n')[0]
        self.assertNotIn(self.source,packet.decode());self.assertNotIn('alice',packet.decode())
        stream.close();self.assertEqual(self.app.event_limits.users,{})
        _,again=self.stream(HTTP_LAST_EVENT_ID=digest);next(again);self.assertEqual(next(again),b': heartbeat\n\n');again.close()
    def test_private_conversation_never_changes_nonmember_snapshot_authorized_update_does(self):
        initial=snapshot(self.app,self.env(self.carol),self.wid)
        self.send(self.bob,'PRIVATE-SYNTHETIC-ONLY',self.source)
        self.assertEqual(snapshot(self.app,self.env(self.carol),self.wid),initial)
        self.send(self.alice,'visible to carol',self.target)
        changed=snapshot(self.app,self.env(self.carol),self.wid)
        self.assertNotEqual(changed[2]['social'],initial[2]['social'])
        self.assertEqual(changed[2]['artifacts'],initial[2]['artifacts'])
    def test_no_sleep_stream_emits_actual_persisted_change_then_session_revocation(self):
        env=self.env();initial=snapshot(self.app,env,self.wid);step=0
        def wait(_):
            nonlocal step
            if step==0:self.send(self.bob,'real stored fixture update',self.source)
            else:self.alice.call('POST','/v1/auth/logout',{})
            step+=1;return False
        stream=EventStream(self.app.event_limits,initial[0],lambda:snapshot(self.app,env,self.wid),initial,wait=wait,ticks=3)
        self.addCleanup(stream.close)
        packets=b''.join(stream);self.assertEqual(packets.count(b'event: invalidate'),2,packets)
        self.assertIn(b'event: revoked',packets);self.assertEqual(self.app.event_limits.users,{})
        self.assertNotIn(b'real stored fixture update',packets)
    def test_membership_revocation_and_limits_are_effective_not_cosmetic(self):
        env=self.env(self.bob);initial=snapshot(self.app,env,self.wid)
        def wait(_):
            bid=initial[0];removed=self.alice.call('POST',f'/v1/workspaces/{self.wid}/members/{bid}/remove',{})
            self.assertEqual(removed['status'],200,removed)
            return False
        stream=EventStream(self.app.event_limits,initial[0],lambda:snapshot(self.app,env,self.wid),initial,wait=wait,ticks=2)
        self.addCleanup(stream.close);self.assertIn(b'event: revoked',b''.join(stream))
        _,a=self.stream();_,b=self.stream();blocked,body=self.stream()
        self.assertEqual(blocked['status'],429);self.assertIn(b'stream_limit',b''.join(body));a.close();b.close()
        self.assertEqual(self.app.event_limits.users,{})
    def test_initial_auth_query_origin_head_and_host_errors_are_json_not_hanging_streams(self):
        for client,headers,status in [(Client(self.app),{},401),(self.alice,{'QUERY_STRING':'token=forbidden'},400),(self.alice,{'HTTP_LAST_EVENT_ID':'bad\r\ninjection'},400),(self.alice,{'HTTP_ORIGIN':'https://other.invalid'},403),(self.alice,{'HTTP_HOST':'other.invalid'},403)]:
            with self.subTest(headers=headers):
                response,stream=self.stream(client,**headers);self.assertEqual(response['status'],status,response);self.assertIsInstance(json.loads(b''.join(stream)),dict)
        self.assertEqual(self.app.event_limits.users,{})

    def test_elapsed_stream_and_never_started_stream_release_reservations(self):
        limits=Limits();stream=EventStream(limits,'synthetic-user',lambda:self.fail('expired stream queried storage'),('synthetic-user','a'*64,{}),wait=lambda _:False)
        stream.deadline=0;self.assertEqual(b''.join(stream),b'retry: 3000\n: connected\n\n');self.assertEqual(limits.users,{})
        unconsumed=EventStream(limits,'synthetic-user',lambda:None,('synthetic-user','a'*64,{}))
        unconsumed.close();unconsumed.close();self.assertEqual(limits.users,{})
