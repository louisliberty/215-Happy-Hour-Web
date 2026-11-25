#!/usr/bin/env node
/*
  215 Happy Hour - static site builder (no dependencies, Node 18+)

  Usage:
    node build.js              -> builds the live site into ./dist
    node build.js --preview    -> builds a preview copy into ./dist-preview

  Data source:
    If the SHEET_CSV_URL environment variable is set (your Google Sheet
    "Publish to web" CSV link), the build reads from it. Otherwise it reads
    ./data/venues.csv.
*/
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PREVIEW = process.argv.includes('--preview');
const OUT = path.join(ROOT, PREVIEW ? 'dist-preview' : 'dist');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
const BUILD_DATE = new Date();
// changes whenever styles.css or app.js change, so browsers fetch the new version instead of a cached one
const ASSET_V = require('crypto').createHash('md5')
  .update(fs.readFileSync(path.join(ROOT, 'src', 'styles.css')))
  .update(fs.readFileSync(path.join(ROOT, 'src', 'app.js'))).digest('hex').slice(0, 8);

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DEAL_TYPES = [
  ['beer', 'Beer'], ['wine', 'Wine'], ['cocktails', 'Cocktails'],
  ['food', 'Food'], ['oysters', 'Oysters'],
];
const LATE_NIGHT_START = 21 * 60;

/* ---------- small helpers ---------- */
const esc = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const slugify = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const yes = (v) => /^(y|yes|true|1|x)$/i.test(String(v || '').trim());

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  return rows
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

function parseDays(s) {
  const out = new Set();
  const txt = String(s || '').trim();
  if (!txt) return [];
  if (/^(daily|every ?day|all)$/i.test(txt)) return [0, 1, 2, 3, 4, 5, 6];
  const idx = (d) => DAYS.findIndex((x) => x.toLowerCase() === d.trim().slice(0, 3).toLowerCase());
  for (const part of txt.split(/[,;/]+/)) {
    const [a, b] = part.split(/[-–]/).map((x) => x.trim());
    const i = idx(a);
    if (i < 0) continue;
    if (!b) { out.add(i); continue; }
    const j = idx(b);
    if (j < 0) { out.add(i); continue; }
    for (let k = i; ; k = (k + 1) % 7) { out.add(k); if (k === j) break; }
  }
  return [...out].sort((x, y) => x - y);
}

function daysLabel(days) {
  if (days.length === 7) return 'Daily';
  if (!days.length) return '';
  const set = new Set(days);
  // circular contiguous run?
  const starts = days.filter((d) => !set.has((d + 6) % 7));
  if (starts.length === 1) {
    const s = starts[0];
    let e = s;
    while (set.has((e + 1) % 7) && (e + 1) % 7 !== s) e = (e + 1) % 7;
    if (s === e) return DAYS[s];
    const len = ((e - s + 7) % 7) + 1;
    return len === 2 ? `${DAYS[s]} & ${DAYS[e]}` : `${DAYS[s]}-${DAYS[e]}`;
  }
  return days.map((d) => DAYS[d]).join(', ');
}

const toMin = (t) => {
  const m = String(t || '').match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = +m[1]; const mm = +(m[2] || 0); const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + mm;
};
function clock(min, withAp = true) {
  if (min >= 23 * 60 + 59) return 'midnight';
  const h = Math.floor(min / 60), m = min % 60;
  const h12 = ((h + 11) % 12) + 1;
  const ap = h < 12 ? 'am' : 'pm';
  return `${h12}${m ? ':' + String(m).padStart(2, '0') : ''}${withAp ? ' ' + ap : ''}`;
}
function rangeLabel(start, end) {
  const sameHalf = (start < 720) === (end < 720) && end < 23 * 60 + 59;
  return `${clock(start, !sameHalf)}-${clock(end)}`;
}
const fmtDate = (iso) => {
  const d = new Date(iso + 'T12:00:00');
  return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const monthYear = BUILD_DATE.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: config.timezone });

/* ---------- load data ---------- */
async function loadRows() {
  const url = process.env.SHEET_CSV_URL;
  if (url) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = parseCSV(await res.text());
      if (rows.length) { console.log(`Loaded ${rows.length} rows from Google Sheet`); return rows; }
      throw new Error('sheet returned no rows');
    } catch (e) {
      console.error(`Could not read the Google Sheet (${e.message}).`);
      process.exit(1); // never deploy an empty or broken site
    }
  }
  const rows = parseCSV(fs.readFileSync(path.join(ROOT, 'data', 'venues.csv'), 'utf8'));
  console.log(`Loaded ${rows.length} rows from data/venues.csv`);
  return rows;
}

// Happy hours found on bars' own websites (data/website-happy-hours.csv).
// Matched to sheet bars by address; ignored for any bar whose sheet row already has times.
function loadWebsiteRows() {
  const f = path.join(ROOT, 'data', 'website-happy-hours.csv');
  if (!fs.existsSync(f)) return [];
  return parseCSV(fs.readFileSync(f, 'utf8')).map((r) => ({ ...r, _fromWebsite: true }));
}
// "1201-05 Frankford Ave 109 East Girard Ave" and "1201 Frankford Avenue" both -> "1201-frankford"
const addrKey = (a) => {
  let t = String(a || '').toLowerCase().split(',')[0];
  const m = t.match(/^\s*(\d+)[a-z]?(?:\s*-\s*\d+[a-z]?)?\s+(.*?)\b(street|st|avenue|ave|boulevard|blvd|road|rd|place|pl|lane|ln|way|drive|dr|pike|square|sq)\b/);
  if (m) t = `${m[1]} ${m[2]}`;
  else t = t.replace(/\s(ste|suite|unit|fl|floor|space|#).*$/i, '');
  return slugify(t.replace(/\b(north|south|east|west)\b/g, (d) => d[0]));
};

const BLOCKED_ADDR = new Set();
function buildModel(rows) {
  const venues = new Map();
  const problems = [];
  const skipped = { hidden: 0, closed: 0, club: 0, deli: 0, companyName: 0 };
  const slugs = new Set();
  const byAddr = new Map();       // address -> venue key (sheet rows)
  const sheetTimed = new Set();   // venue keys that got times from the sheet
  const blockedAddr = BLOCKED_ADDR; // sheet says closed / no HH / hidden
  let fromWebsite = 0;
  rows.forEach((r, i) => {
    if (!r.name) return;
    if (r._fromWebsite) {
      if (blockedAddr.has(addrKey(r.address))) return;
      const k = byAddr.get(addrKey(r.address));
      if (k && sheetTimed.has(k)) return;       // the sheet wins
      if (k) {
        // matched a sheet bar by address: the name from the bar's own website wins over the license name
        const v = venues.get(k);
        if (r.name && slugify(r.name) !== slugify(v.name)) {
          slugs.delete(v.slug);
          let slug = slugify(r.name);
          while (slugs.has(slug)) slug += '-' + i;
          slugs.add(slug);
          v.slug = slug; v.name = r.name;
        }
        r = { ...r, _key: k, name: v.name, address: v.address, neighborhood: v.hood };
      }
      fromWebsite++;
    }
    if (r.active && !yes(r.active)) { skipped.hidden++; blockedAddr.add(addrKey(r.address)); return; }
    const status = (r.status || '').toLowerCase();
    if (status === 'closed' || status === 'no hh') { skipped.closed++; blockedAddr.add(addrKey(r.address)); return; }
    const type = (r.type || '').toLowerCase();
    if (type === 'private club') { skipped.club++; return; }              // members only
    if (type.startsWith('deli')) { skipped.deli++; return; }               // take-out beer delis
    if (/name on the sign/i.test(r.notes || '')) { skipped.companyName++; return; } // still a company name
    const hasTimes = r.days || r.start || r.end;
    let days = [], start = null, end = null;
    if (hasTimes) {
      days = parseDays(r.days); start = toMin(r.start); end = toMin(r.end);
      if (!days.length || start == null || end == null) {
        problems.push(`Row ${i + 2} (${r.name}): check days/start/end`);
      }
    }
    const key = r._key || slugify(r.name) + '|' + slugify((r.address || '').replace(/\s(ste|suite|unit|fl|floor|space)\b.*$/i, ''));
    if (!venues.has(key)) {
      let slug = slugify(r.name);
      if (slugs.has(slug)) slug = slugify(`${r.name} ${(r.address || r.neighborhood || i).toString().split(',')[0]}`);
      while (slugs.has(slug)) slug += '-' + i;
      slugs.add(slug);
      const generic = /^bar \/ restaurant/.test(type);
      venues.set(key, {
        slug, name: r.name, hood: r.neighborhood || 'Philadelphia',
        hoodSlug: slugify(r.neighborhood || 'philadelphia'),
        address: r.address, phone: r.phone, website: r.website, instagram: r.instagram,
        lat: parseFloat(r.lat), lng: parseFloat(r.lng), vibe: r.vibe || (generic ? '' : r.type), about: r.about || '',
        featured: false, classic: false, sample: false, verified: '', blocks: [],
      });
    }
    const v = venues.get(key);
    if (!r._fromWebsite && !byAddr.has(addrKey(r.address))) byAddr.set(addrKey(r.address), key);
    for (const k of ['address', 'phone', 'website', 'instagram', 'vibe', 'about']) if (!v[k] && r[k]) v[k] = r[k];
    v.featured ||= yes(r.featured);
    v.classic ||= yes(r.classic);
    v.sample ||= yes(r.sample);
    if (r.verified && r.verified > v.verified) v.verified = r.verified;
    if (!days.length || start == null || end == null) return; // listed without happy hour times yet
    if (!r._fromWebsite) sheetTimed.add(key);
    if (end - start > 240) problems.push(`Row ${i + 2} (${r.name}): longer than PA's 4-hour daily limit`);
    if (end > 23 * 60 + 59) problems.push(`Row ${i + 2} (${r.name}): PA happy hours must end by midnight`);
    v.blocks.push({
      days, start, end,
      deals: (r.deals || '').split('|').map((s) => s.trim()).filter(Boolean),
      tags: (r.tags || '').split(/[,|]/).map((s) => s.trim().toLowerCase()).filter(Boolean),
      source: r.source_url || r.website || '', verified: r.verified || '',
    });
  });
  const list = [...venues.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const v of list) {
    v.weeklyMinutes = v.blocks.reduce((t, b) => t + (b.end - b.start) * b.days.length, 0);
    if (v.weeklyMinutes > 24 * 60) problems.push(`${v.name}: more than PA's 24 hours per week`);
    v.blocks.sort((a, b) => a.days[0] - b.days[0] || a.start - b.start);
  }
  const withHH = list.filter((v) => v.blocks.length).length;
  console.log(`${list.length} bars to publish: ${withHH} with happy hour times, ${list.length - withHH} without yet`);
  if (fromWebsite) console.log(`Added ${fromWebsite} happy hour rows from data/website-happy-hours.csv`);
  console.log(`Left off the site: ${skipped.closed} closed or no happy hour, ${skipped.club} private clubs, ${skipped.deli} delis, ${skipped.companyName} still showing a company name, ${skipped.hidden} set to active = no`);
  problems.forEach((p) => console.warn('  ! ' + p));
  return list;
}

/* ---------- linking ---------- */
// every page lives at "<dir>/index.html" (or index.html at the root)
function href(from, to) {
  const depth = from.split('/').length - 1;
  const up = '../'.repeat(depth);
  if (PREVIEW) return up + (to ? to + 'index.html' : 'index.html');
  return up + to || './';
}
const canonical = (p) => config.siteUrl + '/' + p.replace(/index\.html$/, '');

/* ---------- pieces ---------- */
// Logo: Liberty Pint (the Liberty Bell as a beer, crack and all). Fixed colors so it looks the same in light and dark mode.
const LOGO = `<svg class="mug" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="7" fill="#4f6b34"/><g transform="translate(32 32) scale(1.17) translate(-32 -31.2)"><path d="M22 22C22 14 42 14 42 22V34C42 41 45 45 49 46.5Q51 47.2 51 49V49.6Q51 51 49.6 51H14.4Q13 51 13 49.6V49Q13 47.2 15 46.5C19 45 22 41 22 34Z" fill="#f2a93b"/><g fill="#f6f0d6"><rect x="28.6" y="11.4" width="6.8" height="6" rx="2.2"/><path d="M22 22C22 14 42 14 42 22V26Q38.5 29.5 35 26Q32 23 29 26Q25.5 29.5 22 26Z"/></g><rect x="13" y="47.6" width="38" height="1.1" fill="#4f6b34"/><path d="M30.8 47.6L33.4 41.8L30.4 37L32.6 32.2" fill="none" stroke="#4f6b34" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/></g></svg>`;


/* ---------- bar page helpers ---------- */
function miles(a, b) {
  const R = 3958.8, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const KIND = { 'hotel bar': 'hotel bar', brewery: 'brewery', distillery: 'distillery', 'winery / tasting room': 'winery and tasting room', 'stadium / venue': 'venue', airport: 'airport bar', 'golf course': 'golf course bar' };
const fullDays = (days) => daysLabel(days).replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/g, (d) => DAY_FULL[DAYS.indexOf(d)]).replace('-', ' to ');
const lowerFirst = (t) => /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
const andList = (xs) => xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
function venueSummary(v) {
  const kind = KIND[String(v.vibe || '').toLowerCase()];
  const sched = andList(v.blocks.map((b) => `${fullDays(b.days)}, ${rangeLabel(b.start, b.end)}`));
  const deals = [...new Set(v.blocks.flatMap((b) => b.deals))].filter((d) => !/^happy hour( menu| specials)?$/i.test(d) && !/first come/i.test(d)).slice(0, 3).map(lowerFirst);
  return `${kind ? `This ${kind} in ${v.hood}` : `${v.name} in ${v.hood}`} runs happy hour ${sched}${deals.length ? `, with ${andList(deals)}` : ''}.`;
}
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

function card(v, b, from, opts = {}) {
  const late = b.start >= LATE_NIGHT_START;
  const map = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name} ${v.address} Philadelphia PA`)}`;
  const stale = v.verified && (BUILD_DATE - new Date(v.verified)) / 864e5 > config.staleAfterDays;
  return `<article class="hh${v.featured ? ' is-featured' : ''}" data-days="${b.days.join(',')}" data-start="${b.start}" data-end="${b.end}" data-hood="${esc(v.hoodSlug)}" data-tags="${esc(b.tags.join(','))}" data-name="${esc((v.name + ' ' + v.hood + ' ' + b.deals.join(' ')).toLowerCase())}"${late ? ' data-late="1"' : ''}>
  <div class="hh-time"><span class="hh-range">${rangeLabel(b.start, b.end)}</span><span class="hh-days">${daysLabel(b.days)}</span><span class="hh-status" aria-live="polite"></span></div>
  <div class="hh-body">
    <h3 class="hh-name"><a href="${href(from, `bar/${v.slug}/`)}">${esc(v.name)}</a>${v.phone ? ` <span class="hh-phone">${esc(v.phone)}</span>` : ''}</h3>
    <p class="hh-where">${opts.hideHood ? '' : `<a href="${href(from, `neighborhoods/${v.hoodSlug}/`)}">${esc(v.hood)}</a> · `}${esc(v.address || '')}</p>
    <ul class="hh-deals">${b.deals.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
    <p class="hh-meta">${v.featured ? '<span class="badge badge-feat">Featured</span>' : ''}${v.classic ? '<span class="badge badge-classic">215 Classic</span>' : ''}${late ? '<span class="badge">Late night</span>' : ''}${v.sample ? '<span class="badge badge-sample" title="Placeholder listing for layout. Replace with a real bar.">Sample listing</span>' : ''}${v.verified ? `<span class="verified${stale ? ' is-stale' : ''}">${stale ? 'Needs re-check' : 'Verified ' + fmtDate(v.verified)}</span>` : ''}<a class="dir" href="${map}" target="_blank" rel="noopener">Directions</a></p>
  </div>
</article>`;
}

function filterBar({ when = 'any', showWhen = true, showHood = true, hoods = [], items = null }) {
  if (items) {
    // only neighborhoods that have happy hours on this page, with counts
    const n = new Map();
    for (const [v] of items) n.set(v.hoodSlug, (n.get(v.hoodSlug) || 0) + 1);
    hoods = hoods.filter((h) => n.has(h.slug)).map((h) => ({ ...h, label: `${h.name} (${n.get(h.slug)})` }));
  }
  return `<form class="filters" role="search" data-default-when="${when}" onsubmit="return false">
  ${showWhen ? `<label class="f-field"><span>When</span><select id="f-when" name="when">
    <option value="now">Live right now</option><option value="today">Today</option>
    ${DAY_FULL.map((d, i) => `<option value="${i}">${d}</option>`).join('')}
    <option value="any">Any day</option></select></label>` : ''}
  ${showHood ? `<label class="f-field"><span>Neighborhood</span><select id="f-hood" name="hood"><option value="">All of Philly</option>${hoods.map((h) => `<option value="${esc(h.slug)}">${esc(h.label || h.name)}</option>`).join('')}</select></label>` : ''}
  <label class="f-field f-search"><span>Search</span><input id="f-q" name="q" type="search" placeholder="Bar, deal, or drink" autocomplete="off"></label>
  <fieldset class="f-chips"><legend class="sr">Deal type</legend>${DEAL_TYPES.map(([k, l]) => `<label class="chip"><input type="checkbox" id="f-${k}" name="type" value="${k}"><span>${l}</span></label>`).join('')}</fieldset>
</form>
<p class="results" id="results" aria-live="polite"></p>`;
}

function shell(p, { title, description, body, schema, page = {}, venues, hoods, noindex = false }) {
  const featured = venues.filter((v) => v.featured);
  const css = href(p, '').replace(/index\.html$/, '') + 'styles.css?v=' + ASSET_V;
  const js = href(p, '').replace(/index\.html$/, '') + 'app.js?v=' + ASSET_V;
  const dayNav = DAY_FULL.map((d, i) => `<li><a href="${href(p, d.toLowerCase() + '/')}" data-day="${i}"${page.day === i ? ' aria-current="page"' : ''}>${d.toLowerCase()}</a></li>`).join('');
  const head = `<title>${esc(title)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="${esc(description)}">${noindex ? '\n<meta name="robots" content="noindex, follow">' : ''}
${PREVIEW ? '' : `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${p === '404.html' ? '' : `<link rel="canonical" href="${canonical(p)}">`}`}
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">${p === '404.html' ? '' : `<meta property="og:url" content="${canonical(p)}">`}
<link rel="icon" href="${css.replace(/styles\.css.*$/, 'favicon.svg')}" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bowlby+One&family=Barlow+Condensed:wght@500;600;700&family=Figtree:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="${css}">
${schema ? `<script type="application/ld+json">${JSON.stringify(schema)}</script>` : ''}`;
  const content = `<header class="masthead"><div class="wrap mast-in">
  <a class="brand" href="${href(p, '')}" aria-label="215 Happy Hour home">${LOGO}<span class="brand-text"><span class="wordmark">215 Happy Hour</span><span class="tagline">${esc(config.tagline)}</span></span></a>
  <nav class="topnav" aria-label="Main"><a href="${href(p, '')}">Today</a><a href="${href(p, 'neighborhoods/')}">Neighborhoods</a><a href="${href(p, 'late-night/')}">Late night</a><a href="${href(p, 'weekend/')}">Weekend</a><a href="${href(p, 'for-bars/')}">For bars</a><a href="${href(p, 'about/')}">About</a></nav>
</div></header>
<div class="wrap layout">
  <aside class="rail rail-left" aria-label="Select a day">
    <h2 class="rail-h">Select a day</h2>
    <ul class="daynav">${dayNav}</ul>
    <h2 class="rail-h rail-h-hoods">Neighborhoods</h2>
    <ul class="hoodnav">${hoods.map((h) => `<li><a href="${href(p, `neighborhoods/${h.slug}/`)}">${esc(h.name)}</a> <span title="${h.hhCount} with happy hours listed">${h.count}</span></li>`).join('')}</ul>
  </aside>
  <main id="main" class="main">${body}</main>
  <aside class="rail rail-right">
    <section><h2 class="rail-h">Featured bars</h2>
      <ul class="featlist">${featured.length ? featured.map((v) => `<li><a href="${href(p, `bar/${v.slug}/`)}">${esc(v.name)}</a><span>${esc(v.hood)}</span></li>`).join('') : '<li class="muted">Your bar could be here.</li>'}</ul></section>
    <section class="friends"><h2 class="rail-h">Support our friends</h2>
      <a class="sponsor-slot" href="${href(p, 'for-bars/')}"><strong>This spot is open</strong><span>Sponsor 215 Happy Hour and reach people deciding where to go tonight.</span></a></section>
    <section class="news"><h2 class="rail-h">What's new, weekly</h2>
      <p>New specials and weekend deals every Thursday.</p>
      ${config.newsletterFormAction
        ? `<form class="news-form" action="${esc(config.newsletterFormAction)}" method="post" target="_blank"><label class="sr" for="nl-email">Email</label><input id="nl-email" name="fields[email]" type="email" required placeholder="you@email.com"><button type="submit">Sign me up</button></form>`
        : `<p class="muted small">Newsletter launches soon. Email <span class="sel">${esc(config.contactEmail)}</span> to get on the list.</p>`}
    </section>
  </aside>
</div>
<footer class="foot"><div class="wrap">
  <p>215 Happy Hour is the go to source for <a href="${href(p, '')}">Philadelphia happy hours</a>.</p>
  <p class="foot-days">${DAY_FULL.map((d) => `<a href="${href(p, d.toLowerCase() + '/')}">${d} happy hour</a>`).join('<span aria-hidden="true"> | </span>')}</p>
  <p class="foot-small">Listings change. Confirm with the bar before you go. Please drink responsibly. · <a href="${href(p, 'for-bars/')}">Add or fix a listing</a></p>
  <p class="foot-small">© ${config.since}-${BUILD_DATE.getFullYear()}, 215HappyHour.com. All rights reserved.</p>
</div></footer>
<script id="hh-config" type="application/json">${JSON.stringify({ tz: config.timezone, page })}</script>
<script src="${js}" defer></script>`;
  if (PREVIEW && p === 'index.html') return head + '\n' + content;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
${PREVIEW ? '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' : ''}${head}
</head><body>
${content}
</body></html>`;
}

/* ---------- weekly citywide CSV export ---------- */
// One row per special per day for the current week (Mon-Sun, Philadelphia time), all of Philadelphia County.
function weekExport(venues, blocked, specialRows = []) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const ref = process.env.EXPORT_DATE ? new Date(process.env.EXPORT_DATE + 'T17:00:00Z') : BUILD_DATE;
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'short' }).format(ref);
  const todayIdx = DAYS.indexOf(wd);
  const today = new Date(fmt.format(ref) + 'T12:00:00Z');
  const monday = new Date(today.getTime() - todayIdx * 864e5);
  const dates = DAYS.map((_, i) => new Date(monday.getTime() + i * 864e5).toISOString().slice(0, 10));
  const rows = [];
  const q = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const hm = (m) => (m == null ? '' : clock(m));
  for (const v of venues) {
    for (const b of v.blocks) for (const d of b.days) {
      const kind = b.start >= LATE_NIGHT_START ? 'Late-night happy hour' : 'Happy hour';
      for (const deal of (b.deals.length ? b.deals : ['Happy hour (deals not listed on their site)'])) {
        rows.push([dates[d], DAY_FULL[d], v.name, v.hood, v.address, hm(b.start), hm(b.end), deal, kind, b.verified || v.verified, b.source, b.start, d]);
      }
    }
  }
  {
    for (const r of specialRows) {
      if (blocked && blocked.has(addrKey(r.address))) continue;
      const st = toMin(r.start), en = toMin(r.end);
      for (const d of parseDays(r.days)) {
        rows.push([dates[d], DAY_FULL[d], r.name, r.neighborhood || '', r.address, hm(st), hm(en), r.special, 'Daily special', r.verified, r.source_url, st ?? 9999, d]);
      }
    }
  }
  rows.sort((a, b) => a[12] - b[12] || a[11] - b[11] || a[2].localeCompare(b[2]));
  const head = ['week_of', 'date', 'day', 'bar', 'neighborhood', 'address', 'start', 'end', 'special', 'type', 'last_verified', 'source'];
  const body = rows.map((r) => [dates[0], ...r.slice(0, 11)].map(q).join(','));
  return { csv: '\ufeff' + [head.join(','), ...body].join('\r\n') + '\r\n', count: rows.length, week: dates[0] };
}

/* ---------- 404 ---------- */
function notFoundBody(hhVenues) {
  const picks = hhVenues.map((v) => `/bar/${v.slug}/`);
  const glass = `<svg class="nf-glass" viewBox="0 0 120 170" role="img" aria-label="An empty pint glass">
    <path class="nf-glass-body" d="M14 8h92l-10 150a6 6 0 0 1-6 5H30a6 6 0 0 1-6-5z"/>
    <path class="nf-dregs" d="M23.6 140h72.8l-1.3 18a6 6 0 0 1-6 5H30.9a6 6 0 0 1-6-5z"/>
    <path class="nf-foam" d="M24 140c6-4 12 3 18 0s12-4 18 0 12 3 18 0 12-3 18 0"/>
    <g class="nf-bubbles"><circle cx="44" cy="150" r="2.2"/><circle cx="62" cy="154" r="1.6"/><circle cx="78" cy="148" r="2"/><circle cx="54" cy="156" r="1.3"/></g>
    <path class="nf-shine" d="M30 20l-6 100"/>
  </svg>`;
  return `<section class="nf">
  <div class="nf-sign" aria-hidden="true"><span>4</span>${glass}<span>4</span></div>
  <h1>This tap ran dry.</h1>
  <p class="lede">The page you ordered isn't on the menu anymore. Maybe the link got cut off, or this jawn closed up shop. The good news: happy hour is still pouring all over Philly.</p>
  <div class="nf-grid">
    <div class="nf-tab" role="group" aria-labelledby="tab-h">
      <p class="nf-tab-h" id="tab-h">Bar tab #404</p>
      <dl>
        <div><dt>1 × page you wanted</dt><dd>sold out</dd></div>
        <div><dt>1 × wrong turn</dt><dd>on the house</dd></div>
        <div><dt>Tip</dt><dd>try below</dd></div>
      </dl>
      <p class="nf-tab-total"><span>Total</span><span>$0.00</span></p>
      <p class="nf-tab-foot">Thanks for drinking with 215 Happy Hour</p>
    </div>
    <div class="nf-next">
      <h2 class="sec-h">Order something else</h2>
      <form class="nf-search" action="/" method="get" role="search">
        <label class="sr" for="nf-q">Search bars and deals</label>
        <input id="nf-q" name="q" type="search" placeholder="Bar, deal, or drink" autocomplete="off">
        <button type="submit">Search</button>
      </form>
      <ul class="nf-links">
        <li><a href="/">What's pouring right now</a></li>
        <li><a href="/monday/" id="nf-today">Today's happy hours</a></li>
        <li><a href="/late-night/">Late-night deals</a></li>
        <li><a href="/neighborhoods/">Browse by neighborhood</a></li>
      </ul>
      ${picks.length ? `<button class="btn nf-random" type="button" id="nf-random">Pour me a random happy hour</button>` : ''}
    </div>
  </div>
</section>
<script>(function(){
  var picks=${JSON.stringify(picks)};
  var b=document.getElementById('nf-random');
  if(b) b.addEventListener('click',function(){ location.href=picks[Math.floor(Math.random()*picks.length)]; });
  var days=['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  var wd=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'long'}).format(new Date()).toLowerCase();
  var t=document.getElementById('nf-today'); if(t && days.indexOf(wd)>-1){ t.href='/'+wd+'/'; t.textContent=wd.charAt(0).toUpperCase()+wd.slice(1)+"'s happy hours"; }
})();</script>`;
}

/* ---------- pages ---------- */
async function main() {
  // Only bars whose happy hour is published (on their own site, or confirmed in the sheet) are listed.
  // DB_CSV: the deploy job exports live happy hours from Supabase (tools/site_export.sql) and builds from that.
  // Without it (local previews), build from the Google Sheet and data/website-happy-hours.csv as before.
  const dbRows = process.env.DB_CSV ? parseCSV(fs.readFileSync(process.env.DB_CSV, 'utf8')) : null;
  if (dbRows) console.log(`Building from Supabase: ${dbRows.length} happy hour rows in ${process.env.DB_CSV}`);
  // safety: never publish a near-empty site because of a bad export; the build stops and the last good site stays up
  if (dbRows && dbRows.length < 50) throw new Error(`Supabase export has only ${dbRows.length} happy hours; refusing to publish. Check the database.`);
  const everyone = buildModel(dbRows || [...(await loadRows()), ...loadWebsiteRows()]);
  let venues = everyone.filter((v) => v.blocks.length);
  console.log(`Listing ${venues.length} bars with happy hour details; ${everyone.length - venues.length} without are not listed`);
  // map coordinates (tools/geocode.py) and hand-written bar descriptions, matched by address
  const byKey = (f) => fs.existsSync(f) ? new Map(parseCSV(fs.readFileSync(f, 'utf8')).map((r) => [addrKey(r.address), r])) : new Map();
  const coords = byKey(path.join(ROOT, 'data', 'coords.csv'));
  const notes = byKey(path.join(ROOT, 'data', 'bar-notes.csv'));
  for (const v of venues) {
    const c = coords.get(addrKey(v.address));
    if (c && !isFinite(v.lat)) { v.lat = parseFloat(c.lat); v.lng = parseFloat(c.lng); }
    const n = notes.get(addrKey(v.address));
    if (n && n.about) v.about = n.about;
  }
  console.log(`Map coordinates for ${venues.filter((v) => isFinite(v.lat)).length} of ${venues.length} bars`);
  // Weekly specials (Taco Tuesday, $1 wings...): kept apart from happy hours. From Supabase (DAILY_CSV) or the repo file.
  const specialsFile = process.env.DAILY_CSV || path.join(ROOT, 'data', 'daily-specials.csv');
  const specialRows = fs.existsSync(specialsFile) ? parseCSV(fs.readFileSync(specialsFile, 'utf8')).filter((r) => r.special && !BLOCKED_ADDR.has(addrKey(r.address))) : [];
  const vByAddr = new Map(venues.map((v) => [addrKey(v.address), v]));
  const vByName = new Map(venues.map((v) => [slugify(v.name), v]));
  for (const v of venues) v.specials = [];
  for (const r of specialRows) {
    const v = vByAddr.get(addrKey(r.address)) || vByName.get(slugify(r.name));
    const days = parseDays(r.days);
    if (v && days.length) v.specials.push({ days, start: toMin(r.start), end: toMin(r.end), special: r.special, verified: r.verified, source: r.source_url });
  }
  console.log(`Weekly specials: ${specialRows.length} rows, ${venues.filter((v) => v.specials.length).length} listed bars show them`);
  if (process.env.LIST_VENUES) {
    fs.writeFileSync(process.env.LIST_VENUES, 'name,address\n' + venues.map((v) => [v.name, v.address].map((x) => `"${String(x || '').replace(/"/g, '""')}"`).join(',')).join('\n') + '\n');
    console.log(`Wrote ${venues.length} bars to ${process.env.LIST_VENUES}`);
  }
  if (!venues.length) {
    // Sheet has no bars with times yet: keep publishing the sample listings so code changes still go live.
    console.log('No bars with happy hour times in the sheet yet. Building from the sample listings in data/venues.csv.');
    venues = buildModel(parseCSV(fs.readFileSync(path.join(ROOT, 'data', 'venues.csv'), 'utf8')));
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  const write = (p, html) => {
    const f = path.join(OUT, p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // house style: plain hyphens only, never en or em dashes (also catches dashes typed into the data)
    fs.writeFileSync(f, html.replace(/[\u2013\u2014]/g, '-'));
  };
  const hoodMap = new Map();
  for (const v of venues) {
    if (!hoodMap.has(v.hoodSlug)) hoodMap.set(v.hoodSlug, { slug: v.hoodSlug, name: v.hood, venues: [] });
    hoodMap.get(v.hoodSlug).venues.push(v);
  }
  const hoods = [...hoodMap.values()].map((h) => ({ ...h, count: h.venues.length, hhCount: h.venues.filter((v) => v.blocks.length).length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const hhVenues = venues.filter((v) => v.blocks.length);
  const hoodGrid = (from) => `<ul class="hood-grid">${hoods.map((h) => `<li><a href="${href(from, `neighborhoods/${h.slug}/`)}"><strong>${esc(h.name)}</strong><span>${h.count} ${h.count === 1 ? 'bar' : 'bars'}${h.hhCount ? ` · ${h.hhCount} with happy hours` : ''}</span></a></li>`).join('')}</ul>`;
  const dirList = (from, list) => `<ul class="dir-list">${list.map((v) => `<li><a href="${href(from, `bar/${v.slug}/`)}">${esc(v.name)}</a><span>${esc(v.address || '')}${v.vibe ? ' · ' + esc(v.vibe) : ''}</span></li>`).join('')}</ul>`;
  const ctx = { venues, hoods };
  const pairs = (filter = () => true) => venues.flatMap((v) => v.blocks.filter((b) => filter(v, b)).map((b) => [v, b]))
    .sort((x, y) => x[1].start - y[1].start || x[0].name.localeCompare(y[0].name));
  const listHTML = (from, items, opts) => items.length
    ? `<div class="hh-list">${items.map(([v, b]) => card(v, b, from, opts)).join('\n')}</div><p class="empty" id="empty" hidden>No happy hours match those filters. Try another day or neighborhood.</p>`
    : `<p class="empty">No happy hours listed here yet. We're adding them every day.</p>`;
  const urls = [];
  // lastmod = newest "verified" date among the bars a page shows (blank if none), so Google sees real changes only
  const newest = (list) => list.map((v) => v.verified).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop() || '';
  const page = (p, opts) => {
    write(p, shell(p, { ...ctx, ...opts }));
    if (!opts.noindex) urls.push({ p, lastmod: opts.lastmod || '' });
  };
  const venuesOf = (items) => [...new Set(items.map(([v]) => v))];

  // Home
  page('index.html', {
    title: `Philadelphia Happy Hours Today | ${config.siteName}`,
    description: `Every happy hour in Philly, live: ${hhVenues.length || venues.length} bars and restaurants by neighborhood, day and deal. See what's pouring right now. Updated ${monthYear}.`,
    page: { type: 'home' },
    lastmod: newest(venues),
    schema: { '@context': 'https://schema.org', '@type': 'WebSite', name: config.siteName, url: config.siteUrl + '/', description: config.tagline },
    body: hhVenues.length ? `<section class="hero">
  <p class="eyebrow" id="clock">Philadelphia happy hours</p>
  <h1><span class="hero-count" id="live-count">${hhVenues.length}</span> <span id="live-label">bars with happy hours in Philly</span></h1>
  <p class="lede">Every happy hour in the 215, sorted by what's pouring now. Pick a day, a neighborhood, or just follow the clock.</p>
</section>
${filterBar({ when: 'today', hoods, items: pairs() })}
${listHTML('index.html', pairs())}
<h2 class="sec-h">Browse ${venues.length.toLocaleString()} Philly bars by neighborhood</h2>
${hoodGrid('index.html')}` : `<section class="hero">
  <p class="eyebrow" id="clock">Philadelphia happy hours</p>
  <h1><span class="hero-count">${venues.length.toLocaleString()}</span> Philly bars and restaurants</h1>
  <p class="lede">We're adding happy hour times and specials every day. Pick a neighborhood to see its bars. Know a great happy hour? <a href="${href('index.html', 'for-bars/')}">Tell us.</a></p>
</section>
${hoodGrid('index.html')}`,
  });

  // Days
  DAY_FULL.forEach((d, i) => {
    const items = pairs((v, b) => b.days.includes(i));
    page(`${d.toLowerCase()}/index.html`, {
      title: `${d} Happy Hours in Philadelphia (${items.length} Deals) | ${config.siteName}`,
      description: `${d} happy hour specials at ${items.length} Philly bars and restaurants, with times, drink and food deals by neighborhood. Updated ${monthYear}.`,
      page: { type: 'day', day: i },
      noindex: !items.length,
      lastmod: newest(venuesOf(items)),
      body: `<section class="hero hero-sm"><p class="eyebrow">Select a day · ${d}</p>
  <h1>${d} Philadelphia Happy Hours</h1>
  <p class="lede">Browse these local bars to find the drink deals and food specials that fit your tastes. Can't find your favorite bar? <a href="${href(`${d.toLowerCase()}/index.html`, 'for-bars/')}">Send us the details.</a> Cheers!</p></section>
${filterBar({ when: String(i), showWhen: false, hoods, items })}
${listHTML(`${d.toLowerCase()}/index.html`, items)}
${(() => {
      const sp = venues.flatMap((v) => v.specials.filter((x) => x.days.includes(i)).map((x) => ({ v, x }))).sort((a, b) => a.v.name.localeCompare(b.v.name));
      const from = `${d.toLowerCase()}/index.html`;
      return sp.length ? `<section class="also-today" aria-labelledby="also-h"><h2 id="also-h" class="sec-h">Also on ${d}s: weekly specials</h2>
<p class="muted small">Not happy hours: day-of-the-week deals at bars we list.</p>
<ul class="also-list">${sp.map(({ v, x }) => `<li><a href="${href(from, `bar/${v.slug}/`)}">${esc(v.name)}</a> <span class="muted">${esc(v.hood)}</span><span class="also-deal">${esc(x.special)}${x.start != null && x.end != null ? ` · ${rangeLabel(x.start, x.end)}` : ''}</span></li>`).join('')}</ul></section>` : '';
    })()}`,
    });
  });

  // Late night & weekend
  const late = pairs((v, b) => b.start >= LATE_NIGHT_START);
  page('late-night/index.html', {
    title: `Late-Night Happy Hours in Philadelphia | ${config.siteName}`,
    description: `Philly happy hours that start at 9 pm or later. Pennsylvania happy hours must end by midnight, so here's where to go after dinner.`,
    page: { type: 'list' },
    noindex: !late.length,
    lastmod: newest(venuesOf(late)),
    body: `<section class="hero hero-sm"><p class="eyebrow">After 9 pm</p><h1>Late-night happy hours in Philly</h1>
  <p class="lede">For the after-work-shift crowd. Pennsylvania law ends every happy hour by midnight, so these run roughly 9 pm to close of the deal.</p></section>
${filterBar({ when: 'any', hoods, items: late })}${listHTML('late-night/index.html', late)}`,
  });
  const weekend = pairs((v, b) => b.days.includes(5) || b.days.includes(6));
  page('weekend/index.html', {
    title: `Weekend Happy Hours in Philadelphia | ${config.siteName}`,
    description: `Saturday and Sunday happy hours in Philly, from day-drinking patios to late-night deals.`,
    page: { type: 'list' },
    noindex: !weekend.length,
    lastmod: newest(venuesOf(weekend)),
    body: `<section class="hero hero-sm"><p class="eyebrow">Saturday & Sunday</p><h1>Weekend happy hours in Philly</h1>
  <p class="lede">Happy hour doesn't have to mean leaving work at 5. These deals run on Saturdays and Sundays.</p></section>
${filterBar({ when: 'any', hoods, items: weekend })}${listHTML('weekend/index.html', weekend)}`,
  });

  // Neighborhoods
  page('neighborhoods/index.html', {
    title: `Philadelphia Happy Hours by Neighborhood | ${config.siteName}`,
    description: `Find happy hours in ${hoods.slice(0, 5).map((h) => h.name).join(', ')} and every Philly neighborhood.`,
    page: { type: 'hoods' },
    lastmod: newest(venues),
    body: `<section class="hero hero-sm"><p class="eyebrow">Neighborhoods</p><h1>Happy hours by neighborhood</h1>
  <p class="lede">From Rittenhouse after-work spots to South Philly corner bars.</p></section>
${hoodGrid('neighborhoods/index.html')}`,
  });
  for (const h of hoods) {
    const p = `neighborhoods/${h.slug}/index.html`;
    const items = pairs((v) => v.hoodSlug === h.slug);
    const others = h.venues.filter((v) => !v.blocks.length);
    page(p, {
      title: `${h.name} Happy Hours & Bars - ${h.count} ${h.count === 1 ? 'Spot' : 'Spots'}, Updated ${monthYear} | ${config.siteName}`,
      description: `Happy hour times and specials at ${h.name} bars and restaurants in Philadelphia${h.hhCount ? `, with deals at ${h.hhCount}` : ''}. ${h.count} bars listed.`,
      page: { type: 'hood', hood: h.slug },
      lastmod: newest(h.venues),
      schema: { '@context': 'https://schema.org', '@type': 'ItemList', name: `${h.name} happy hours`, itemListElement: h.venues.map((v, i) => ({ '@type': 'ListItem', position: i + 1, url: canonical(`bar/${v.slug}/`), name: v.name })) },
      body: `<section class="hero hero-sm"><p class="eyebrow"><a href="${href(p, 'neighborhoods/')}">Neighborhoods</a> · ${esc(h.name)}</p><h1>${esc(h.name)} happy hours</h1></section>
${items.length ? filterBar({ when: 'any', showHood: false, hoods }) + listHTML(p, items, { hideHood: true }) : `<p class="lede">No happy hours listed in ${esc(h.name)} yet. Know one? Email <span class="sel">${esc(config.contactEmail)}</span>.</p>`}
${others.length ? `<h2 class="sec-h">${items.length ? 'More bars' : 'Bars'} in ${esc(h.name)}</h2><p class="muted small">Happy hour times for these are coming soon.</p>${dirList(p, others)}` : ''}`,
    });
  }

  // Venues
  for (const v of venues) {
    const p = `bar/${v.slug}/index.html`;
    // nearby: closest bars within 1.5 miles; fill from the same neighborhood when coordinates are missing
    let near = isFinite(v.lat) ? venues.filter((x) => x !== v && x.blocks.length && isFinite(x.lat)).map((x) => ({ x, d: miles(v, x) })).filter((o) => o.d <= 1.5).sort((a, b) => a.d - b.d).slice(0, 6) : [];
    if (near.length < 3) near = near.concat(venues.filter((x) => x !== v && x.blocks.length && x.hoodSlug === v.hoodSlug && !near.some((o) => o.x === x)).map((x) => ({ x, d: null }))).slice(0, 6);
    const map = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name} ${v.address} Philadelphia PA`)}`;
    const summary = v.blocks.map((b) => `${daysLabel(b.days)} ${rangeLabel(b.start, b.end)}`).join('; ');
    const hasHH = v.blocks.length > 0;
    const sameHood = hoodMap.get(v.hoodSlug).venues.filter((x) => x !== v && !x.blocks.length).slice(0, 8);
    page(p, {
      title: hasHH ? `${v.name} Happy Hour - Times & Specials | ${config.siteName}` : `${v.name}, ${v.hood} | ${config.siteName}`,
      description: hasHH ? `${v.name} happy hour in ${v.hood}: ${summary}. ${v.blocks[0].deals.slice(0, 3).join(', ')}.` : `${v.name} at ${v.address || v.hood}, Philadelphia. Happy hour times coming soon.`,
      page: { type: 'bar' },
      noindex: !hasHH,
      lastmod: newest([v]),
      schema: {
        '@context': 'https://schema.org', '@type': 'BarOrPub', name: v.name, url: v.website || canonical(p),
        address: { '@type': 'PostalAddress', streetAddress: v.address, addressLocality: 'Philadelphia', addressRegion: 'PA', addressCountry: 'US' },
        ...(v.phone ? { telephone: v.phone } : {}),
        ...(isFinite(v.lat) ? { geo: { '@type': 'GeoCoordinates', latitude: v.lat, longitude: v.lng } } : {}),
        makesOffer: v.blocks.flatMap((b) => b.deals.map((d) => ({ '@type': 'Offer', name: d, description: `Happy hour ${daysLabel(b.days)} ${rangeLabel(b.start, b.end)}` }))),
      },
      body: `<section class="vcard" aria-labelledby="v-name">
  <p class="eyebrow"><a href="${href(p, `neighborhoods/${v.hoodSlug}/`)}">${esc(v.hood)}</a>${v.vibe ? ' · ' + esc(v.vibe) : ''}${v.classic ? ' · <span class="badge badge-classic">215 Classic</span>' : ''}</p>
  <h1 id="v-name" class="v-name">${esc(v.name)}</h1>
  ${hasHH ? `<p class="vstatus" data-blocks='${JSON.stringify(v.blocks.map((b) => [b.days, b.start, b.end]))}'><span class="vstatus-dot" aria-hidden="true"></span><span class="vstatus-text">${esc(summary)}</span></p>` : ''}
  ${v.about ? `<p class="v-about">${esc(v.about)}</p>` : ''}
  <dl class="v-facts">
    ${v.address ? `<div><dt>Address</dt><dd>${esc(v.address)}<br><a href="${map}" target="_blank" rel="noopener">Get directions</a></dd></div>` : ''}
    ${v.phone ? `<div><dt>Phone</dt><dd><a href="tel:${esc(v.phone.replace(/[^0-9+]/g, ''))}">${esc(v.phone)}</a></dd></div>` : ''}
    ${v.website ? `<div><dt>Website</dt><dd><a href="${esc(v.website)}" target="_blank" rel="noopener">${esc(host(v.website) || 'Visit site')}</a>${v.instagram ? `<br><a href="https://instagram.com/${esc(v.instagram.replace('@', ''))}" target="_blank" rel="noopener">${esc(v.instagram)}</a>` : ''}</dd></div>` : ''}
    ${v.verified ? `<div><dt>Last verified</dt><dd>${fmtDate(v.verified)}</dd></div>` : ''}
  </dl>
  ${v.sample ? '<p><span class="badge badge-sample">Sample listing</span></p>' : ''}
</section>
${hasHH ? (() => {
      const sameDeals = v.blocks.every((b) => JSON.stringify(b.deals) === JSON.stringify(v.blocks[0].deals));
      const dealList = (ds) => ds.length ? `<ul class="deal-list">${ds.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : '<p class="muted">Deals not posted yet. Ask at the bar, or email us if you know them.</p>';
      const src = v.blocks.map((b) => b.source).find(Boolean);
      return `<div class="v-grid">
  <section class="v-panel" aria-labelledby="v-week"><h2 id="v-week" class="v-h">This week</h2>
    <ol class="week">${DAY_FULL.map((d, i) => { const bs = v.blocks.filter((b) => b.days.includes(i)); return `<li data-day="${i}"${bs.length ? '' : ' class="is-off"'}><span class="wk-day">${d}</span><span class="wk-time">${bs.length ? bs.map((b) => rangeLabel(b.start, b.end)).join(' &amp; ') : 'No happy hour'}</span></li>`; }).join('')}</ol>
  </section>
  <section class="v-panel" aria-labelledby="v-deals"><h2 id="v-deals" class="v-h">The deals</h2>
    ${sameDeals ? dealList(v.blocks[0].deals) : v.blocks.map((b) => `<h3 class="v-sub">${daysLabel(b.days)} · ${rangeLabel(b.start, b.end)}</h3>${dealList(b.deals)}`).join('')}
    ${src ? `<p class="v-source">Source: <a href="${esc(src)}" target="_blank" rel="noopener">${esc(host(src))}</a>${v.verified ? ` · checked ${fmtDate(v.verified)}` : ''}</p>` : ''}
  </section>
</div>
${v.specials.length ? `<section class="v-panel v-weekly" aria-labelledby="v-weekly"><h2 id="v-weekly" class="v-h">Weekly specials</h2>
    <p class="muted small">Separate from happy hour: these run on their own days and times.</p>
    <ol class="week">${DAY_FULL.map((d, i) => { const ss = v.specials.filter((x) => x.days.includes(i)); return ss.length ? `<li data-day="${i}"><span class="wk-day">${d}</span><span class="wk-special">${ss.map((x) => esc(x.special) + (x.start != null && x.end != null ? ` <span class="muted">(${rangeLabel(x.start, x.end)})</span>` : '')).join('<br>')}</span></li>` : ''; }).join('')}</ol>
    ${v.specials[0].source ? `<p class="v-source">Source: <a href="${esc(v.specials[0].source)}" target="_blank" rel="noopener">${esc(host(v.specials[0].source))}</a>${v.specials[0].verified ? ` · checked ${fmtDate(v.specials[0].verified)}` : ''}</p>` : ''}
  </section>` : ''}
<p class="report">Something changed? Email <span class="sel">${esc(config.contactEmail)}</span> with the bar name and the new specials.</p>`;
    })() : `<div class="notice"><h2>Happy hour not listed yet</h2><p>We haven't confirmed ${esc(v.name)}'s happy hour. Work here or know the deals? Email <span class="sel">${esc(config.contactEmail)}</span> with the days, times and specials and we'll add them.</p></div>`}
${near.length ? `<section class="nearby" aria-labelledby="v-near"><h2 id="v-near" class="sec-h">Nearby happy hours</h2><p class="muted small">${near[0].d != null ? 'Closest first, by walking distance.' : `More in ${esc(v.hood)}.`}</p>
<ul class="near-grid">${near.map(({ x, d }) => `<li><a class="near-card" href="${href(p, `bar/${x.slug}/`)}"><span class="nc-name">${esc(x.name)}</span><span class="nc-where">${d != null ? (d < 0.1 ? 'Steps away · ' : `${d.toFixed(1)} mi · ${Math.round(d * 20)} min walk · `) : ''}${esc(x.hood)}</span><span class="nc-when">${esc(x.blocks.map((b) => `${daysLabel(b.days)} ${rangeLabel(b.start, b.end)}`).slice(0, 2).join(' · '))}</span>${x.blocks[0].deals.length ? `<span class="nc-deals">${esc(x.blocks[0].deals.slice(0, 2).join(' · '))}</span>` : ''}</a></li>`).join('')}</ul></section>` : ''}
${!hasHH && sameHood.length ? `<h2 class="sec-h">Other bars in ${esc(v.hood)}</h2>${dirList(p, sameHood)}` : ''}`,
    });
  }

  // About (throwback)
  const archive = [
    ['Marathon on the Square', '1839 Spruce St.', '4:00pm - 7:00pm', ['$15 Margarita Pitchers', '$4 House Wines (red or white)', '$5 Marathon Cocktails', "$3 Yard's Drafts"]],
    ["McGillin's", '1310 Drury St.', '5:00pm - 7:00pm', ['$1 Featured Microbrew', '$5 Beer Pitchers']],
    ['Tir Na Nog Bar & Grill', '1600 Arch St.', '5:00pm - 7:00pm', ['$3 Stella Artois Bottles', '$3 Wine (red or white)', '$3 Melon Ball']],
    ["Finn McCool's", '118 S. 12th St.', '5:00pm - 7:00pm', ['$3 Stella Artois', '$3 Well Mixed Drinks', '1/2 Priced Appetizers']],
    ['Di Vino Wine Bar', '267 S. 19th St.', '5:00pm - 7:00pm', ['All Drinks are 1/2 price']],
    ['Elephant & Castle', '1800 Market St.', '5:00pm - 7:00pm', ['$4 Coors Light', '$4 Yuengling Draft', '1/2 Priced Chicken Wings']],
  ];
  page('about/index.html', {
    title: `About 215 Happy Hour - Philly's Happy Hour Source Since ${config.since}`,
    description: `215 Happy Hour has listed Philadelphia happy hours since ${config.since}. Here's the story, and a look back at the original site.`,
    page: { type: 'about' },
    body: `<section class="hero hero-sm"><p class="eyebrow">Since ${config.since}</p><h1>Philadelphia's happy hour source, then and now</h1>
  <p class="lede">215 Happy Hour started in ${config.since} as a simple list of after-work drink specials, one page for each weekday. The idea hasn't changed: get you to the right place at the right time.</p></section>
<blockquote class="og-quote"><p>Whether it be a cozy little pub where you can unwind after work or an upscale bar where you can entertain clients, our website will have the information that can get you in the right place at the right time. Cheers!!</p><cite>215HappyHour.com, ${config.since}</cite></blockquote>
<h2 class="sec-h">What's new in the 2026 version</h2>
<ul class="plain-list"><li>A live view of what's pouring right now, with minutes left on each deal.</li><li>All seven days, plus late-night and weekend pages.</li><li>Every Philly neighborhood, every deal type, searchable.</li><li>A verified date on every listing, and an easy way for bars to send updates.</li></ul>
<h2 class="sec-h">From the archive: Monday, January 2011</h2>
<p class="muted">A few listings from the original Monday page, exactly as they ran. These are 2011 prices and some of these places have changed or closed, so treat this as a time capsule, not a guide.</p>
<div class="archive">${archive.map(([n, a, t, d]) => `<div class="arch"><p class="arch-name">${esc(n)}</p><p class="arch-addr">${esc(a)} Philadelphia, PA</p><p class="arch-time">${esc(t)}</p>${d.map((x) => `<p>${esc(x)}</p>`).join('')}</div>`).join('')}</div>
<p class="muted small">Bars that were on the original site and still run a happy hour get a <span class="badge badge-classic">215 Classic</span> badge.</p>`,
  });

  // For bars
  const tiers = [
    ['Basic', 'Free', ['Your listing, specials and hours', 'Directions and contact links', 'Monthly email with your views and direction taps']],
    ['Featured', 'From $49 / month', ['Top of your neighborhood and day pages', 'Featured badge and right-rail placement', 'Photos and event posts']],
    ['Neighborhood sponsor', 'From $200 / month', ['The "Support our friends" spot on one neighborhood', 'One social post or reel each month', 'One sponsor per neighborhood']],
    ['Newsletter sponsor', 'From $100 / send', ['Top slot in the Thursday email', 'Cross-posted to social']],
  ];
  page('for-bars/index.html', {
    title: `List Your Happy Hour | ${config.siteName}`,
    description: `Bars and restaurants: list your Philadelphia happy hour on 215 Happy Hour for free, or get featured.`,
    page: { type: 'bars' },
    body: `<section class="hero hero-sm"><p class="eyebrow">For bars & restaurants</p><h1>Put your happy hour in front of Philly</h1>
  <p class="lede">Listings are free. People use 215 Happy Hour to decide where to go in the next hour, so an accurate listing turns into foot traffic.</p></section>
<h2 class="sec-h">How to get listed</h2>
<p>We list every Philly bar and restaurant that publishes its happy hour. The easiest way in is to put it on your own website:</p>
<ol class="plain-list"><li>The days and times of each happy hour</li><li>The specials, with prices</li><li>Keep it as text on the page (or a linked PDF menu), not only in a photo</li></ol>
<p>We check bar websites every week, so changes you make there show up here on their own.</p>
<h2 class="sec-h">No website, or want to send it directly?</h2>
<p>Email <span class="sel" id="email">${esc(config.contactEmail)}</span> <button class="copy" type="button" data-copy="${esc(config.contactEmail)}">Copy</button> with your bar's name and address, happy hour days and times, and specials with prices.</p>
<p class="muted small">Every listing shows the date we last confirmed it.</p>
<h2 class="sec-h">Get featured</h2>
<div class="tiers">${tiers.map(([n, pr, f]) => `<div class="tier"><h3>${esc(n)}</h3><p class="price">${esc(pr)}</p><ul>${f.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}</div>
<p class="muted small">Every paid placement is labeled as sponsored. Ask about multi-location packages.</p>`,
  });

  // 404 (served at any path, so use root-absolute assets on the live site)
  if (!PREVIEW) {
    let nf = shell('404.html', { ...ctx, title: `Page Not Found | ${config.siteName}`, description: 'Page Not Found', page: { type: '404' }, noindex: true,
      body: notFoundBody(hhVenues) });
    nf = nf.replace(/(href|src)="(?!https?:|\/|#|mailto)([^"]*)"/g, (m, a, u) => `${a}="/${u.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '')}"`);
    write('404.html', nf);
  }

  // Assets
  fs.copyFileSync(path.join(ROOT, 'src', 'styles.css'), path.join(OUT, 'styles.css'));
  fs.copyFileSync(path.join(ROOT, 'src', 'app.js'), path.join(OUT, 'app.js'));
  fs.writeFileSync(path.join(OUT, 'favicon.svg'), LOGO.replace('class="mug" ', 'xmlns="http://www.w3.org/2000/svg" ').replace(/var\(--olive\)/g, '#4f6b34').replace(/var\(--cream\)/g, '#f3efcf'));
  if (!PREVIEW) {
    for (const f of fs.readdirSync(path.join(ROOT, 'static'))) fs.copyFileSync(path.join(ROOT, 'static', f), path.join(OUT, f));
    fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${canonical(u.p)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`);
    console.log(`Sitemap: ${urls.length} pages`);
    fs.mkdirSync(path.join(OUT, 'exports'), { recursive: true });
    const fx = weekExport(venues, BLOCKED_ADDR, specialRows);
    fs.writeFileSync(path.join(OUT, 'exports', 'philly-happy-hours.csv'), fx.csv.replace(/[\u2013\u2014]/g, '-'));
    console.log(`Citywide export: ${fx.count} rows for the week of ${fx.week}`);
    fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /exports/\nSitemap: ${config.siteUrl}/sitemap.xml\n`);
  }
  console.log(`Built ${fs.readdirSync(OUT, { recursive: true }).filter((f) => f.endsWith('.html')).length} pages for ${venues.length} venues in ${hoods.length} neighborhoods -> ${path.relative(ROOT, OUT)}/`);
}

main();
