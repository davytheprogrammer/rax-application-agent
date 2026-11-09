#!/usr/bin/env python3
"""Dependency-free PDF writer for application attachments."""
import json, os, sys

PAGE_W, PAGE_H = 595, 842
LEFT, TOP = 54, 770

def esc(value):
    return str(value).replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')

def clean(value):
    text = str(value or '').replace('\r\n', '\n').replace('\r', '\n')
    for old, new in {'\u2013':'-', '\u2014':'-', '\u2018':"'", '\u2019':"'", '\u201c':'"', '\u201d':'"', '\u2026':'...'}.items(): text = text.replace(old, new)
    return text.encode('latin-1', 'replace').decode('latin-1')

def wrap(text, width=92):
    words, lines, line = text.split(), [], ''
    for word in words:
        if len(line) + len(word) + 1 <= width: line = (line + ' ' + word).strip()
        else: lines.append(line); line = word
    if line: lines.append(line)
    return lines or ['']

def pages(title, content, author):
    lines = [('title', clean(title or 'Application Document'))]
    if author: lines += [('meta', clean(author))]
    lines.append(('space', ''))
    for paragraph in clean(content).split('\n'):
        lines.extend([('space', '')] if not paragraph.strip() else [('body', x) for x in wrap(paragraph)])
    return [lines[i:i+46] for i in range(0, max(1, len(lines)), 46)]

def build(data):
    doc_pages = pages(data.get('title'), data['content'], data.get('author'))
    streams = []
    for number, page in enumerate(doc_pages, 1):
        commands, y = ['BT'], TOP
        for kind, text in page:
            if kind == 'space': y -= 12; continue
            size, font = (16, '/F2') if kind == 'title' else ((9, '/F1') if kind == 'meta' else (11, '/F1'))
            commands += [f'{font} {size} Tf', f'1 0 0 1 {LEFT} {y} Tm', f'({esc(text)}) Tj']
            y -= 24 if kind == 'title' else 14
        commands += [f'/F1 8 Tf', f'1 0 0 1 {LEFT} 30 Tm', f'(Page {number} of {len(doc_pages)}) Tj', 'ET']
        streams.append('\n'.join(commands).encode('latin-1'))
    out, offsets = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'), [0]
    def obj(num, body):
        offsets.append(len(out)); out.extend(f'{num} 0 obj\n'.encode()); out.extend(body); out.extend(b'\nendobj\n')
    page_ids = list(range(5, 5 + len(streams))); stream_ids = list(range(5 + len(streams), 5 + 2 * len(streams)))
    obj(1, b'<< /Type /Catalog /Pages 2 0 R >>')
    obj(2, ('<< /Type /Pages /Kids [' + ' '.join(f'{x} 0 R' for x in page_ids) + f'] /Count {len(page_ids)} >>').encode())
    obj(3, b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    obj(4, b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>')
    for page_id, stream_id, stream in zip(page_ids, stream_ids, streams):
        obj(page_id, f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {stream_id} 0 R >>'.encode())
        obj(stream_id, f'<< /Length {len(stream)} >>\nstream\n'.encode() + stream + b'\nendstream')
    xref = len(out); total = len(offsets)
    out.extend(f'xref\n0 {total}\n0000000000 65535 f \n'.encode())
    out.extend(''.join(f'{offset:010d} 00000 n \n' for offset in offsets[1:]).encode())
    out.extend(f'trailer\n<< /Size {total} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    return bytes(out), len(doc_pages)

data = json.load(sys.stdin)
output = os.path.abspath(data['file'])
if not output.lower().endswith('.pdf'): raise ValueError('PDF output path must end in .pdf')
if not isinstance(data.get('content'), str) or not data['content'].strip(): raise ValueError('PDF content must be non-empty text')
os.makedirs(os.path.dirname(output), exist_ok=True)
pdf, count = build(data)
with open(output, 'wb') as handle: handle.write(pdf)
print(json.dumps({'created': output, 'bytes': len(pdf), 'pages': count}))
