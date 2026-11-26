"""Print the readable text of each URL given (for checking happy hour details).
    python tools/print_pages.py URL [URL ...]"""
import re
import sys

import requests
from bs4 import BeautifulSoup

UA = {'User-Agent': 'Mozilla/5.0 (compatible; 215HappyHourBot/1.0; +https://215happyhour.com)'}
for url in sys.argv[1:]:
    print(f'=====PAGE {url}=====')
    try:
        r = requests.get(url, headers=UA, timeout=30)
        if url.lower().split('?')[0].endswith('.pdf') or 'pdf' in r.headers.get('content-type', ''):
            import io
            from pypdf import PdfReader
            txt = ' '.join((p.extract_text() or '') for p in PdfReader(io.BytesIO(r.content)).pages)
            txt = re.sub(r'\s+', ' ', txt)
        else:
            soup = BeautifulSoup(r.text, 'html.parser')
            for t in soup(['script', 'style', 'noscript', 'svg']):
                t.decompose()
            txt = re.sub(r'\s+', ' ', soup.get_text(' ', strip=True))
        m = re.search(r'happy\s*-?\s*hour', txt, re.I)
        start = max(0, (m.start() if m else 0) - 300)
        print(txt[start:start + 12000])
    except Exception as e:
        print(f'ERROR {type(e).__name__}: {e}')
print('=====END=====')
