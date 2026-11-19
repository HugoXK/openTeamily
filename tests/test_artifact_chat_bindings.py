"""Persisted work-to-chat references: pinned versions, forwarding, and access checks."""
import unittest
from tests import test_social_message_tools as helpers
from tests import test_artifact_slides as slides
from tests import test_artifact_dashboards as dashboards
from tests import test_artifact_media as media


class WorkChatTests(unittest.TestCase):
    setUp = helpers.MessageToolTests.setUp

    def create(self, kind):
        payload={'title':'Work '+kind,'kind':kind,'body':'Original work content.'}
        if kind=='slides':payload['slides']=slides.deck(('Original slide',('First fact',)))
        if kind=='dashboard':payload['dashboard']=dashboards.dashboard()
        if kind=='media':
            raw,typ=media.multipart([('title',payload['title']),('kind','media')],[('file','original.png','image/png',media.PNG)])
            made=self.alice.call('POST',f'/v1/workspaces/{self.wid}/artifacts',raw=raw,headers={'CONTENT_TYPE':typ,'HTTP_IDEMPOTENCY_KEY':'create-work-media-001'})
        else:made=self.alice.call('POST',f'/v1/workspaces/{self.wid}/artifacts',payload,{'HTTP_IDEMPOTENCY_KEY':'create-work-'+kind+'-001'})
        self.assertEqual(made['status'],201,made)
        return made['body']['artifact']

    def test_all_work_kinds_send_export_and_forward_with_pinned_content(self):
        for kind in ('document','website','whiteboard','slides','dashboard','media'):
            with self.subTest(kind=kind):
                item=self.create(kind)
                path=f'{self.base}/{self.source}/messages'
                body={'body':'','artifact_id':item['id'],'artifact_revision':item['revision']}
                headers={'HTTP_IDEMPOTENCY_KEY':'send-work-'+kind+'-0001'}
                self.assertEqual(self.alice.call('POST',path,body,headers,csrf=False)['status'],403)
                self.assertEqual(self.carol.call('POST',path,body,headers)['status'],404)
                made=self.alice.call('POST',path,body,headers)
                self.assertEqual(made['status'],201,made)
                message=made['body']['message'];attachment=message['attachment']
                self.assertEqual(attachment['kind'],kind)
                self.assertEqual(attachment['revision'],1)
                exported=self.bob.call('GET',attachment['path'],parse='raw')
                self.assertEqual(exported['status'],200,exported)
                self.assertGreater(len(exported['body']),0)
                self.assertEqual(self.alice.call('POST',path,body,headers)['body'],made['body'])
                forwarded=self.alice.call('POST',f'{self.base}/{self.source}/forward',{'message_ids':[message['id']],'target_conversation_id':self.target},{'HTTP_IDEMPOTENCY_KEY':'forward-work-'+kind+'-001'})
                self.assertEqual(forwarded['status'],201,forwarded)
                self.assertEqual(forwarded['body']['items'][0]['attachment'],attachment)
                self.assertEqual(self.carol.call('GET',attachment['path'],parse='raw')['body'],exported['body'])
                if kind=='document':
                    saved=self.alice.call('POST',f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}',{'revision':1,'changes':{'body':'New revision, not the shared snapshot.'}})
                    self.assertEqual(saved['status'],200,saved)
                    self.assertEqual(self.bob.call('GET',attachment['path'],parse='raw')['body'],exported['body'])
                    self.assertEqual(self.alice.call('POST',path,body,headers)['body'],made['body'])
                    conflict=self.alice.call('POST',path,body,{'HTTP_IDEMPOTENCY_KEY':'send-stale-revision-001'})
                    self.assertEqual(conflict['status'],409,conflict)
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM social_artifact_versions').fetchone()[0],12)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM artifact_shares').fetchone()[0],0)
