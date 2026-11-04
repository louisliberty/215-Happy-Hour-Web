#!/usr/bin/env node
/*
  215 Happy Hour — static site builder (no dependencies, Node 18+)

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
const slugify = (s) => String(s).toLowerCase()
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
    return len === 2 ? `${DAYS[s]} & ${DAYS[e]}` : `${DAYS[s]}–${DAYS[e]}`;
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
  return `${clock(start, !sameHalf)}–${clock(end)}`;
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

function buildModel(rows) {
  const venues = new Map();
  const problems = [];
  const skipped = { hidden: 0, closed: 0, club: 0, deli: 0, companyName: 0 };
  const slugs = new Set();
  rows.forEach((r, i) => {
    if (!r.name) return;
    if (r.active && !yes(r.active)) { skipped.hidden++; return; }
    const status = (r.status || '').toLowerCase();
    if (status === 'closed' || status === 'no hh') { skipped.closed++; return; }
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
    const key = slugify(r.name) + '|' + slugify((r.address || '').replace(/\s(ste|suite|unit|fl|floor|space)\b.*$/i, ''));
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
        lat: parseFloat(r.lat), lng: parseFloat(r.lng), vibe: r.vibe || (generic ? '' : r.type),
        featured: false, classic: false, sample: false, verified: '', blocks: [],
      });
    }
    const v = venues.get(key);
    for (const k of ['address', 'phone', 'website', 'instagram', 'vibe']) if (!v[k] && r[k]) v[k] = r[k];
    v.featured ||= yes(r.featured);
    v.classic ||= yes(r.classic);
    v.sample ||= yes(r.sample);
    if (r.verified && r.verified > v.verified) v.verified = r.verified;
    if (!days.length || start == null || end == null) return; // listed without happy hour times yet
    if (end - start > 240) problems.push(`Row ${i + 2} (${r.name}): longer than PA's 4-hour daily limit`);
    if (end > 23 * 60 + 59) problems.push(`Row ${i + 2} (${r.name}): PA happy hours must end by midnight`);
    v.blocks.push({
      days, start, end,
      deals: (r.deals || '').split('|').map((s) => s.trim()).filter(Boolean),
      tags: (r.tags || '').split(/[,|]/).map((s) => s.trim().toLowerCase()).filter(Boolean),
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
const LOGO = `<svg class="mug" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="7" fill="var(--olive)"/><path d="M14 22h9v4h-5v12h5v4h-9z" fill="var(--cream)"/><path d="M22 15c2-3 5-3 7-1 2-3 7-3 9 0 2-2 6-1 6 3v32a3 3 0 0 1-3 3H25a3 3 0 0 1-3-3z" fill="var(--cream)"/><g fill="var(--olive)" font-family="Georgia,serif" font-size="9.5" text-anchor="middle"><text x="33.5" y="28">2</text><text x="33.5" y="38">1</text><text x="33.5" y="48">5</text></g></svg>`;


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

function filterBar({ when = 'any', showWhen = true, showHood = true, hoods = [] }) {
  return `<form class="filters" role="search" data-default-when="${when}" onsubmit="return false">
  ${showWhen ? `<label class="f-field"><span>When</span><select id="f-when" name="when">
    <option value="now">Live right now</option><option value="today">Today</option>
    ${DAY_FULL.map((d, i) => `<option value="${i}">${d}</option>`).join('')}
    <option value="any">Any day</option></select></label>` : ''}
  ${showHood ? `<label class="f-field"><span>Neighborhood</span><select id="f-hood" name="hood"><option value="">All of Philly</option>${hoods.map((h) => `<option value="${esc(h.slug)}">${esc(h.name)}</option>`).join('')}</select></label>` : ''}
  <label class="f-field f-search"><span>Search</span><input id="f-q" name="q" type="search" placeholder="Bar, deal, or drink" autocomplete="off"></label>
  <fieldset class="f-chips"><legend class="sr">Deal type</legend>${DEAL_TYPES.map(([k, l]) => `<label class="chip"><input type="checkbox" id="f-${k}" name="type" value="${k}"><span>${l}</span></label>`).join('')}</fieldset>
</form>
<p class="results" id="results" aria-live="polite"></p>`;
}

function shell(p, { title, description, body, schema, page = {}, venues, hoods, noindex = false }) {
  const featured = venues.filter((v) => v.featured);
  const css = href(p, '').replace(/index\.html$/, '') + 'styles.css';
  const js = href(p, '').replace(/index\.html$/, '') + 'app.js';
  const dayNav = DAY_FULL.map((d, i) => `<li><a href="${href(p, d.toLowerCase() + '/')}" data-day="${i}"${page.day === i ? ' aria-current="page"' : ''}>${d.toLowerCase()}</a></li>`).join('');
  const head = `<title>${esc(title)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="${esc(description)}">${noindex ? '\n<meta name="robots" content="noindex, follow">' : ''}
${PREVIEW ? '' : `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="canonical" href="${canonical(p)}">`}
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website"><meta property="og:url" content="${canonical(p)}">
<link rel="icon" href="${css.replace('styles.css', 'favicon.svg')}" type="image/svg+xml">
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
  <p class="foot-small">© ${config.since}–${BUILD_DATE.getFullYear()}, 215HappyHour.com. All rights reserved.</p>
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

/* ---------- pages ---------- */
async function main() {
  let venues = buildModel(await loadRows());
  if (!venues.length) {
    // Sheet has no bars with times yet: keep publishing the sample listings so code changes still go live.
    console.log('No bars with happy hour times in the sheet yet. Building from the sample listings in data/venues.csv.');
    venues = buildModel(parseCSV(fs.readFileSync(path.join(ROOT, 'data', 'venues.csv'), 'utf8')));
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  const write = (p, html) => {
    const f = path.join(OUT, p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, html);
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
  const page = (p, opts) => { write(p, shell(p, { ...ctx, ...opts })); if (!opts.noindex) urls.push(p); };

  // Home
  page('index.html', {
    title: `Philadelphia Happy Hours Today | ${config.siteName}`,
    description: `Every happy hour in Philly, live: ${hhVenues.length || venues.length} bars and restaurants by neighborhood, day and deal. See what's pouring right now. Updated ${monthYear}.`,
    page: { type: 'home' },
    schema: { '@context': 'https://schema.org', '@type': 'WebSite', name: config.siteName, url: config.siteUrl + '/', description: config.tagline },
    body: hhVenues.length ? `<section class="hero">
  <p class="eyebrow" id="clock">Philadelphia happy hours</p>
  <h1><span class="hero-count" id="live-count">${hhVenues.length}</span> <span id="live-label">bars with happy hours in Philly</span></h1>
  <p class="lede">Every happy hour in the 215, sorted by what's pouring now. Pick a day, a neighborhood, or just follow the clock.</p>
</section>
${filterBar({ when: 'today', hoods })}
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
      body: `<section class="hero hero-sm"><p class="eyebrow">Select a day · ${d}</p>
  <h1>${d} Philadelphia Happy Hours</h1>
  <p class="lede">Browse these local bars to find the drink deals and food specials that fit your tastes. Can't find your favorite bar? <a href="${href(`${d.toLowerCase()}/index.html`, 'for-bars/')}">Send us the details.</a> Cheers!</p></section>
${filterBar({ when: String(i), showWhen: false, hoods })}
${listHTML(`${d.toLowerCase()}/index.html`, items)}`,
    });
  });

  // Late night & weekend
  const late = pairs((v, b) => b.start >= LATE_NIGHT_START);
  page('late-night/index.html', {
    title: `Late-Night Happy Hours in Philadelphia | ${config.siteName}`,
    description: `Philly happy hours that start at 9 pm or later. Pennsylvania happy hours must end by midnight, so here's where to go after dinner.`,
    page: { type: 'list' },
    body: `<section class="hero hero-sm"><p class="eyebrow">After 9 pm</p><h1>Late-night happy hours in Philly</h1>
  <p class="lede">For the after-work-shift crowd. Pennsylvania law ends every happy hour by midnight, so these run roughly 9 pm to close of the deal.</p></section>
${filterBar({ when: 'any', hoods })}${listHTML('late-night/index.html', late)}`,
  });
  const weekend = pairs((v, b) => b.days.includes(5) || b.days.includes(6));
  page('weekend/index.html', {
    title: `Weekend Happy Hours in Philadelphia | ${config.siteName}`,
    description: `Saturday and Sunday happy hours in Philly, from day-drinking patios to late-night deals.`,
    page: { type: 'list' },
    body: `<section class="hero hero-sm"><p class="eyebrow">Saturday & Sunday</p><h1>Weekend happy hours in Philly</h1>
  <p class="lede">Happy hour doesn't have to mean leaving work at 5. These deals run on Saturdays and Sundays.</p></section>
${filterBar({ when: 'any', hoods })}${listHTML('weekend/index.html', weekend)}`,
  });

  // Neighborhoods
  page('neighborhoods/index.html', {
    title: `Philadelphia Happy Hours by Neighborhood | ${config.siteName}`,
    description: `Find happy hours in ${hoods.slice(0, 5).map((h) => h.name).join(', ')} and every Philly neighborhood.`,
    page: { type: 'hoods' },
    body: `<section class="hero hero-sm"><p class="eyebrow">Neighborhoods</p><h1>Happy hours by neighborhood</h1>
  <p class="lede">From Rittenhouse after-work spots to South Philly corner bars.</p></section>
${hoodGrid('neighborhoods/index.html')}`,
  });
  for (const h of hoods) {
    const p = `neighborhoods/${h.slug}/index.html`;
    const items = pairs((v) => v.hoodSlug === h.slug);
    const others = h.venues.filter((v) => !v.blocks.length);
    page(p, {
      title: `${h.name} Happy Hours & Bars – ${h.count} ${h.count === 1 ? 'Spot' : 'Spots'}, Updated ${monthYear} | ${config.siteName}`,
      description: `Happy hour times and specials at ${h.name} bars and restaurants in Philadelphia${h.hhCount ? `, with deals at ${h.hhCount}` : ''}. ${h.count} bars listed.`,
      page: { type: 'hood', hood: h.slug },
      schema: { '@context': 'https://schema.org', '@type': 'ItemList', name: `${h.name} happy hours`, itemListElement: h.venues.map((v, i) => ({ '@type': 'ListItem', position: i + 1, url: canonical(`bar/${v.slug}/`), name: v.name })) },
      body: `<section class="hero hero-sm"><p class="eyebrow"><a href="${href(p, 'neighborhoods/')}">Neighborhoods</a> · ${esc(h.name)}</p><h1>${esc(h.name)} happy hours</h1></section>
${items.length ? filterBar({ when: 'any', showHood: false, hoods }) + listHTML(p, items, { hideHood: true }) : `<p class="lede">No happy hours listed in ${esc(h.name)} yet. Know one? Email <span class="sel">${esc(config.contactEmail)}</span>.</p>`}
${others.length ? `<h2 class="sec-h">${items.length ? 'More bars' : 'Bars'} in ${esc(h.name)}</h2><p class="muted small">Happy hour times for these are coming soon.</p>${dirList(p, others)}` : ''}`,
    });
  }

  // Venues
  for (const v of venues) {
    const p = `bar/${v.slug}/index.html`;
    const nearby = pairs((x) => x.hoodSlug === v.hoodSlug && x.slug !== v.slug).slice(0, 4);
    const map = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name} ${v.address} Philadelphia PA`)}`;
    const summary = v.blocks.map((b) => `${daysLabel(b.days)} ${rangeLabel(b.start, b.end)}`).join('; ');
    const hasHH = v.blocks.length > 0;
    const sameHood = hoodMap.get(v.hoodSlug).venues.filter((x) => x !== v && !x.blocks.length).slice(0, 8);
    page(p, {
      title: hasHH ? `${v.name} Happy Hour – Times & Specials | ${config.siteName}` : `${v.name}, ${v.hood} | ${config.siteName}`,
      description: hasHH ? `${v.name} happy hour in ${v.hood}: ${summary}. ${v.blocks[0].deals.slice(0, 3).join(', ')}.` : `${v.name} at ${v.address || v.hood}, Philadelphia. Happy hour times coming soon.`,
      page: { type: 'bar' },
      noindex: !hasHH,
      schema: {
        '@context': 'https://schema.org', '@type': 'BarOrPub', name: v.name, url: v.website || canonical(p),
        address: { '@type': 'PostalAddress', streetAddress: v.address, addressLocality: 'Philadelphia', addressRegion: 'PA', addressCountry: 'US' },
        ...(v.phone ? { telephone: v.phone } : {}),
        ...(isFinite(v.lat) ? { geo: { '@type': 'GeoCoordinates', latitude: v.lat, longitude: v.lng } } : {}),
        makesOffer: v.blocks.flatMap((b) => b.deals.map((d) => ({ '@type': 'Offer', name: d, description: `Happy hour ${daysLabel(b.days)} ${rangeLabel(b.start, b.end)}` }))),
      },
      body: `<section class="hero hero-sm venue-hero"><p class="eyebrow"><a href="${href(p, `neighborhoods/${v.hoodSlug}/`)}">${esc(v.hood)}</a>${v.vibe ? ' · ' + esc(v.vibe) : ''}</p>
  <h1>${esc(v.name)}</h1>
  <p class="venue-facts">${esc(v.address || '')}${v.phone ? ` · <span class="sel">${esc(v.phone)}</span>` : ''}${v.website ? ` · <a href="${esc(v.website)}" target="_blank" rel="noopener">Website</a>` : ''}${v.instagram ? ` · <a href="https://instagram.com/${esc(v.instagram.replace('@', ''))}" target="_blank" rel="noopener">${esc(v.instagram)}</a>` : ''}</p>
  <p class="venue-actions"><a class="btn" href="${map}" target="_blank" rel="noopener">Get directions</a>${v.sample ? '<span class="badge badge-sample">Sample listing</span>' : ''}${v.classic ? '<span class="badge badge-classic">215 Classic</span>' : ''}</p></section>
${hasHH ? `<h2 class="sec-h">Happy hour schedule</h2>
<div class="hh-list">${v.blocks.map((b) => card(v, b, p, { hideHood: true })).join('\n')}</div>
<p class="report">Something changed? Email <span class="sel">${esc(config.contactEmail)}</span> with the bar name and the new specials.${v.verified ? ` Last verified ${fmtDate(v.verified)}.` : ''}</p>` : `<div class="notice"><h2>Happy hour not listed yet</h2><p>We haven't confirmed ${esc(v.name)}'s happy hour. Work here or know the deals? Email <span class="sel">${esc(config.contactEmail)}</span> with the days, times and specials and we'll add them.</p></div>`}
${nearby.length ? `<h2 class="sec-h">Happy hours nearby in ${esc(v.hood)}</h2><div class="hh-list">${nearby.map(([x, b]) => card(x, b, p, { hideHood: true })).join('\n')}</div>` : ''}
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
    title: `About 215 Happy Hour – Philly's Happy Hour Source Since ${config.since}`,
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
  <p class="lede">Every bar gets a free listing. People use 215 Happy Hour to decide where to go in the next hour, so an accurate listing turns into foot traffic.</p></section>
<h2 class="sec-h">Add or update your listing</h2>
<p>Email <span class="sel" id="email">${esc(config.contactEmail)}</span> <button class="copy" type="button" data-copy="${esc(config.contactEmail)}">Copy</button> with:</p>
<ol class="plain-list"><li>Bar name, address and neighborhood</li><li>Days and times of each happy hour</li><li>The specials, with prices</li><li>Your website and Instagram</li></ol>
<p class="muted small">We confirm every listing before it goes live and show the date we last verified it.</p>
<h2 class="sec-h">Get featured</h2>
<div class="tiers">${tiers.map(([n, pr, f]) => `<div class="tier"><h3>${esc(n)}</h3><p class="price">${esc(pr)}</p><ul>${f.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}</div>
<p class="muted small">Every paid placement is labeled as sponsored. Ask about multi-location packages.</p>`,
  });

  // 404 (served at any path, so use root-absolute assets on the live site)
  if (!PREVIEW) {
    let nf = shell('404.html', { ...ctx, title: `Page not found | ${config.siteName}`, description: 'Page not found', page: { type: '404' },
      body: `<section class="hero hero-sm"><p class="eyebrow">404</p><h1>That page has been cut off.</h1><p class="lede">Last call came early for this link. Head back to <a href="/">today's happy hours</a> or pick a day.</p></section>` });
    nf = nf.replace(/(href|src)="(?!https?:|\/|#|mailto)([^"]*)"/g, (m, a, u) => `${a}="/${u.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '')}"`);
    write('404.html', nf);
  }

  // Assets
  fs.copyFileSync(path.join(ROOT, 'src', 'styles.css'), path.join(OUT, 'styles.css'));
  fs.copyFileSync(path.join(ROOT, 'src', 'app.js'), path.join(OUT, 'app.js'));
  fs.writeFileSync(path.join(OUT, 'favicon.svg'), LOGO.replace('class="mug" ', 'xmlns="http://www.w3.org/2000/svg" ').replace(/var\(--olive\)/g, '#4f6b34').replace(/var\(--cream\)/g, '#f3efcf'));
  if (!PREVIEW) {
    for (const f of fs.readdirSync(path.join(ROOT, 'static'))) fs.copyFileSync(path.join(ROOT, 'static', f), path.join(OUT, f));
    const today = BUILD_DATE.toISOString().slice(0, 10);
    fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${canonical(u)}</loc><lastmod>${today}</lastmod></url>`).join('\n')}\n</urlset>\n`);
    fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${config.siteUrl}/sitemap.xml\n`);
  }
  console.log(`Built ${urls.length} pages for ${venues.length} venues in ${hoods.length} neighborhoods -> ${path.relative(ROOT, OUT)}/`);
}

main();
