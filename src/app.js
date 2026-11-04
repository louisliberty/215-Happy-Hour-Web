/* 215 Happy Hour: live status, filters and sorting. No dependencies. */
(function () {
  'use strict';
  var cfgEl = document.getElementById('hh-config');
  var cfg = cfgEl ? JSON.parse(cfgEl.textContent) : { tz: 'America/New_York', page: {} };
  var DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var SHORT = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

  function nowPhilly() {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: cfg.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    var o = {};
    parts.forEach(function (p) { o[p.type] = p.value; });
    var h = parseInt(o.hour, 10) % 24, m = parseInt(o.minute, 10);
    return { day: SHORT[o.weekday], min: h * 60 + m };
  }
  function clock(min) {
    var h = Math.floor(min / 60), m = min % 60, h12 = ((h + 11) % 12) + 1;
    return h12 + (m ? ':' + String(m).padStart(2, '0') : '') + (h < 12 ? ' am' : ' pm');
  }
  function span(mins) {
    if (mins < 60) return mins + 'm';
    var h = Math.floor(mins / 60), m = mins % 60;
    return h + 'h' + (m ? ' ' + m + 'm' : '');
  }

  var main = document.getElementById('main');
  var cards = main ? Array.prototype.slice.call(main.querySelectorAll('.hh')) : [];
  var list = main ? main.querySelector('.hh-list') : null;
  var original = cards.slice();
  cards.forEach(function (c) {
    c._days = c.dataset.days.split(',').map(Number);
    c._start = +c.dataset.start; c._end = +c.dataset.end;
    c._tags = (c.dataset.tags || '').split(',');
  });

  var form = document.querySelector('.filters');
  var fWhen = document.getElementById('f-when');
  var fHood = document.getElementById('f-hood');
  var fQ = document.getElementById('f-q');
  var results = document.getElementById('results');
  var empty = document.getElementById('empty');
  var defaultWhen = form ? form.dataset.defaultWhen : 'any';

  try {
    var saved = localStorage.getItem('hh-hood');
    if (fHood && saved && fHood.querySelector('option[value="' + saved + '"]')) fHood.value = saved;
  } catch (e) { /* storage unavailable */ }
  if (fWhen) fWhen.value = defaultWhen;
  try {
    var qs = new URLSearchParams(location.search).get('q');
    if (fQ && qs) { fQ.value = qs; if (fWhen) fWhen.value = 'any'; }
  } catch (e) { /* old browser */ }

  function tick() {
    var now = nowPhilly();
    var live = 0, today = 0;

    document.querySelectorAll('.daynav a[data-day]').forEach(function (a) {
      a.classList.toggle('is-today', +a.dataset.day === now.day);
    });

    cards.forEach(function (c) {
      var s = c.querySelector('.hh-status');
      c.classList.remove('is-live', 'is-ended', 'is-soon');
      c._rank = 3; c._key = c._start;
      if (c._days.indexOf(now.day) === -1) { s.textContent = ''; return; }
      today++;
      if (typeof cfg.page.day === 'number' && cfg.page.day !== now.day) { s.textContent = ''; return; }
      if (now.min >= c._start && now.min < c._end) {
        live++; c.classList.add('is-live'); c._rank = 0; c._key = c._end - now.min;
        s.textContent = 'Live · ' + span(c._end - now.min) + ' left';
      } else if (now.min < c._start) {
        c._rank = 1; c._key = c._start;
        var wait = c._start - now.min;
        s.textContent = wait <= 90 ? 'Starts in ' + span(wait) : 'Today ' + clock(c._start);
      } else {
        c._rank = 2; c.classList.add('is-ended'); s.textContent = 'Ended today';
      }
    });

    var clockEl = document.getElementById('clock');
    if (clockEl) clockEl.textContent = DAYS[now.day] + ' · ' + clock(now.min) + ' in Philly';
    var countEl = document.getElementById('live-count');
    var labelEl = document.getElementById('live-label');
    if (countEl && labelEl) {
      if (live) {
        countEl.textContent = live; countEl.classList.add('is-live');
        labelEl.textContent = live === 1 ? 'happy hour pouring right now' : 'happy hours pouring right now';
      } else {
        countEl.textContent = today; countEl.classList.remove('is-live');
        labelEl.textContent = today === 1 ? 'happy hour on today' : 'happy hours on today';
      }
    }
    apply(now);
  }

  function apply(now) {
    now = now || nowPhilly();
    var when = fWhen ? fWhen.value : defaultWhen;
    var hood = fHood ? fHood.value : '';
    var q = fQ ? fQ.value.trim().toLowerCase() : '';
    var types = form ? Array.prototype.map.call(form.querySelectorAll('input[name="type"]:checked'), function (i) { return i.value; }) : [];
    var day = when === 'today' || when === 'now' ? now.day : when === 'any' ? -1 : +when;
    var shown = 0;

    cards.forEach(function (c) {
      var ok = true;
      if (when === 'now') ok = c.classList.contains('is-live');
      else if (day >= 0) ok = c._days.indexOf(day) !== -1;
      if (ok && hood) ok = c.dataset.hood === hood;
      if (ok && q) ok = c.dataset.name.indexOf(q) !== -1;
      if (ok && types.length) ok = types.every(function (t) { return c._tags.indexOf(t) !== -1; });
      c.hidden = !ok;
      if (ok) shown++;
    });

    if (list) {
      var order = day === now.day
        ? cards.slice().sort(function (a, b) { return a._rank - b._rank || a._key - b._key; })
        : original;
      order.forEach(function (c) { list.appendChild(c); });
    }
    if (empty) empty.hidden = shown !== 0;
    if (results && form) {
      var label = shown === 1 ? ' happy hour' : ' happy hours';
      var where = when === 'now' ? ' live right now' : day === now.day ? ' today' : day >= 0 ? ' on ' + DAYS[day] : '';
      results.textContent = shown + label + where;
    }
  }

  if (form) {
    form.addEventListener('input', function () { apply(); });
    form.addEventListener('change', function (e) {
      if (e.target === fHood) { try { localStorage.setItem('hh-hood', fHood.value); } catch (err) { /* ignore */ } }
      apply();
    });
  }

  document.querySelectorAll('.copy[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var text = b.dataset.copy;
      var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1800); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { selectEmail(); });
      } else selectEmail();
      function selectEmail() {
        var el = document.getElementById('email');
        if (!el) return;
        var r = document.createRange(); r.selectNodeContents(el);
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      }
    });
  });

  tick();
  setInterval(tick, 60000);
})();
