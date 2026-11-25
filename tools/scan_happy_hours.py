"""
Visit each bar's website and collect what it says about happy hour.

    python tools/scan_happy_hours.py LIST.csv OUT.jsonl [MAXPAGES]

Where it looks, for each site:
  1. the home page
  2. links on the home page that look like happy hour, specials, drinks, menus, events
  3. the site's sitemap (sitemap.xml, WordPress and Squarespace style), for pages the home page doesn't link
  4. common addresses tried directly: /happy-hour, /happyhour, /specials, /events/happy-hour, /menus ...
  5. menus hosted elsewhere (Toast, Popmenu, BentoBox, Square, Squarespace/Wix files, Google Drive) and PDFs anywhere
  6. a real browser (Playwright) for sites that block plain requests, build their text or menus with JavaScript,
     or showed no happy hour on the first pass
  7. text recognition (OCR) on menu and flyer images when nothing readable turned up

A dedicated happy hour page is kept whole (up to 4,000 characters), so long menus aren't cut off.
Elsewhere it keeps the text around each "happy hour" mention. Each record says how it found things
(found_by) and what it tried (tried), so we can see why a site came up empty.
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
MAXPAGES = int(sys.argv[3]) if len(sys.argv) > 3 else 10
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
                    'Chrome/124.0 Safari/537.36 215HappyHourBot/1.0 (+https://215happyhour.com)'}
LINK_HINT = re.compile(r'happy|hh\b|special|drink|cocktail|menu|bar\b|beverage|deal|late.?night|hours|event|food', re.I)
HH_URL = re.compile(r'happy|hh\b|happyhour|special', re.I)
HAPPY = re.compile(r'happy\s*-?\s*hours?|\bhappy hr\b|\bhh\b', re.I)
TIME = re.compile(r'\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)|\b\d{1,2}(:\d{2})?\s*[-–]\s*\d{1,2}(:\d{2})?\s*(am|pm)?\b', re.I)
THIN = 300
BOT_CHECK = re.compile(r'just a moment|checking your browser|verify you are human|attention required|access denied', re.I)
MENU_HOSTS = re.compile(r'toasttab\.com|popmenu|getbento|bentobox|squarespace-cdn\.com|static1\.squarespace\.com|wixstatic\.com|'
                        r'usrfiles\.com|spoton\.com|singleplatform|menufy|square\.site|clover\.com|imenupro|canva\.site|'
                        r'drive\.google\.com|docs\.google\.com|dropbox\.com|untappd\.com/v|menu\.app', re.I)
PROBES = ['happy-hour', 'happyhour', 'happy-hours', 'specials', 'events/happy-hour', 'happy-hour-menu', 'daily-specials',
          'menus', 'menu', 'drinks', 'drink-menu', 'bar-menu']
MAX_SNIPPETS = 12
FULL = 4000


def get(url, binary=False, timeout=15):
    try:
        r = requests.get(url, headers=UA, timeout=timeout, allow_redirects=True)
        ctype = r.headers.get('content-type', '')
        if r.status_code >= 400:
            return None, r.url, f'http {r.status_code}'
        if binary:
            return r.content, r.url, ctype
        if 'html' not in ctype and 'xml' not in ctype:
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


def snippets_for(url, txt, how):
    """A dedicated happy hour page is kept whole; elsewhere, the text around each mention."""
    if HH_URL.search(urlparse(url).path) and (HAPPY.search(txt) or TIME.search(txt)):
        m = HAPPY.search(txt)
        start = max(0, m.start() - 150) if m else 0
        return [{'page': url, 'text': txt[start:start + FULL], 'how': how, 'whole_page': True}]
    return [{'page': url, 'text': s, 'how': how} for s in windows(txt)]


def same_site(a, b):
    return urlparse(a).netloc.replace('www.', '') == urlparse(b).netloc.replace('www.', '')


def collect(soup, final, rec):
    """Candidate links (same site or a menu host), PDFs and menu/flyer images from one page."""
    links = []
    for a in soup.find_all('a', href=True):
        try:
            href = urljoin(final, a['href']).split('#')[0]
            p = urlparse(href)
        except ValueError:
            continue
        if p.scheme not in ('http', 'https'):
            continue
        label = (a.get_text(' ', strip=True) or '') + ' ' + href
        if href.lower().split('?')[0].endswith('.pdf'):
            if (LINK_HINT.search(label) or HAPPY.search(label)) and href not in rec['pdfs']:
                rec['pdfs'].append(href)
            continue
        if (same_site(href, final) and LINK_HINT.search(label)) or MENU_HOSTS.search(p.netloc):
            if href not in links and href.rstrip('/') != final.rstrip('/'):
                links.append(href)
    for img in soup.find_all('img'):
        src = img.get('src') or img.get('data-src') or ''
        label = ' '.join([src, img.get('alt') or '', img.get('title') or ''])
        if src and re.search(r'happy|hh|special|drink|menu|cocktail|flyer', label, re.I):
            u = urljoin(final, src)
            if u not in rec['images']:
                rec['images'].append(u)
    return links


def sitemap_urls(base):
    """Page addresses from the site's sitemap that look like happy hour, specials, menus or events."""
    root = f'{urlparse(base).scheme}://{urlparse(base).netloc}/'
    found, queue, seen = [], [urljoin(root, x) for x in ('sitemap.xml', 'sitemap_index.xml', 'wp-sitemap.xml')], set()
    while queue and len(seen) < 6:
        sm = queue.pop(0)
        if sm in seen:
            continue
        seen.add(sm)
        xml, _, _ = get(sm, timeout=10)
        if not xml or '<loc>' not in xml:
            continue
        for loc in re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', xml)[:2000]:
            if loc.endswith('.xml') or 'sitemap' in loc.lower():
                if re.search(r'page|post|menu|event|special', loc, re.I) or len(seen) < 3:
                    queue.append(loc)
            elif LINK_HINT.search(urlparse(loc).path) and same_site(loc, base):
                found.append(loc)
        if found and '<sitemapindex' not in xml:
            break
    return found[:40]


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


def add_pdfs(rec):
    rec['pdfs'].sort(key=lambda h: 0 if HH_URL.search(h) or 'drink' in h.lower() else 1)
    for href in rec['pdfs'][:3]:
        t = pdf_text(href)
        if not t:
            continue
        rec['tried'].append('pdf')
        got = [{'page': href, 'text': s, 'how': 'pdf'} for s in windows(t, n=3)]
        if not got and HH_URL.search(href):
            got = [{'page': href, 'text': t[:FULL], 'how': 'pdf', 'whole_page': True}]
        rec['snippets'] += got


def ocr_images(rec):
    """Read menu and flyer images when no readable happy hour turned up."""
    try:
        import pytesseract
        from PIL import Image
    except Exception:
        return
    rec['images'].sort(key=lambda u: 0 if re.search(r'happy|hh|special', u, re.I) else 1)
    for u in rec['images'][:3]:
        data, _, ctype = get(u, binary=True)
        if not data or len(data) > 6_000_000 or 'svg' in (ctype or ''):
            continue
        try:
            img = Image.open(io.BytesIO(data)).convert('L')
            if img.width < 300:
                continue
            t = re.sub(r'\s+', ' ', pytesseract.image_to_string(img))
        except Exception:
            continue
        rec['tried'].append('image')
        got = [{'page': u, 'text': s, 'how': 'image'} for s in windows(t, n=2)]
        if not got and re.search(r'happy|hh', u, re.I) and TIME.search(t):
            got = [{'page': u, 'text': t[:1500], 'how': 'image'}]
        rec['snippets'] += got


def has_times(rec):
    return any(HAPPY.search(s['text']) and TIME.search(s['text']) for s in rec['snippets'])


def scan(row):
    try:
        return _scan(row)
    except Exception as e:  # never let one odd site stop the whole run
        return {'row': row['row'], 'name': row['name'], 'website': row['website'], 'ok': False, 'pages': [], 'snippets': [],
                'pdfs': [], 'images': [], 'tried': [], 'error': f'error: {type(e).__name__}', 'thin': False}


def visit(rec, url, how):
    h, f, _ = get(url)
    if not h or f in rec['pages']:
        return None
    t, soup = text_of(h)
    if BOT_CHECK.search(t[:400]):
        return None
    rec['pages'].append(f)
    rec['snippets'] += snippets_for(f, t, how)
    return soup, f


def _scan(row):
    url = row['website'].strip()
    if not url.startswith('http'):
        url = 'http://' + url
    rec = {'row': row['row'], 'name': row['name'], 'website': url, 'ok': False, 'pages': [], 'snippets': [], 'pdfs': [],
           'images': [], 'tried': ['home'], 'error': '', 'thin': False}
    html, final, info = get(url)
    if not html:
        rec['error'] = info
        return rec
    rec['ok'] = True
    # the address now lands on a different company's site (sold or lapsed domain): flag it, don't read it
    dom = lambda u: '.'.join(urlparse(u).netloc.lower().split('.')[-2:])
    if dom(final) != dom(url) and not MENU_HOSTS.search(final):
        rec['offsite'] = final
        rec['error'] = f'website now goes to {urlparse(final).netloc}'
        rec['ok'] = False
        return rec
    txt, soup = text_of(html)
    rec['thin'] = len(txt) < THIN or bool(BOT_CHECK.search(txt[:400]))
    rec['pages'].append(final)
    rec['snippets'] += snippets_for(final, txt, 'home')
    links = collect(soup, final, rec)
    links.sort(key=lambda h: 0 if HH_URL.search(h) else 1 if MENU_HOSTS.search(urlparse(h).netloc) else 2)

    # 2. linked pages, best first
    for href in links[:MAXPAGES]:
        got = visit(rec, href, 'menu_host' if MENU_HOSTS.search(urlparse(href).netloc) else 'link')
        if got:
            for extra in collect(got[0], got[1], rec):
                if extra not in links:
                    links.append(extra)
        if has_times(rec) and len(rec['snippets']) >= 4:
            break

    # 3. sitemap and 4. common addresses. A dedicated happy hour page is always worth finding (home pages often show
    # a short or outdated version: Panorama's home page and its /events/happy-hour/ page disagree), so look for one
    # even when times turned up; the general menu/drinks addresses only while nothing has.
    whole = lambda: any(x.get('whole_page') for x in rec['snippets'])
    root = f'{urlparse(final).scheme}://{urlparse(final).netloc}/'
    rec['tried'].append('sitemap')
    for loc in sorted(sitemap_urls(final), key=lambda h: 0 if HH_URL.search(h) else 1)[:8]:
        if has_times(rec) and (whole() or not HH_URL.search(loc)):
            break
        if loc not in rec['pages']:
            visit(rec, loc, 'sitemap')
    rec['tried'].append('probe')
    for p in PROBES:
        if whole() or (has_times(rec) and not HH_URL.search(p)):
            break
        got = visit(rec, urljoin(root, p), 'probe')
        if got:
            collect(got[0], got[1], rec)

    add_pdfs(rec)
    rec['snippets'] = dedupe(rec['snippets'])[:MAX_SNIPPETS]
    return rec


def dedupe(snips):
    out, seen = [], set()
    for s in sorted(snips, key=lambda s: (0 if s.get('whole_page') else 1, 0 if TIME.search(s['text']) else 1)):
        k = s['text'][:120]
        if k not in seen:
            seen.add(k)
            out.append(s)
    return out


async def browser_pass(recs):
    """Real browser for sites that failed, are thin, or showed no happy hour times on the first pass."""
    from playwright.async_api import async_playwright
    todo = [r for r in recs if not r.get('offsite') and (not r['ok'] or r['thin'] or not has_times(r))]
    if not todo:
        return
    sem = asyncio.Semaphore(6)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(user_agent=UA['User-Agent'])

        async def load(url):
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
                    html, final = await load(rec['website'])
                except Exception as e:
                    rec['error'] = rec['error'] or f'browser: {type(e).__name__}'
                    return
                txt, soup = text_of(html)
                if BOT_CHECK.search(txt[:400]):
                    if not rec['ok']:
                        rec['error'] = 'blocked by a bot check'
                    return
                rec['tried'].append('browser')
                if not rec['ok']:
                    rec['ok'], rec['error'], rec['pages'] = True, '', []
                rec['via'] = 'browser'
                rec['thin'] = len(txt) < THIN
                if final not in rec['pages']:
                    rec['pages'].append(final)
                rec['snippets'] += snippets_for(final, txt, 'browser')
                links = collect(soup, final, rec)
                links.sort(key=lambda h: 0 if HH_URL.search(h) else 1)
                for href in [h for h in links if h not in rec['pages']][:6]:
                    try:
                        h2, f2 = await load(href)
                    except Exception:
                        continue
                    t2, s2 = text_of(h2)
                    rec['pages'].append(f2)
                    rec['snippets'] += snippets_for(f2, t2, 'browser')
                    collect(s2, f2, rec)
                    if has_times(rec):
                        break
                await asyncio.to_thread(add_pdfs, rec)
                rec['snippets'] = dedupe(rec['snippets'])[:MAX_SNIPPETS]

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
todo = [r for r in recs if r['ok'] and not has_times(r) and r['images']]
with ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(ocr_images, todo))
for r in recs:
    r['snippets'] = dedupe(r['snippets'])[:MAX_SNIPPETS]
    r['found_by'] = sorted({s.get('how', '') for s in r['snippets']})
    r['has_times'] = has_times(r)
with open(OUT, 'w', encoding='utf-8') as f:
    for rec in recs:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')
by = {}
for r in recs:
    for h in r['found_by']:
        by[h] = by.get(h, 0) + 1
print(f'Sites: {len(recs)}  reachable: {sum(r["ok"] for r in recs)}  '
      f'mention happy hour: {sum(bool(r["snippets"]) for r in recs)}  with days/times: {sum(r["has_times"] for r in recs)}  '
      f'with PDF menus: {sum(bool(r["pdfs"]) for r in recs)}  images read: {sum("image" in r["tried"] for r in recs)}')
print('Found by: ' + ', '.join(f'{k} {v}' for k, v in sorted(by.items())))
