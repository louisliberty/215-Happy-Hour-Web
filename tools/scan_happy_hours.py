"""
Visit each bar's website and collect what it says about happy hour.

    python tools/scan_happy_hours.py LIST.csv OUT.jsonl [MAXPAGES]

For each site: the home page plus up to MAXPAGES same-site pages whose link looks
like happy hour, specials, drinks, menu or bar, plus up to 3 linked PDF menus.
Sites that block plain requests or load their text with JavaScript get a second
try in a real browser (Playwright). Saves the text around every "happy hour"
mention.
"""
import asyncio
import csv
import io
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

IN, OUT = sys.argv[1], sys.argv[2]
MAXPAGES = int(sys.argv[3]) if len(sys.argv) > 3 else 6
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
                    'Chrome/124.0 Safari/537.36 215HappyHourBot/1.0 (+https://215happyhour.com)'}
LINK_HINT = re.compile(r'happy|hh\b|special|drink|cocktail|menu|bar\b|beverage|deal|late.?night|hours', re.I)
HAPPY = re.compile(r'happy\s*-?\s*hours?|\bhappy hr\b|\bhh\b', re.I)
THIN = 300  # characters: less text than this usually means a JavaScript-only site
BOT_CHECK = re.compile(r'just a moment|checking your browser|verify you are human|attention required|access denied', re.I)


def get(url, binary=False):
    try:
        r = requests.get(url, headers=UA, timeout=15, allow_redirects=True)
        ctype = r.headers.get('content-type', '')
        if r.status_code >= 400:
            return None, r.url, f'http {r.status_code}'
        if binary:
            return r.content, r.url, ctype
        if 'html' not in ctype:
            return None, r.url, ctype
        return r.text, r.url, ctype
    except Exception as e:  # network errors, bad certs, timeouts
        return None, url, f'error: {type(e).__name__}'


def text_of(html):
    soup = BeautifulSoup(html, 'html.parser')
    for t in soup(['script', 'style', 'noscript', 'svg']):
        t.decompose()
    return re.sub(r'\s+', ' ', soup.get_text(' ', strip=True)), soup


def windows(txt, n=4, width=500):
    out, last = [], -10**9
    for m in HAPPY.finditer(txt):
        if m.start() - last < width:
            continue
        last = m.start()
        out.append(txt[max(0, m.start() - 150): m.start() + width])
        if len(out) >= n:
            break
    return out


def pdf_text(url):
    try:
        from pypdf import PdfReader
        data, final, ctype = get(url, binary=True)
        if not data or len(data) > 8_000_000 or not data[:5].startswith(b'%PDF'):
            return ''
        reader = PdfReader(io.BytesIO(data))
        return re.sub(r'\s+', ' ', ' '.join((p.extract_text() or '') for p in reader.pages[:12]))
    except Exception:
        return ''


def collect_links(soup, final, rec):
    host = urlparse(final).netloc.replace('www.', '')
    links = []
    for a in soup.find_all('a', href=True):
        try:
            href = urljoin(final, a['href'])
            p = urlparse(href)
        except ValueError:
            continue
        label = (a.get_text(' ', strip=True) or '') + ' ' + href
        if href.lower().split('?')[0].endswith('.pdf') and (LINK_HINT.search(label) or HAPPY.search(label)):
            if href not in rec['pdfs']:
                rec['pdfs'].append(href)
            continue
        if p.netloc.replace('www.', '') != host or not LINK_HINT.search(label):
            continue
        href = href.split('#')[0]
        if href not in links and href != final:
            links.append(href)
    links.sort(key=lambda h: 0 if HAPPY.search(h) or 'special' in h.lower() else 1)
    return links


def add_pdfs(rec):
    rec['pdfs'].sort(key=lambda h: 0 if HAPPY.search(h) or 'special' in h.lower() or 'drink' in h.lower() else 1)
    for href in rec['pdfs'][:3]:
        t = pdf_text(href)
        rec['snippets'] += [{'page': href, 'text': s} for s in windows(t, n=2)]


def scan(row):
    try:
        return _scan(row)
    except Exception as e:  # never let one odd site stop the whole run
        return {'row': row['row'], 'name': row['name'], 'website': row['website'], 'ok': False,
                'pages': [], 'snippets': [], 'pdfs': [], 'error': f'error: {type(e).__name__}', 'thin': False}


def _scan(row):
    url = row['website'].strip()
    if not url.startswith('http'):
        url = 'http://' + url
    rec = {'row': row['row'], 'name': row['name'], 'website': url, 'ok': False,
           'pages': [], 'snippets': [], 'pdfs': [], 'error': '', 'thin': False}
    html, final, info = get(url)
    if not html:
        rec['error'] = info
        return rec
    rec['ok'] = True
    txt, soup = text_of(html)
    rec['thin'] = len(txt) < THIN or bool(BOT_CHECK.search(txt[:400]))
    rec['pages'].append(final)
    rec['snippets'] += [{'page': final, 'text': s} for s in windows(txt)]
    for href in collect_links(soup, final, rec)[:MAXPAGES]:
        h2, f2, _ = get(href)
        if not h2:
            continue
        t2, _ = text_of(h2)
        rec['pages'].append(f2)
        rec['snippets'] += [{'page': f2, 'text': s} for s in windows(t2)]
        if len(rec['snippets']) >= 8:
            break
    add_pdfs(rec)
    rec['snippets'] = rec['snippets'][:8]
    return rec


async def browser_pass(recs):
    """Second try in headless Chrome for sites that failed or showed almost no text."""
    from playwright.async_api import async_playwright
    todo = [r for r in recs if (not r['ok'] or r['thin']) and not r['snippets']]
    if not todo:
        return
    sem = asyncio.Semaphore(6)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(user_agent=UA['User-Agent'])

        async def visit(url):
            page = await ctx.new_page()
            try:
                await page.goto(url, timeout=25000, wait_until='domcontentloaded')
                await page.wait_for_timeout(2500)
                return await page.content(), page.url
            finally:
                await page.close()

        async def one(rec):
            async with sem:
                try:
                    html, final = await visit(rec['website'])
                except Exception as e:
                    rec['error'] = rec['error'] or f'browser: {type(e).__name__}'
                    return
                txt, soup = text_of(html)
                if BOT_CHECK.search(txt[:400]):
                    rec['ok'], rec['error'] = False, 'blocked by a bot check'
                    return
                rec['ok'] = True
                rec['error'] = ''
                rec['via'] = 'browser'
                rec['thin'] = len(txt) < THIN
                rec['pages'] = [final]
                rec['snippets'] = [{'page': final, 'text': s} for s in windows(txt)]
                for href in collect_links(soup, final, rec)[:4]:
                    try:
                        h2, f2 = await visit(href)
                    except Exception:
                        continue
                    t2, _ = text_of(h2)
                    rec['pages'].append(f2)
                    rec['snippets'] += [{'page': f2, 'text': s} for s in windows(t2)]
                    if len(rec['snippets']) >= 6:
                        break
                await asyncio.to_thread(add_pdfs, rec)
                rec['snippets'] = rec['snippets'][:8]

        await asyncio.gather(*(one(r) for r in todo))
        await browser.close()
    print(f'Browser pass: retried {len(todo)} sites')


rows = list(csv.DictReader(open(IN, encoding='utf-8')))
with ThreadPoolExecutor(max_workers=16) as pool:
    recs = list(pool.map(scan, rows))
try:
    asyncio.run(browser_pass(recs))
except Exception as e:
    print(f'Browser pass skipped: {e}')
with open(OUT, 'w', encoding='utf-8') as f:
    for rec in recs:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')
print(f'Sites: {len(recs)}  reachable: {sum(r["ok"] for r in recs)}  '
      f'mention happy hour: {sum(bool(r["snippets"]) for r in recs)}  '
      f'with PDF menus: {sum(bool(r["pdfs"]) for r in recs)}')
