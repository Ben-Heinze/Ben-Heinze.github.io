// Per-page Learn mode. A "Learn" button (top-right of every page) opens a study
// overlay that quizzes you on that page's cards. The deck (/learn-index.json) is
// generated at publish time by wiki-build-learn-index in publish.el and loaded
// lazily on first use.
//
// Each card renders as one of three formats:
//   • flashcard — the heading is the prompt, reveal the body, self-grade;
//   • cloze     — the body with its /italic/ terms blanked out to fill in;
//   • mc        — the heading, pick the right body among sampled distractors.
// A card whose :LEARN_TYPE: pins a format always uses it; an "auto" card picks
// one deterministically from what its content supports.
//
// Progress is scheduled with SM-2 and stored in localStorage (key `learnState`),
// so missed cards resurface sooner and the review queue persists across visits.
// No backend — everything here runs in the browser, like search.js.
(function () {
  'use strict';

  var STATE_KEY = 'learnState';
  var NEW_PER_SESSION = 8;   // cap on unseen cards introduced per page per sitting

  // ── Deck loading ─────────────────────────────────────────────────────────
  var DECK = [];
  var deckPromise = null;
  function loadDeck() {
    if (deckPromise) return deckPromise;
    deckPromise = fetch('/learn-index.json')
      .then(function (r) { return r.json(); })
      .then(function (d) { DECK = Array.isArray(d) ? d : []; return DECK; })
      .catch(function () { DECK = []; return DECK; });
    return deckPromise;
  }

  // ── SM-2 review state (localStorage) ───────────────────────────────────────
  function loadState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveState(state) {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function addDays(iso, n) {
    var p = iso.split('-'), d = new Date(+p[0], +p[1] - 1, +p[2]);
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // Standard SM-2. `q` is recall quality 0–5 (mapped from the four grade buttons
  // or auto-graded on multiple choice). Returns the next state for the card.
  function schedule(prev, q) {
    var ef = prev ? prev.ef : 2.5;
    var interval = prev ? prev.interval : 0;
    var reps = prev ? prev.reps : 0;
    if (q < 3) { reps = 0; interval = 1; }
    else {
      reps += 1;
      interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(interval * ef);
    }
    ef = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    if (ef < 1.3) ef = 1.3;
    return { ef: ef, interval: interval, reps: reps,
             due: addDays(todayISO(), interval),
             attempts: (prev ? prev.attempts : 0) + 1 };
  }

  // Drop review state for cards no longer in the deck (e.g. a heading whose text
  // was edited, minting a fresh id and orphaning the old one).
  function pruneOrphans(state) {
    // Never prune against an empty deck — a failed fetch would wipe all history.
    if (!DECK.length) return;
    var live = {}, changed = false;
    DECK.forEach(function (c) { live[c.id] = 1; });
    Object.keys(state).forEach(function (id) {
      if (!live[id]) { delete state[id]; changed = true; }
    });
    if (changed) saveState(state);
  }

  // ── Deterministic helpers (no Math.random, so a card looks stable per view) ─
  function hashInt(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function makeRng(seed) {
    var s = seed >>> 0;
    return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }
  function shuffle(arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function firstClause(text, max) {
    var t = (text || '').trim();
    var m = t.match(/^[\s\S]*?[.!?](\s|$)/);
    var s = m ? m[0].trim() : t;
    if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, '').trim() + '…';
    return s;
  }

  // ── Card format selection ──────────────────────────────────────────────────
  function siteBacks(card) {
    return DECK.filter(function (c) { return c.id !== card.id && c.back; });
  }
  function resolveFormat(card, seed) {
    if (card.type && card.type !== 'auto') return card.type;
    var eligible = ['flashcard'];
    if (card.clozeTerms && card.clozeTerms.length) eligible.push('cloze');
    if (siteBacks(card).length >= 2) eligible.push('mc');
    return eligible[hashInt(card.id + ':' + seed) % eligible.length];
  }

  // Prefer same-page answers as distractors; fall back site-wide if too few.
  function pickDistractors(card, n, rng) {
    var same = DECK.filter(function (c) {
      return c.id !== card.id && c.pageHref === card.pageHref && c.back;
    });
    var pool = same.length >= n ? same : siteBacks(card);
    return shuffle(pool, rng).slice(0, n).map(function (c) { return firstClause(c.back, 90); });
  }

  // ── Small DOM utilities ────────────────────────────────────────────────────
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function txt(tag, cls, text) { var e = el(tag, cls); e.textContent = text; return e; }

  // Re-typeset any math in a freshly built card, if MathJax is on the page.
  function typeset(node) {
    try {
      if (window.MathJax && window.MathJax.typesetPromise) window.MathJax.typesetPromise([node]);
    } catch (e) {}
  }

  function normalize(s) { return (s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

  // Which page are we on? Match the pageHref stored in the deck.
  function currentPath() {
    var p = location.pathname;
    if (p.charAt(p.length - 1) === '/') p += 'index.html';
    return p;
  }

  // ── Grade buttons (Again / Hard / Good / Easy → SM-2 quality) ──────────────
  var GRADES = [
    { label: 'Again', q: 1 },
    { label: 'Hard',  q: 3 },
    { label: 'Good',  q: 4 },
    { label: 'Easy',  q: 5 }
  ];
  function gradeBar(onGrade, suggestQ) {
    var bar = el('div', 'learn-grade-btns');
    GRADES.forEach(function (g) {
      var b = txt('button', 'learn-grade', g.label);
      b.type = 'button';
      if (suggestQ === g.q) b.classList.add('is-suggested');
      b.addEventListener('click', function () { onGrade(g.q); });
      bar.appendChild(b);
    });
    return bar;
  }

  // ── Session controller ─────────────────────────────────────────────────────
  function Session(cards, state, onDone) {
    this.cards = cards;      // the queue for this sitting
    this.state = state;
    this.onDone = onDone;
    this.pos = 0;
    this.reviewed = 0;
  }

  Session.prototype.grade = function (card, q) {
    this.state[card.id] = schedule(this.state[card.id], q);
    saveState(this.state);   // persist after every single grade
    this.reviewed += 1;
    this.pos += 1;
    this.render();
  };

  // Returns { header, body } DOM for the current position.
  Session.prototype.render = function () {
    if (this.pos >= this.cards.length) { this.onDone(this.reviewed); return; }
    var card = this.cards[this.pos];
    var seed = this.state[card.id] ? (this.state[card.id].attempts || 0) : 0;
    var format = resolveFormat(card, seed);
    var self = this;
    var body = el('div', 'learn-card');
    body.appendChild(txt('div', 'learn-crumb', card.heading));

    if (format === 'mc') this.renderMC(card, body, seed);
    else if (format === 'cloze') this.renderCloze(card, body);
    else this.renderFlashcard(card, body);

    this.mount(card, body);
  };

  Session.prototype.renderFlashcard = function (card, body) {
    var self = this;
    body.appendChild(txt('div', 'learn-front', card.front));
    var reveal = txt('button', 'learn-primary', 'Show answer');
    reveal.type = 'button';
    body.appendChild(reveal);
    reveal.addEventListener('click', function () {
      reveal.remove();
      var back = txt('div', 'learn-back', card.back);
      body.appendChild(back);
      body.appendChild(gradeBar(function (q) { self.grade(card, q); }));
      typeset(back);
    });
  };

  Session.prototype.renderCloze = function (card, body) {
    var self = this;
    body.appendChild(txt('div', 'learn-hint', 'Fill in the blanks'));
    var cloze = el('div', 'learn-cloze');
    var inputs = [];
    card.clozeText.split(/(\{\{c\d+\}\})/g).forEach(function (part) {
      var m = part.match(/^\{\{c(\d+)\}\}$/);
      if (m) {
        var inp = el('input', 'learn-cloze-input');
        inp.type = 'text';
        inp.autocomplete = 'off'; inp.spellcheck = false;
        inp.setAttribute('aria-label', 'Blank ' + m[1]);
        inputs[+m[1] - 1] = inp;
        cloze.appendChild(inp);
      } else if (part) {
        cloze.appendChild(document.createTextNode(part));
      }
    });
    body.appendChild(cloze);
    typeset(cloze);

    var check = txt('button', 'learn-primary', 'Check');
    check.type = 'button';
    body.appendChild(check);
    check.addEventListener('click', function () {
      check.remove();
      var allRight = true;
      card.clozeTerms.forEach(function (term, i) {
        var inp = inputs[i];
        if (!inp) return;
        var ok = normalize(inp.value) === normalize(term);
        if (!ok) allRight = false;
        inp.classList.add(ok ? 'is-correct' : 'is-wrong');
        inp.readOnly = true;
        if (!ok) {
          var ans = txt('span', 'learn-cloze-answer', term);
          if (inp.nextSibling) inp.parentNode.insertBefore(ans, inp.nextSibling);
          else inp.parentNode.appendChild(ans);
        }
      });
      body.appendChild(gradeBar(function (q) { self.grade(card, q); }, allRight ? 4 : 1));
    });
    // Enter in the last field triggers the check.
    inputs.forEach(function (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && check.parentNode) { e.preventDefault(); check.click(); }
      });
    });
    if (inputs[0]) setTimeout(function () { inputs[0].focus(); }, 0);
  };

  Session.prototype.renderMC = function (card, body, seed) {
    var self = this;
    var rng = makeRng(hashInt(card.id) ^ (seed + 1));
    body.appendChild(txt('div', 'learn-front', card.front));
    var correct = firstClause(card.back, 90);
    var options = shuffle([correct].concat(pickDistractors(card, 3, rng)), rng);
    var list = el('div', 'learn-mc');
    options.forEach(function (opt) {
      var b = txt('button', 'learn-mc-option', opt);
      b.type = 'button';
      b.addEventListener('click', function () {
        if (list.classList.contains('is-answered')) return;
        list.classList.add('is-answered');
        var right = opt === correct;
        b.classList.add(right ? 'is-correct' : 'is-wrong');
        if (!right) {
          // Reveal which one was right.
          list.querySelectorAll('.learn-mc-option').forEach(function (o) {
            if (o.textContent === correct) o.classList.add('is-correct');
          });
        }
        var next = txt('button', 'learn-primary', 'Next');
        next.type = 'button';
        next.addEventListener('click', function () { self.grade(card, right ? 4 : 1); });
        body.appendChild(next);
      });
      list.appendChild(b);
    });
    body.appendChild(list);
    typeset(list);
  };

  // ── Overlay shell ──────────────────────────────────────────────────────────
  var overlay = null;
  function ensureOverlay() {
    if (overlay) return overlay;
    var backdrop = el('div', 'learn-backdrop');
    backdrop.hidden = true;
    var modal = el('div', 'learn-modal');
    var header = el('div', 'learn-header');
    var title = txt('div', 'learn-title', 'Learn');
    var progress = txt('div', 'learn-progress', '');
    var close = txt('button', 'learn-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    header.appendChild(title);
    header.appendChild(progress);
    header.appendChild(close);
    var content = el('div', 'learn-content');
    modal.appendChild(header);
    modal.appendChild(content);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    close.addEventListener('click', closeOverlay);
    backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) closeOverlay(); });

    overlay = { backdrop: backdrop, title: title, progress: progress, content: content };
    return overlay;
  }

  function note(cls, text) {
    var wrap = el('div', 'learn-card');
    wrap.appendChild(txt('div', cls, text));
    return wrap;
  }

  function openOverlay() {
    loadDeck().then(function () {
      var o = ensureOverlay();
      var state = loadState();
      pruneOrphans(state);

      var path = currentPath();
      var cards = DECK.filter(function (c) { return c.pageHref === path; });
      o.backdrop.hidden = false;
      document.body.classList.add('learn-open');
      o.title.textContent = cards.length && cards[0].page ? cards[0].page : 'Learn';
      o.content.innerHTML = '';
      o.progress.textContent = '';

      if (!cards.length) {
        o.content.appendChild(note('learn-empty', 'No study cards on this page yet.'));
        return;
      }

      // Queue: everything due today (oldest first) + a few new cards.
      var due = [], fresh = [], today = todayISO();
      cards.forEach(function (c) {
        var st = state[c.id];
        if (!st) fresh.push(c);
        else if (st.due <= today) due.push(c);
      });
      due.sort(function (a, b) {
        var da = state[a.id].due, db = state[b.id].due;
        return da < db ? -1 : da > db ? 1 : 0;
      });
      var queue = due.concat(fresh.slice(0, NEW_PER_SESSION));

      if (!queue.length) {
        o.content.appendChild(note('learn-empty',
          'You’re all caught up on this page — come back later.'));
        return;
      }

      var session = new Session(queue, state, function (n) {
        o.progress.textContent = '';
        o.content.innerHTML = '';
        o.content.appendChild(note('learn-empty',
          'Done — reviewed ' + n + (n === 1 ? ' card.' : ' cards.')));
      });
      // Give the session a way to draw itself into the shell.
      session.mount = function (card, cardBody) {
        o.progress.textContent = (session.pos + 1) + ' / ' + queue.length;
        o.content.innerHTML = '';
        o.content.appendChild(cardBody);
      };
      session.render();
    });
  }

  function closeOverlay() {
    if (overlay) { overlay.backdrop.hidden = true; document.body.classList.remove('learn-open'); }
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay && !overlay.backdrop.hidden) closeOverlay();
  });

  // ── Learn button (fixed, top-right of every page) ──────────────────────────
  // Appended to <body> rather than a positioned ancestor, so position:fixed is
  // relative to the viewport (same reason new-page.js appends the nav button).
  function addButton() {
    var btn = el('button', 'learn-btn');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open Learn mode');
    btn.innerHTML = '<span class="learn-btn-icon" aria-hidden="true">◉</span>' +
                    '<span class="learn-btn-label">Learn</span>';
    btn.addEventListener('click', function () {
      if (overlay && !overlay.backdrop.hidden) closeOverlay(); else openOverlay();
    });
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addButton);
  } else {
    addButton();
  }
}());
