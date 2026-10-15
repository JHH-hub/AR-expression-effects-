"""Build PDF, HTML and editable Markdown from one set of source documents."""
from pathlib import Path
import re, json, html, base64
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle, KeepTogether, Image as PDFImage
from reportlab.lib.pagesizes import A4
from pypdf import PdfReader

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output'; (OUT/'pdf').mkdir(parents=True,exist_ok=True)
pdfmetrics.registerFont(TTFont('CN', 'C:/Windows/Fonts/simhei.ttf'))
pdfmetrics.registerFontFamily('CN',normal='CN',bold='CN',italic='CN',boldItalic='CN')
ink=colors.HexColor('#182B43'); teal=colors.HexColor('#117E80'); pale=colors.HexColor('#ECF4F5')
styles={
 'p':ParagraphStyle('p',fontName='CN',fontSize=10,leading=16,spaceAfter=8,textColor=ink,wordWrap='CJK'),
 'h1':ParagraphStyle('h1',fontName='CN',fontSize=23,leading=31,spaceAfter=18,textColor=ink,keepWithNext=True,wordWrap='CJK'),
 'h2':ParagraphStyle('h2',fontName='CN',fontSize=14,leading=22,spaceBefore=14,spaceAfter=10,textColor=teal,keepWithNext=True,wordWrap='CJK'),
 'cell':ParagraphStyle('cell',fontName='CN',fontSize=8.4,leading=12.4,spaceAfter=0,textColor=ink,wordWrap='CJK'),
 'head':ParagraphStyle('head',fontName='CN',fontSize=8.4,leading=12.4,spaceAfter=0,textColor=colors.white,wordWrap='CJK'),
 'code':ParagraphStyle('code',fontName='CN',fontSize=8,leading=11,spaceAfter=10,leftIndent=8,rightIndent=8,backColor=pale,borderPadding=8,wordWrap='CJK'),
 'muted':ParagraphStyle('muted',fontName='CN',fontSize=9,leading=15,spaceAfter=9,textColor=colors.HexColor('#617183'),wordWrap='CJK'),
 'label':ParagraphStyle('label',fontName='CN',fontSize=10,leading=16,spaceAfter=8,textColor=ink,wordWrap='CJK',keepWithNext=True),
 'cover':ParagraphStyle('cover',fontName='CN',fontSize=35,leading=48,spaceAfter=22,textColor=ink,wordWrap='CJK'),
}
def escape(s):
    s=html.escape(s)
    s=re.sub(r'`([^`]+)`',r'<b>\1</b>',s)
    s=re.sub(r'\*\*([^*]+)\*\*',r'<b>\1</b>',s)
    return s
def p(s,style='p'): return Paragraph(escape(s),styles[style])
def md_blocks(md):
    lines=md.splitlines(); i=0
    while i<len(lines):
        line=lines[i].strip()
        if not line: i+=1; continue
        if line.startswith('```'):
            lang=line[3:]; i+=1; data=[]
            while i<len(lines) and not lines[i].startswith('```'): data.append(lines[i]); i+=1
            text='\n'.join(data)
            if lang=='json': text=json.dumps(json.loads(text),ensure_ascii=False,indent=2)
            yield 'code',text; i+=1; continue
        if line.startswith('|'):
            rows=[]
            while i<len(lines) and lines[i].strip().startswith('|'):
                cells=[c.strip() for c in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r'[:\- ]+',c) for c in cells): rows.append(cells)
                i+=1
            yield 'table',rows; continue
        if line.startswith('# '): yield 'h1',line[2:]
        elif line.startswith('## '): yield 'h2',line[3:]
        elif line.startswith('- '): yield 'p','- '+line[2:]
        else: yield 'p',line
        i+=1
def pdf_blocks(md):
    flow=[]
    for kind,value in md_blocks(md):
        if kind=='table':
            count=len(value[0]); width=A4[0]-88
            if count==5 and value[0][1]=='C/L/S/E/U': widths=[40,170,95,110,width-415]
            elif count==5: widths=[32,48,140,112,width-332]
            elif count==4: widths=[67,118,204,width-389]
            elif count==3 and value[0][0]=='字段/分支': widths=[80,260,width-340]
            elif count==3 and value[0][0]=='项目': widths=[95,250,width-345]
            else: widths=[width/count]*count
            cells=[[p(c,'head' if n==0 else 'cell') for c in row] for n,row in enumerate(value)]
            table=Table(cells,colWidths=widths,repeatRows=1,hAlign='LEFT')
            table.setStyle(TableStyle([
                ('BACKGROUND',(0,0),(-1,0),ink),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,pale]),
                ('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),
                ('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8),
                ('LINEBELOW',(0,0),(-1,0),0.5,ink),('LINEBELOW',(0,1),(-1,-1),0.3,colors.HexColor('#CBD9DD'))
            ]))
            label=[]
            if flow and isinstance(flow[-1],Paragraph) and flow[-1].style.name=='label':
                label.append(flow.pop())
            flow.extend(([KeepTogether(label+[table])] if len(value)<=7 else label+[table])+[Spacer(1,12)])
        elif kind=='code':
            content=html.escape(value).replace(' ','&#160;').replace('\n','<br/>')
            label=[]
            if flow and isinstance(flow[-1],Paragraph) and flow[-1].style.name=='label':
                label.append(flow.pop())
            flow.append(KeepTogether(label+[Paragraph(content,styles['code'])]))
        elif kind=='h2' and value=='待补齐':
            flow.extend([PageBreak(),p(value,kind)])
        elif kind=='h2' and (value=='7. 产能与成本测算示例' or value.startswith('3. Vibecoding')):
            flow.extend([PageBreak(),p(value,kind)])
        elif kind=='p' and value.endswith('：'):
            flow.append(p(value,'label'))
        elif value.startswith('Live Demo：') or value.startswith('Public Source：'):
            label,url=value.split('：',1)
            flow.append(Paragraph(f'{label}：<link href="{html.escape(url)}" color="#117E80">{html.escape(url)}</link>',styles['p']))
        else: flow.append(p(value,kind))
    return flow

css='''body{background:#eff3f5;color:#182b43;font:16px/1.8 "Microsoft YaHei",sans-serif;margin:0}main{max-width:1060px;margin:36px auto;background:white;padding:48px}h1{font-size:30px;line-height:1.4}h2{font-size:21px;color:#117e80;margin-top:32px}table{border-collapse:collapse;width:100%;font-size:13px;margin:24px 0}td,th{border-bottom:1px solid #cbd9dd;padding:12px;text-align:left;vertical-align:top}th{background:#182b43;color:white}tr:nth-child(even){background:#ecf4f5}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#ecf4f5;padding:20px;font-size:13px}p{overflow-wrap:anywhere}a{color:#117e80}.status{border-left:4px solid #ce9652;background:#fff6e8;padding:18px}.part{margin-top:60px;border-top:2px solid #117e80;padding-top:20px}@media print{body{background:white}main{margin:0;padding:0}.part{break-before:page}tr{break-inside:avoid}thead{display:table-header-group}}'''
def html_blocks(md):
    blocks=[]
    for kind,value in md_blocks(md):
        if kind=='table':
            header='<tr>'+''.join('<th>'+escape(x)+'</th>' for x in value[0])+'</tr>'
            rows=''.join('<tr>'+''.join('<td>'+escape(x)+'</td>' for x in row)+'</tr>' for row in value[1:])
            blocks.append('<table><thead>'+header+'</thead><tbody>'+rows+'</tbody></table>')
        elif kind=='code': blocks.append('<pre>'+html.escape(value)+'</pre>')
        else:
            text=escape(value)
            text=re.sub(r'(https://[^\s<]+)',r'<a href="\1">\1</a>',text)
            blocks.append(f'<{kind}>{text}</{kind}>')
    return '\n'.join(blocks)
def html_doc(body,title): return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title><style>'+css+'</style><main>'+body+'</main></html>'

review_records=json.loads((ROOT/'docs/review-data.json').read_text(encoding='utf-8'))
def thumbnail_html():
    body='<h2>图片编号对照</h2><p>等比缩略图仅用于对应编号，细节判断以原文件为准。</p><div style="display:grid;grid-template-columns:repeat(2,1fr);gap:20px">'
    for r in review_records:
        b64=base64.b64encode((ROOT/f"docs/review-assets/{r['id']}.jpg").read_bytes()).decode()
        body+=f'<figure style="margin:0"><figcaption>{r["id"]} · {r["score"]}分 · {r["width"]}×{r["height"]}</figcaption><img style="width:100%;height:220px;object-fit:contain;background:#ecf4f5" src="data:image/jpeg;base64,{b64}"></figure>'
    return body+'</div>'
def thumbnail_pages():
    from PIL import Image as PILImage
    flow=[]
    for start in [0,10]:
        flow.extend([PageBreak(),p(f'图片编号对照 {start+1:02}—{start+10:02}','h1'),p('等比缩略图仅用于对应编号，细节判断以原文件为准。','muted')])
        rows=[]
        for offset in range(start,start+10,2):
            row=[]
            for r in review_records[offset:offset+2]:
                path=ROOT/f"docs/review-assets/{r['id']}.jpg"
                with PILImage.open(path) as image: w,h=image.size
                scale=min(228/w,96/h)
                row.append([p(f"{r['id']}  |  {r['score']}分  |  {r['width']}×{r['height']}",'cell'),Spacer(1,5),PDFImage(str(path),width=w*scale,height=h*scale)])
            rows.append(row)
        table=Table(rows,colWidths=[(A4[0]-88)/2]*2)
        table.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),9),('LINEBELOW',(0,0),(-1,-1),.3,colors.HexColor('#CBD9DD'))]))
        flow.append(table)
    return flow

parts=[(ROOT/'docs'/name).read_text(encoding='utf-8') for name in ['part1-pipeline.md','part2-demo.md','part3-review.md','verification.md']]
recap=re.search(r'## 3\. Vibecoding.*?\n\n(.*?)\n\n## 4',parts[1],re.S).group(1)
assert len(re.sub(r'\s','',recap))<=200, len(recap)
status='整合审阅稿 · 图像评分已逐张复核 · 本地修订未发布 · 真人及手机验收待补'
intro='# AI产品设计测试题｜整合审阅稿\n\n'+status+'\n\n日期：2026-09-29\n\n'
(ROOT/'docs/submission.md').write_text(intro+'\n\n---\n\n'.join(parts),encoding='utf-8')
body='<h1>AI产品设计测试题</h1><p>多 Agent 生产管线 / AR 表情互动 / 图像美学评测</p><p class="status">'+status+'</p>'
body+=''.join('<section class="part">'+html_blocks(md)+(thumbnail_html() if i==2 else '')+'</section>' for i,md in enumerate(parts))
(OUT/'submission.html').write_text(html_doc(body,'AI产品设计 · 整合审阅稿'),encoding='utf-8')
for name,md in [('Part1-自动化管线设计.html',parts[0]),('Part3-图像美学评测报告.html',parts[2])]:
    (ROOT/name).write_text(html_doc(html_blocks(md)+(thumbnail_html() if name.startswith('Part3') else ''),name[:-5]),encoding='utf-8')

flow=[Spacer(1,45),p('AI PRODUCT DESIGN','muted'),p('AI产品设计\n测试题'.replace('\n',' '),'cover'),
      p('规模化生产中的质量与成本\n即时互动中的反馈与性能\n图像判断中的证据与一致性'.replace('\n',' / '),'h2'),
      Spacer(1,30),p('整合审阅稿 · 2026-09-29','h2'),p(status),
      p('本稿保留明确的证据边界：Part1为设计方案；Part2的逻辑回归与实际摄像头验收分开；Part3已依据20张原文件逐张复核，附维度分、修订理由与图片索引。'),
      Spacer(1,20),p('Live Demo：https://facefx.pxlsan.cn/'),p('Public Source：https://github.com/JHH-hub/AR-expression-effects-'),
      Spacer(1,20),p('阅读顺序','h2'),p('01 生产管线与上下文工程\n02 可交互原型与Vibecoding复盘\n03 20张图像评分与评价方法\n04 验证记录与提交前检查'.replace('\n',' / '))]
for i,md in enumerate(parts):
    flow.append(PageBreak()); flow.extend(pdf_blocks(md))
    if i==2: flow.extend(thumbnail_pages())
def decorate(canvas,doc):
    canvas.setFont('CN',8); canvas.setFillColor(colors.HexColor('#617183'))
    canvas.drawString(44, A4[1]-29,'AI 产品设计测试题 | 整合审阅稿')
    canvas.setStrokeColor(colors.HexColor('#CBD9DD'));canvas.line(44,35,A4[0]-44,35)
    canvas.drawString(44,22,'2026-09-29  /  图像已复核 · 修订发布与真机验收待补')
    canvas.drawRightString(A4[0]-44,22,str(doc.page))
pdf=OUT/'pdf/AI产品设计-整合审阅稿.pdf'
doc=SimpleDocTemplate(str(pdf),pagesize=A4,rightMargin=44,leftMargin=44,topMargin=49,bottomMargin=49,title='AI产品设计测试题 - 整合审阅稿',author='')
doc.build(flow,onFirstPage=decorate,onLaterPages=decorate)
reader=PdfReader(pdf)
assert len(reader.pages)>3
extracted='\n'.join(page.extract_text() or '' for page in reader.pages)
assert 'Part 1' in extracted and 'Part 2' in extracted and 'Part 3' in extracted
assert '最差' in extracted and 'generator.schema.json' in extracted
print(json.dumps({'pdf':str(pdf),'pages':len(reader.pages),'bytes':pdf.stat().st_size,'recap_characters_including_prompt':len(re.sub(r'\s','',recap))},ensure_ascii=False))

standalone=OUT/'pdf/Part3-图像美学评测-原图复核版.pdf'
def review_footer(canvas,doc):
    canvas.setFont('CN',8);canvas.setFillColor(colors.HexColor('#617183'))
    canvas.drawString(44,A4[1]-29,'AI 产品设计测试题 | Part 3 图像美学评测')
    canvas.drawString(44,22,'2026-09-29  /  原图复核版 · 20张评分及编号索引')
    canvas.drawRightString(A4[0]-44,22,str(doc.page))
SimpleDocTemplate(str(standalone),pagesize=A4,rightMargin=44,leftMargin=44,topMargin=49,bottomMargin=49,title='Part3 图像美学评测 - 原图复核版').build(pdf_blocks(parts[2])+thumbnail_pages(),onFirstPage=review_footer,onLaterPages=review_footer)
print(json.dumps({'pdf':str(standalone),'pages':len(PdfReader(standalone).pages),'bytes':standalone.stat().st_size},ensure_ascii=False))
