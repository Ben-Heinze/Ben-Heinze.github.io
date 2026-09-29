// Site-wide search. Two entry points share one engine and one panel widget:
//   • a global Ctrl/Cmd-K overlay, available on every page, and
//   • the /search/ page, which mounts the same panel into #search-app.
// The index (/search-index.json) is generated at publish time by
// wiki-build-search-index in publish.el and loaded lazily on first use.
//
// Results are one ranked list in two tiers:
//   1. "Pages & sections" — matches on page titles / section headings.
//   2. "In-page matches"  — fuzzy matches in body text, shown as snippets.
// Selecting a result navigates to its href (page URL, or page URL + #section).
//
// A query may also carry `tag:<name>` tokens, which restrict results to pages
// carrying every named tag (see /tags/). `tag:week-5` on its own lists that
// tag's pages; combined with text it narrows the normal search.
(function () {
  'use strict';

  // ── Index loading ──────────────────────────────────────────────────────
  // Two manifests. search-index.json is the text index, built from the
  // published HTML. tag-index.json is the tag data, built from the .org
  // sources — a separate file rather than a `tags` field on every search
  // record because it is the single source of truth the /tags/ page also
  // reads, and because it covers every page: the text index only walks
  // index.html, so the ~40 standalone snippet pages have no record in it at
  // all and would otherwise be invisible to `tag:`.
  var INDEX = [];
  var PAGE_TAGS = {};   // page href (no #fragment) -> tag list
  var TAG_PAGES = [];   // [{ page, href, tags }] for every tagged page
  var indexPromise = null;
  function loadIndex() {
    if (indexPromise) return indexPromise;
    var text = fetch('/search-index.json')
      .then(function (r) { return r.json(); })
      .then(function (d) { INDEX = Array.isArray(d) ? d : []; })
      .catch(function () { INDEX = []; });
    var tags = fetch('/tag-index.json')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        TAG_PAGES = (d && Array.isArray(d.pages)) ? d.pages : [];
        PAGE_TAGS = {};
        TAG_PAGES.forEach(function (p) { PAGE_TAGS[p.href] = p.tags || []; });
      })
      .catch(function () { TAG_PAGES = []; PAGE_TAGS = {}; });
    indexPromise = Promise.all([text, tags]).then(function () { return INDEX; });
    return indexPromise;
  }

  function pageHref(rec) { return (rec.href || '').split('#')[0]; }
  function tagsOf(rec) { return PAGE_TAGS[pageHref(rec)] || []; }

  // ── Tag tokens ─────────────────────────────────────────────────────────
  // Pull `tag:foo` out of the raw query, leaving the free-text remainder.
  // Tags are normalized the same way publish.el and serve.py normalize them
  // (lowercase, non-alphanumerics to hyphens) so `tag:Week 5` can't be typed —
  // but `tag:WEEK-5` still works.
  function parseQuery(query) {
    var tags = [], words = [];
    (query || '').split(/\s+/).forEach(function (tok) {
      if (!tok) return;
      var m = /^tag:(.*)$/i.exec(tok);
      if (m) {
        var t = m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        if (t) tags.push(t);
      } else {
        words.push(tok);
      }
    });
    return { tags: tags, text: words.join(' ') };
  }

  function hasEveryTag(rec, tags) {
    var own = tagsOf(rec);
    for (var i = 0; i < tags.length; i++) {
      if (own.indexOf(tags[i]) === -1) return false;
    }
    return true;
  }

  // ── Matching ───────────────────────────────────────────────────────────
  // Returns { score, ranges } for a single needle against text, or null.
  // `ranges` are [start,end) pairs into `text` for highlighting.
  //
  // `fuzzy` controls the subsequence fallback. It's ON for headings/titles —
  // short strings where typo tolerance ("linreg" → "Linear Regression") helps
  // and false positives are bounded — and OFF for body text, where a literal
  // substring is the right meaning of "an instance of the topic" and character
  // subsequences scattered across a paragraph would be near-random noise.
  function matchOne(needle, text, fuzzy) {
    var q = needle.toLowerCase();
    var t = text.toLowerCase();
    if (!q) return null;

    var idx = t.indexOf(q);
    if (idx !== -1) {
      var atBoundary = idx === 0 || /[^a-z0-9]/.test(t.charAt(idx - 1));
      return { score: 1000 - Math.min(idx, 500) + (atBoundary ? 250 : 0),
               ranges: [[idx, idx + q.length]] };
    }
    if (!fuzzy) return null;

    // Subsequence fallback: every char of q in order, rewarding contiguity
    // and word-boundary starts. Reject pathologically spread matches so a
    // needle smeared across the whole string doesn't count.
    var ti = 0, prev = -2, first = -1, score = 0, ranges = [];
    for (var qi = 0; qi < q.length; qi++) {
      var ch = q.charAt(qi);
      var found = t.indexOf(ch, ti);
      if (found === -1) return null;
      if (first === -1) first = found;
      var boundary = found === 0 || /[^a-z0-9]/.test(t.charAt(found - 1));
      if (boundary) score += 15;
      if (found === prev + 1) {
        score += 20;
        ranges[ranges.length - 1][1] = found + 1; // extend contiguous run
      } else {
        score += 1;
        ranges.push([found, found + 1]);
      }
      prev = found;
      ti = found + 1;
    }
    if (prev - first + 1 > q.length * 6) return null; // too spread out to be real
    score -= (t.length - q.length) * 0.02; // prefer tighter matches
    return { score: score, ranges: ranges };
  }

  // Every whitespace-separated term must match (AND). Scores sum; ranges merge.
  function scoreText(query, text, fuzzy) {
    if (!text) return null;
    var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return null;
    var total = 0, all = [];
    for (var i = 0; i < terms.length; i++) {
      var m = matchOne(terms[i], text, fuzzy);
      if (!m) return null;
      total += m.score;
      all = all.concat(m.ranges);
    }
    return { score: total, ranges: mergeRanges(all) };
  }

  function mergeRanges(ranges) {
    if (ranges.length < 2) return ranges;
    ranges = ranges.slice().sort(function (a, b) { return a[0] - b[0]; });
    var out = [ranges[0].slice()];
    for (var i = 1; i < ranges.length; i++) {
      var last = out[out.length - 1], r = ranges[i];
      if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else out.push(r.slice());
    }
    return out;
  }

  // ── Query → ranked results ─────────────────────────────────────────────
  function runSearch(query) {
    var q = parseQuery(query);
    var t1 = [], t2 = [];

    // Tags with no text to match: list the tagged pages themselves. Needed as
    // its own branch because scoreText returns null for an empty term list, so
    // falling through would report "no results" for a tag that clearly has some.
    // Built straight from the tag manifest rather than from search records, so
    // it covers every tagged page and lists each one once instead of once per
    // section heading.
    if (q.tags.length && !q.text) {
      TAG_PAGES.forEach(function (p) {
        var own = p.tags || [];
        for (var i = 0; i < q.tags.length; i++) {
          if (own.indexOf(q.tags[i]) === -1) return;
        }
        t1.push({ rec: { type: 'title', page: p.page, heading: p.page, href: p.href },
                  score: 0, ranges: [] });
      });
      t1.sort(function (a, b) {
        return a.rec.heading < b.rec.heading ? -1 : a.rec.heading > b.rec.heading ? 1 : 0;
      });
      return {
        t1: t1.slice(0, 60), t2: [],
        label: 'Tagged ' + q.tags.map(function (t) { return '“' + t + '”'; }).join(' + ')
      };
    }

    for (var i = 0; i < INDEX.length; i++) {
      var rec = INDEX[i];
      if (q.tags.length && !hasEveryTag(rec, q.tags)) continue;
      var hm = scoreText(q.text, rec.heading, true); // headings: fuzzy allowed
      if (hm) {
        var boost = rec.type === 'title' ? 60 : 0; // pages edge out their sections
        t1.push({ rec: rec, score: hm.score + boost, ranges: hm.ranges });
        continue;
      }
      var bm = scoreText(q.text, rec.body, false);  // body: literal substrings only
      if (bm) t2.push({ rec: rec, score: bm.score, snippet: buildSnippet(rec.body, bm.ranges) });
    }
    var byScore = function (a, b) { return b.score - a.score; };
    t1.sort(byScore); t2.sort(byScore);
    return { t1: t1.slice(0, 40), t2: t2.slice(0, 40) };
  }

  // ── Highlighting ───────────────────────────────────────────────────────
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Wrap the matched ranges of `text` in <mark>, escaping the rest.
  function highlight(text, ranges) {
    if (!ranges || !ranges.length) return escapeHtml(text);
    var out = '', pos = 0;
    for (var i = 0; i < ranges.length; i++) {
      var a = ranges[i][0], b = ranges[i][1];
      if (a > pos) out += escapeHtml(text.slice(pos, a));
      out += '<mark>' + escapeHtml(text.slice(a, b)) + '</mark>';
      pos = b;
    }
    if (pos < text.length) out += escapeHtml(text.slice(pos));
    return out;
  }

  // A ~160-char window of body text centered near the first match.
  function buildSnippet(text, ranges) {
    var radius = 160;
    var first = ranges.length ? ranges[0][0] : 0;
    var start = Math.max(0, first - 50);
    var end = Math.min(text.length, start + radius);
    var out = start > 0 ? '…' : '', pos = start;
    for (var i = 0; i < ranges.length; i++) {
      var a = Math.max(ranges[i][0], start), b = Math.min(ranges[i][1], end);
      if (b <= start || a >= end) continue;
      if (a > pos) out += escapeHtml(text.slice(pos, a));
      out += '<mark>' + escapeHtml(text.slice(a, b)) + '</mark>';
      pos = b;
    }
    if (pos < end) out += escapeHtml(text.slice(pos, end));
    if (end < text.length) out += '…';
    return out;
  }

  // ── Panel widget (shared by overlay and /search/ page) ─────────────────
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  function makePanel() {
    var panel = el('div', 'search-panel');
    var input = el('input', 'search-input');
    input.type = 'search';
    input.placeholder = 'Search the wiki…';
    input.setAttribute('aria-label', 'Search the wiki');
    input.autocomplete = 'off'; input.spellcheck = false;
    var results = el('div', 'search-results');
    results.setAttribute('role', 'listbox');
    panel.appendChild(input);
    panel.appendChild(results);

    var flat = [];    // rec list in display order, for keyboard nav
    var active = -1;

    function go(rec) { if (rec) window.location.href = rec.href; }

    function setActive(i) {
      var nodes = results.querySelectorAll('.search-result');
      if (!nodes.length) { active = -1; return; }
      active = (i % nodes.length + nodes.length) % nodes.length;
      for (var k = 0; k < nodes.length; k++) nodes[k].classList.toggle('is-active', k === active);
      nodes[active].scrollIntoView({ block: 'nearest' });
    }

    function resultNode(item, isBody, pos) {
      var a = el('a', 'search-result');
      a.setAttribute('role', 'option');
      a.href = item.rec.href;
      var crumb = el('div', 'search-crumb');
      crumb.textContent = item.rec.type === 'title' ? 'Page' : item.rec.page;
      var title = el('div', 'search-result-title');
      if (isBody) title.textContent = item.rec.heading;
      else title.innerHTML = highlight(item.rec.heading, item.ranges);
      a.appendChild(crumb);
      a.appendChild(title);
      if (isBody && item.snippet) {
        var snip = el('div', 'search-snippet');
        snip.innerHTML = item.snippet;
        a.appendChild(snip);
      }
      a.addEventListener('mousemove', function () { setActive(pos); });
      return a;
    }

    function note(cls, text) { var d = el('div', cls); d.textContent = text; return d; }

    function render(value) {
      var q = (value || '').trim();
      results.innerHTML = '';
      flat = []; active = -1;
      if (!q) {
        results.appendChild(note('search-note',
          'Type to search titles, sections, and page text. Use tag:name to filter by tag.'));
        return;
      }
      // Mid-typing "tag:" with nothing after it: say so instead of flashing
      // "No results", which is what an empty query would otherwise produce.
      var parsed = parseQuery(q);
      if (!parsed.tags.length && !parsed.text) {
        results.appendChild(note('search-note', 'Finish the tag name, or see all tags on the Tags page.'));
        return;
      }
      var res = runSearch(q);
      if (!res.t1.length && !res.t2.length) {
        results.appendChild(note('search-note', 'No results for “' + q + '”.'));
        return;
      }
      var pos = 0;
      if (res.t1.length) {
        results.appendChild(note('search-group-label', res.label || 'Pages & sections'));
        res.t1.forEach(function (item) { results.appendChild(resultNode(item, false, pos++)); flat.push(item.rec); });
      }
      if (res.t2.length) {
        results.appendChild(note('search-group-label', 'In-page matches'));
        res.t2.forEach(function (item) { results.appendChild(resultNode(item, true, pos++)); flat.push(item.rec); });
      }
      setActive(0);
    }

    input.addEventListener('input', function () { render(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); go(flat[active]); }
    });

    return { panel: panel, input: input, render: render };
  }

  // ── Ctrl/Cmd-K overlay ─────────────────────────────────────────────────
  var overlay = null;
  function ensureOverlay() {
    if (overlay) return overlay;
    var backdrop = el('div', 'search-backdrop');
    backdrop.hidden = true;
    var modal = el('div', 'search-modal');
    var ctrl = makePanel();
    modal.appendChild(ctrl.panel);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) closeOverlay(); });
    overlay = { backdrop: backdrop, ctrl: ctrl };
    return overlay;
  }
  function openOverlay() {
    loadIndex().then(function () {
      var o = ensureOverlay();
      o.backdrop.hidden = false;
      document.body.classList.add('search-open');
      o.ctrl.input.value = '';
      o.ctrl.render('');
      o.ctrl.input.focus();
    });
  }
  function closeOverlay() {
    if (overlay) { overlay.backdrop.hidden = true; document.body.classList.remove('search-open'); }
  }

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (overlay && !overlay.backdrop.hidden) closeOverlay(); else openOverlay();
    } else if (e.key === 'Escape' && overlay && !overlay.backdrop.hidden) {
      closeOverlay();
    }
  });

  // ── /search/ page in-line mount ────────────────────────────────────────
  var app = document.getElementById('search-app');
  if (app) {
    loadIndex().then(function () {
      var ctrl = makePanel();
      ctrl.panel.classList.add('search-panel-page');
      app.appendChild(ctrl.panel);
      ctrl.render('');
      ctrl.input.focus();
    });
  }
}());
