"""Real OOXML/PDF bytes, authenticated current/history exports, no external service."""
from io import BytesIO
import json
import re
import shutil
import subprocess
import unittest
from xml.etree import ElementTree as ET
from zipfile import ZipFile
from openteamily import office_exports
from tests import test_artifact_versions as helpers
from tests import test_artifact_dashboards as dashboard_helpers
from tests import test_artifact_slides as slide_helpers
from tests.test_management import Client

class OfficeExportTests(unittest.TestCase):
    setUp=helpers.ArtifactVersionTests.setUp
    create=helpers.ArtifactVersionTests.create
    def export(self,aid,format,revision=None,client=None):
        path=f'/v1/workspaces/{self.wid}/artifacts/{aid}'
        if revision:path+='/versions/'+str(revision)
        return (client or self.alice).call('GET',path+'/export?format='+format,parse='raw')
    def parts(self,payload):
        with ZipFile(BytesIO(payload)) as archive:
            self.assertIsNone(archive.testzip());names=archive.namelist()
            self.assertTrue(all(not name.startswith('/') and '..' not in name.split('/') for name in names))
            self.assertFalse(any('vba' in name.lower() for name in names))
            result={name:ET.fromstring(archive.read(name)) for name in names}
            self.assertFalse(any(node.attrib.get('TargetMode')=='External' for root in result.values() for node in root.iter()))
            return result
    def test_actual_word_package_unicode_escaped_text_and_immutable_historical_version(self):
        made=self.create(title='中文 & Report',body='# 原始标题\nA < B & x > y\nLiteral =SUM(A1)');aid=made['body']['artifact']['id']
        first=self.export(aid,'docx');self.assertEqual(first['status'],200,first)
        parts=self.parts(first['body']);document=parts['word/document.xml']
        text=''.join(document.itertext());self.assertIn('原始标题',text);self.assertIn('A < B & x > y',text)
        overrides={n.attrib.get('PartName'):n.attrib.get('ContentType') for n in parts['[Content_Types].xml']}
        self.assertEqual(overrides['/word/document.xml'],'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
        saved=self.alice.call('POST',f'/v1/workspaces/{self.wid}/artifacts/{aid}',{'revision':1,'changes':{'body':'CHANGED VERSION ONLY'}});self.assertEqual(saved['status'],200)
        old=self.export(aid,'docx',revision=1);self.assertEqual(old['status'],200,old)
        self.assertIn('原始标题',''.join(self.parts(old['body'])['word/document.xml'].itertext()))
        self.assertNotIn('CHANGED VERSION ONLY',''.join(self.parts(old['body'])['word/document.xml'].itertext()))
        current=self.export(aid,'docx');self.assertIn('CHANGED VERSION ONLY',''.join(self.parts(current['body'])['word/document.xml'].itertext()))
        headers=dict(old['headers']);self.assertIn('attachment',headers['Content-Disposition']);self.assertIn('sandbox',headers['Content-Security-Policy']);self.assertEqual(headers['X-Content-Type-Options'],'nosniff')
    def test_actual_unicode_pdf_xref_and_independent_poppler_extraction_if_available(self):
        made=self.create(title='中文证据',body='Hello evidence\n数字 123 与原文保持一致。\n'+('Pagination text\n'*100));aid=made['body']['artifact']['id']
        result=self.export(aid,'pdf');self.assertEqual(result['status'],200,result);payload=result['body']
        self.assertTrue(payload.startswith(b'%PDF-1.7'));self.assertTrue(payload.rstrip().endswith(b'%%EOF'))
        self.assertIn('中文证据'.encode('utf-16-be').hex().upper().encode(),payload)
        self.assertIn(b'/Count 3 ',payload)
        xref=int(re.search(rb'startxref\n(\d+)\n',payload)[1]);self.assertEqual(payload[xref:xref+4],b'xref')
        for number,offset in enumerate(re.findall(rb'^(\d{10}) 00000 n ',payload,re.M),1):self.assertTrue(payload[int(offset):].startswith(f'{number} 0 obj'.encode()))
        self.assertFalse(any(marker in payload for marker in (b'/JavaScript',b'/URI',b'/Launch',b'/OpenAction',b'/EmbeddedFile')))
        if shutil.which('pdftotext'):
            text=subprocess.run(['pdftotext','-','-'],input=payload,check=True,capture_output=True).stdout.decode()
            self.assertIn('中文证据',text);self.assertIn('Hello evidence',text);self.assertIn('123',text)
        emoji=self.alice.call('POST',f'/v1/workspaces/{self.wid}/artifacts/{aid}',{'revision':1,'changes':{'body':'Keep all Unicode 😀'}});self.assertEqual(emoji['status'],200)
        unsupported=self.export(aid,'pdf');self.assertEqual(unsupported['status'],400);self.assertIn(b'BMP',unsupported['body'])
        self.assertEqual(self.export(aid,'docx')['status'],200) # no silent lossy PDF substitute
    def test_real_dashboard_spreadsheet_preserves_rows_and_formula_like_values_as_text(self):
        value=dashboard_helpers.dashboard();value['widgets'][1]['rows'][0][1]='=HYPERLINK("https://invalid.example")'
        made=self.alice.call('POST',f'/v1/workspaces/{self.wid}/artifacts',{'title':'Workbook','kind':'dashboard','dashboard':value},{'HTTP_IDEMPOTENCY_KEY':'office-dash-create001'})
        self.assertEqual(made['status'],201,made);aid=made['body']['artifact']['id']
        result=self.export(aid,'xlsx');self.assertEqual(result['status'],200,result);parts=self.parts(result['body'])
        root=parts['xl/worksheets/sheet1.xml'];self.assertIn('=HYPERLINK("https://invalid.example")',''.join(root.itertext()))
        self.assertFalse(any(node.tag.endswith('}f') for node in root.iter()))
        self.assertTrue(all(node.attrib.get('t')=='inlineStr' for node in root.iter() if node.tag.endswith('}c')))
        self.assertEqual(self.export(aid,'xlsx',revision=1)['status'],200)
        self.assertEqual(self.export(aid,'docx')['status'],400)
    def test_auth_workspace_query_format_and_nonexport_paths_remain_strict(self):
        aid=self.create()['body']['artifact']['id'];base=f'/v1/workspaces/{self.wid}/artifacts/{aid}'
        outsider=Client(self.app,peer='127.0.0.3');outsider.register('outsider')
        self.assertEqual(self.export(aid,'docx',client=outsider)['status'],404)
        self.assertEqual(self.export(aid,'docx',client=Client(self.app))['status'],401)
        self.assertEqual(self.alice.call('GET',base.replace(self.wid,'f'*32)+'/export?format=docx')['status'],404)
        for query in ('format=docx&format=pdf','format=../../file','format=html','format=','format=docx&url=https://invalid.example','renderer=python','format=docx&user_id=other'):
            self.assertEqual(self.alice.call('GET',base+'/export?'+query)['status'],400,query)
        for path in ('/versions?format=docx','/versions/1?format=docx','?format=docx'):
            self.assertEqual(self.alice.call('GET',base+path)['status'],400,path)
        self.assertEqual(self.export(aid,'xlsx')['status'],400)
        self.assertEqual(self.export(aid,'pdf',revision=999)['status'],404)

    def test_actual_slides_pptx_unicode_no_macros_or_external_links_and_history(self):
        made=self.alice.call('POST',f'/v1/workspaces/{self.wid}/artifacts',
            {'title':'路线 & 报告','kind':'slides','slides':slide_helpers.deck(('目标',['统一入口 < B & C']),('下一步',['接入运行时','Literal =CMD()']))},
            {'HTTP_IDEMPOTENCY_KEY':'office-slides-create001'})
        self.assertEqual(made['status'],201,made);aid=made['body']['artifact']['id']
        result=self.export(aid,'pptx');self.assertEqual(result['status'],200,result)
        parts=self.parts(result['body']);slide=''.join(parts['ppt/slides/slide1.xml'].itertext())
        self.assertIn('目标',slide);self.assertIn('统一入口 < B & C',slide)
        self.assertIn('Literal =CMD()',''.join(parts['ppt/slides/slide2.xml'].itertext()))
        types={n.attrib.get('PartName'):n.attrib.get('ContentType') for n in parts['[Content_Types].xml']}
        self.assertEqual(types['/ppt/presentation.xml'],'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml')
        self.assertEqual(types['/ppt/slides/slide1.xml'],'application/vnd.openxmlformats-officedocument.presentationml.slide+xml')
        self.assertNotIn('vbaProject',types)
        saved=self.alice.call('POST',f'/v1/workspaces/{self.wid}/artifacts/{aid}',
            {'revision':1,'changes':{'slides':slide_helpers.deck(('CHANGED VERSION ONLY',['only in revision 2']))}})
        self.assertEqual(saved['status'],200,saved)
        old=self.export(aid,'pptx',revision=1);self.assertEqual(old['status'],200,old)
        historical=''.join(self.parts(old['body'])['ppt/slides/slide1.xml'].itertext())
        self.assertIn('目标',historical);self.assertNotIn('CHANGED VERSION ONLY',historical)
        current=''.join(self.parts(self.export(aid,'pptx')['body'])['ppt/slides/slide1.xml'].itertext())
        self.assertIn('CHANGED VERSION ONLY',current)
        headers=dict(old['headers']);self.assertIn('attachment',headers['Content-Disposition']);self.assertIn('.pptx',headers['Content-Disposition'])
        self.assertIn('sandbox',headers['Content-Security-Policy']);self.assertEqual(headers['X-Content-Type-Options'],'nosniff')
        self.assertEqual(self.export(aid,'docx')['status'],400)
        self.assertEqual(self.export(aid,'xlsx')['status'],400)
        self.assertEqual(self.export(self.create()['body']['artifact']['id'],'pptx')['status'],400)
