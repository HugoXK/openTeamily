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
MIME = {'docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','pdf':'application/pdf'}


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
    elif format=='pdf' and kind in ('document','slides','dashboard'):
        text=row['body']
        if kind=='slides':text='\n\n'.join(s.get('title','')+'\n'+'\n'.join(s.get('bullets',[])) for s in (structured or {}).get('slides',[]))
        if kind=='dashboard':text='\n'.join(' | '.join(map(str,r)) for r in structured_rows('',structured))
        payload=pdf(row['title'],text)
    else:raise ValueError('Format is not supported for this artifact kind')
    return payload,MIME[format],f'{kind}-r{row["revision"]}.{format}'
