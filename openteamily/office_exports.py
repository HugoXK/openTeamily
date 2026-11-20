"""Bounded original OOXML/text-PDF exporters. No subprocess, URL fetch, macro or external relationship."""
from io import BytesIO
import re
import unicodedata
from xml.sax.saxutils import escape
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'
WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
SHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
DRAW = 'http://schemas.openxmlformats.org/drawingml/2006/main'
PML = 'http://schemas.openxmlformats.org/presentationml/2006/main'
MIME = {'docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','pdf':'application/pdf'}


def clean(text):
    # XML 1.0 and PDF UTF-16 cannot represent isolated surrogates/control characters.
    return ''.join(c for c in str(text) if c in '\n\r\t' or (32<=ord(c)<=0xd7ff) or (0xe000<=ord(c)<=0xfffd) or (0x10000<=ord(c)<=0x10ffff))


def zip_parts(parts, main, content_types):
    parts = dict(parts)
    parts['_rels/.rels'] = XML+f'<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{OFFICE}officeDocument" Target="{main}"/></Relationships>'
    parts['[Content_Types].xml'] = XML+f'<Types xmlns="{TYPES}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'+''.join(f'<Override PartName="/{name}" ContentType="{kind}"/>' for name,kind in content_types.items())+'</Types>'
    output = BytesIO()
    with ZipFile(output,'w',ZIP_DEFLATED) as archive:
        for name,value in parts.items():
            info=ZipInfo(name,date_time=(1980,1,1,0,0,0));info.compress_type=ZIP_DEFLATED;info.external_attr=0o600<<16
            archive.writestr(info,value.encode('utf-8'))
    return output.getvalue()


def docx(title,body):
    def paragraph(text,style=None):
        return '<w:p>'+ ('<w:pPr><w:pStyle w:val="'+style+'"/></w:pPr>' if style else '')+'<w:r><w:t xml:space="preserve">'+escape(clean(text))+'</w:t></w:r></w:p>'
    paragraphs = [paragraph(title,'Title')]
    for line in body.replace('\r\n','\n').split('\n'):
        heading = re.match(r'^(#{1,3}) (.+)$',line)
        paragraphs.append(paragraph(heading[2], 'Heading'+str(len(heading[1]))) if heading else paragraph(line))
    document = XML+f'<w:document xmlns:w="{WORD}"><w:body>'+''.join(paragraphs)+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>'
    styles = XML+f'<w:styles xmlns:w="{WORD}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>'+''.join('<w:style w:type="paragraph" w:styleId="'+name+'"><w:name w:val="'+name+'"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="'+size+'"/></w:rPr></w:style>' for name,size in [('Title','36'),('Heading1','32'),('Heading2','28'),('Heading3','24')])+'</w:styles>'
    rels = XML+f'<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{OFFICE}styles" Target="styles.xml"/></Relationships>'
    return zip_parts({'word/document.xml':document,'word/styles.xml':styles,'word/_rels/document.xml.rels':rels},'word/document.xml',{'word/document.xml':'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml','word/styles.xml':'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'})


def xlsx(rows):
    if len(rows)>3000 or any(len(row)>100 for row in rows):
        raise ValueError('Spreadsheet exceeds bounded export capacity')
    def column(index):
        value=''
        while index:
            index,rem=divmod(index-1,26);value=chr(65+rem)+value
        return value
    # Always inline strings: a user value beginning with =,+,-,@ is NEVER a formula.
    data=''.join('<row r="'+str(n)+'">'+''.join('<c r="'+column(c)+str(n)+'" t="inlineStr"><is><t xml:space="preserve">'+escape(clean(value))+'</t></is></c>' for c,value in enumerate(row,1))+'</row>' for n,row in enumerate(rows,1))
    sheet=XML+f'<worksheet xmlns="{SHEET}"><sheetData>'+data+'</sheetData></worksheet>'
    workbook=XML+f'<workbook xmlns="{SHEET}" xmlns:r="{OFFICE[:-1]}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'
    rels=XML+f'<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{OFFICE}worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    return zip_parts({'xl/workbook.xml':workbook,'xl/worksheets/sheet1.xml':sheet,'xl/_rels/workbook.xml.rels':rels},'xl/workbook.xml',{'xl/workbook.xml':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml','xl/worksheets/sheet1.xml':'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'})


def pdf(title,text):
    """Actual paginated Unicode text PDF, NOT a browser screenshot/layout renderer.

    The standard Adobe-GB1 CJK font is referenced, not bundled/copied. Readers
    may substitute their CJK font. An explicit ToUnicode map preserves extraction.
    """
    lines=[]
    for paragraph in (clean(title)+'\n\n'+clean(text)).expandtabs(4).replace('\r\n','\n').split('\n'):
        line='';width=0
        for char in paragraph:
            # Non-BMP characters have extraction mappings; viewer glyph coverage varies.
            size=2 if unicodedata.east_asian_width(char) in ('W','F') else 1
            if width+size>76:
                lines.append(line);line='';width=0
            line+=char;width+=size
        lines.append(line)
    pages=[lines[i:i+42] for i in range(0,len(lines),42)] or [['']]
    if len(pages)>64:
        raise ValueError('Text PDF exceeds 64 pages')
    # Identity UTF-16 CIDs with a Unicode map, not Latin-1 replacement/lost Chinese.
    chars=sorted(set(''.join(lines)))
    if any(ord(c)>0xffff for c in chars):
        raise ValueError('Text PDF currently supports BMP Unicode only; use DOCX for emoji/non-BMP text')
    # Rebuild bfchar with UTF-16 codes matching the predefined font encoding.
    cmap='/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /OpenTeamilyUnicode def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n'
    for start in range(0,len(chars),100):
        chunk=chars[start:start+100];cmap+=str(len(chunk))+' beginbfchar\n'+''.join(f'<{ord(c):04X}> <{ord(c):04X}>\n' for c in chunk)+'endbfchar\n'
    cmap+='endcmap CMapName currentdict /CMap defineresource pop end end'
    def stream(raw):
        raw=raw if isinstance(raw,bytes) else raw.encode('ascii')
        return b'<< /Length '+str(len(raw)).encode()+b' >>\nstream\n'+raw+b'\nendstream'
    objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'',b'<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>',b'<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 /W [1 95 500] /FontDescriptor << /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >> >>',stream(cmap)]
    kids=[]
    for page in pages:
        index=len(objects)+1;kids.append(f'{index} 0 R')
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents {index+1} 0 R >>'.encode())
        content='BT /F1 12 Tf 54 788 Td 17 TL\n'+'\n'.join('<'+line.encode('utf-16-be').hex().upper()+'> Tj T*' for line in page)+'\nET'
        objects.append(stream(content))
    objects[1]=f'<< /Type /Pages /Count {len(pages)} /Kids [{" ".join(kids)}] >>'.encode()
    output=bytearray(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');offsets=[0]
    for index,obj in enumerate(objects,1):
        offsets.append(len(output));output.extend(f'{index} 0 obj\n'.encode()+obj+b'\nendobj\n')
    xref=len(output);output.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:output.extend(f'{offset:010d} 00000 n \n'.encode())
    output.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    return bytes(output)




def pptx(title, slides):
    """Actual PresentationML package: one slide per deck entry, title plus bullets.

    No macros, charts, media, animations, or external relationships. This is a
    structured text deck, not a rendered thumbnail or a full Office editor.
    """
    deck = list(slides or [])
    if not deck:
        deck = [{'title': title or '幻灯片', 'bullets': []}]
    if len(deck) > 30:
        raise ValueError('Presentation exceeds 30 slides')
    def tx(text, size, bold=False):
        run = '<a:r><a:rPr lang="zh-CN" sz="'+str(size)+'"'+(' b="1"' if bold else '')+' dirty="0"/><a:t>'+escape(clean(text))+'</a:t></a:r>'
        return '<a:p><a:pPr algn="l"/>'+run+'<a:endParaRPr lang="zh-CN" sz="'+str(size)+'"/></a:p>'
    def shape(ident, name, x, y, cx, cy, paragraphs):
        return ('<p:sp><p:nvSpPr><p:cNvPr id="'+str(ident)+'" name="'+name+'"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
                '<p:spPr><a:xfrm><a:off x="'+str(x)+'" y="'+str(y)+'"/><a:ext cx="'+str(cx)+'" cy="'+str(cy)+'"/></a:xfrm>'
                '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
                '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/><a:lstStyle/>'+paragraphs+'</p:txBody></p:sp>')
    def slide_xml(entry):
        heading = entry.get('title') or title or ''
        bullets = [item for item in (entry.get('bullets') or []) if str(item).strip()]
        body = ''.join(tx(('• '+item) if item else '', 2000) for item in bullets) or tx('', 2000)
        tree = ('<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
                '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
                + shape(2, 'Title', 457200, 274638, 8229600, 1143000, tx(heading, 3200, True))
                + shape(3, 'Content', 457200, 1600200, 8229600, 3143250, body))
        return XML+f'<p:sld xmlns:a="{DRAW}" xmlns:r="{OFFICE[:-1]}" xmlns:p="{PML}"><p:cSld><p:spTree>'+tree+f'</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
    theme = XML+f'<a:theme xmlns:a="{DRAW}" name="OpenTeamily"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F4E79"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="5B9BD5"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="4472C4"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>'
    layout = XML+f'<p:sldLayout xmlns:a="{DRAW}" xmlns:r="{OFFICE[:-1]}" xmlns:p="{PML}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
    master = XML+f'<p:sldMaster xmlns:a="{DRAW}" xmlns:r="{OFFICE[:-1]}" xmlns:p="{PML}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="lt1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>'
    parts = {
        'ppt/theme/theme1.xml': theme,
        'ppt/slideLayouts/slideLayout1.xml': layout,
        'ppt/slideLayouts/_rels/slideLayout1.xml.rels': XML+f'<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{OFFICE}slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>',
        'ppt/slideMasters/slideMaster1.xml': master,
        'ppt/slideMasters/_rels/slideMaster1.xml.rels': XML+f'<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{OFFICE}slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="{OFFICE}theme" Target="../theme/theme1.xml"/></Relationships>',
        'ppt/presProps.xml': XML+f'<p:presentationPr xmlns:p="{PML}"/>',
        'ppt/viewProps.xml': XML+f'<p:viewPr xmlns:p="{PML}"><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr></p:viewPr>',
        'ppt/tableStyles.xml': XML+f'<a:tblStyleLst xmlns:a="{DRAW}" def="{{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}}"/>',
    }
    slide_rels = []
    types = {
        'ppt/presentation.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
        'ppt/slideMasters/slideMaster1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
        'ppt/slideLayouts/slideLayout1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
        'ppt/theme/theme1.xml': 'application/vnd.openxmlformats-officedocument.theme+xml',
        'ppt/presProps.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
        'ppt/viewProps.xml': 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
        'ppt/tableStyles.xml': 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
    }
    for index, entry in enumerate(deck, 1):
        name = f'ppt/slides/slide{index}.xml'
        parts[name] = slide_xml(entry)
        parts[f'ppt/slides/_rels/slide{index}.xml.rels'] = XML+f'<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{OFFICE}slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>'
        types[name] = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
        slide_rels.append(f'<Relationship Id="rId{index}" Type="{OFFICE}slide" Target="slides/slide{index}.xml"/>')
    # rId after slides: master, presProps, viewProps, tableStyles
    base = len(deck)
    presentation = XML+f'<p:presentation xmlns:a="{DRAW}" xmlns:r="{OFFICE[:-1]}" xmlns:p="{PML}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId{base+1}"/></p:sldMasterIdLst><p:sldIdLst>'+''.join(f'<p:sldId id="{255+i}" r:id="rId{i}"/>' for i in range(1, len(deck)+1))+'</p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>'
    parts['ppt/presentation.xml'] = presentation
    parts['ppt/_rels/presentation.xml.rels'] = XML+f'<Relationships xmlns="{REL}">'+''.join(slide_rels)+f'<Relationship Id="rId{base+1}" Type="{OFFICE}slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId{base+2}" Type="{OFFICE}presProps" Target="presProps.xml"/><Relationship Id="rId{base+3}" Type="{OFFICE}viewProps" Target="viewProps.xml"/><Relationship Id="rId{base+4}" Type="{OFFICE}tableStyles" Target="tableStyles.xml"/></Relationships>'
    return zip_parts(parts, 'ppt/presentation.xml', types)


def structured_rows(title,dashboard):
    rows=[[title]]
    for widget in (dashboard or {}).get('widgets',[]):
        rows.append([widget.get('title','')]);kind=widget.get('type')
        if kind=='table':rows.extend([widget.get('columns',[])]+widget.get('rows',[]))
        elif kind=='bar':rows.extend([[label,str(value)] for label,value in zip(widget.get('labels',[]),widget.get('values',[]))])
        else:rows.append([widget.get('value',''),widget.get('note','')])
        rows.append([])
    return rows


def export(row,format,from_version=False):
    from . import artifacts
    kind=row['kind'] if from_version else artifacts.public_kind(row)
    structured=None
    if kind=='dashboard':structured=artifacts.decode_dashboard(row['dashboard_json'])
    elif kind=='slides':structured=artifacts.decode_slides(row['slides_json'])
    elif kind=='document':
        detected,structured=artifacts.decode_structured(row['body'])
        if structured is not None:kind=detected
    if format=='docx' and kind=='document':payload=docx(row['title'],row['body'])
    elif format=='xlsx' and kind=='dashboard':payload=xlsx(structured_rows(row['title'],structured))
    elif format=='pptx' and kind=='slides':payload=pptx(row['title'], (structured or {}).get('slides',[]))
    elif format=='pdf' and kind in ('document','slides','dashboard'):
        text=row['body']
        if kind=='slides':text='\n\n'.join(s.get('title','')+'\n'+'\n'.join(s.get('bullets',[])) for s in (structured or {}).get('slides',[]))
        if kind=='dashboard':text='\n'.join(' | '.join(map(str,r)) for r in structured_rows('',structured))
        payload=pdf(row['title'],text)
    else:raise ValueError('Format is not supported for this artifact kind')
    return payload,MIME[format],f'{kind}-r{row["revision"]}.{format}'
