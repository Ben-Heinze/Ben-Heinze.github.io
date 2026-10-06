// Generic interactive quiz. Any page with a [data-quiz-test] element becomes a
// gradeable, repeatable test built from the question bank in /quiz-index.json
// (generated at publish time by wiki-build-quiz-index in publish.el).
//
// Authoring lives in Org (see publish.el's Quiz-index section): a source page
// declares `#+QUIZ: t` and writes each question as a heading with a :Q_TYPE:
// property drawer. A consumer page declares `#+QUIZ_TEST: <filter>` (all, or a
// comma-list of :Q_UNIT: tags) and publish.el injects the mount div here.
//
// Question types: mc (multiple choice), tf (true/false), fill (text, matched
// against :Q_ANSWER:/:Q_ACCEPT:), short (self-assessed against a model answer),
// and calc (randomized numeric: the :Q_GEN: name selects a generator below, so
// every "New test" produces fresh numbers with worked steps).
//
// No backend: everything runs in the browser, like search.js and learn.js.
(function () {
  'use strict';

  var UNIT_LABEL = {
    // Operating Systems
    ov: 'Overview', mem: 'Memory', proc: 'Process',
    // Machine Learning midterm
    found: 'Foundations', linreg: 'Linear Regression', nonpar: 'Nonparametric',
    eval: 'Experiments', dimred: 'Dim. Reduction', clust: 'Clustering',
    theory: 'Learning Theory', trees: 'Trees', logic: 'Logic & Rules',
    proj1: 'Project 1 (k-NN)', proj2: 'Project 2 (Trees)'
  };

  // ── tiny helpers ────────────────────────────────────────────────────────────
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function randint(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
  function round(x, d) { var m = Math.pow(10, d); return Math.round(x * m) / m; }
  function lg(x) { return Math.log(x) / Math.LN2; }
  // Binary entropy over p positives and n negatives, with Quinlan's 0*lg(0) = 0.
  function hpn(p, n) {
    var t = p + n; if (!t) return 0;
    var a = p / t, b = n / t;
    return (a ? -a * lg(a) : 0) + (b ? -b * lg(b) : 0);
  }
  // Gaussian/RBF kernel K(u) = (1/sqrt(2*pi)) exp(-u^2 / 2).
  function gauss(u) { return Math.exp(-u * u / 2) / Math.sqrt(2 * Math.PI); }
  function vec(a) { return '[' + a.join(', ') + ']'; }

  // Org collapses every run of whitespace in a property value, so pseudocode
  // authored in :Q_STEPS: arrives flat. The convention is to mark depth with
  // leading "." tokens ("`. . foo`" is two levels deep); restore real
  // indentation from them so the monospace block reads as a nested block.
  function undot(line) {
    var depth = 0;
    while (line.charAt(0) === '.' && (line.charAt(1) === ' ' || line.length === 1)) {
      depth++; line = line.slice(2);
    }
    return new Array(depth * 3 + 1).join(' ') + line;
  }

  // Symbol-glossary answers are authored as `TERM :: MEANING' lines. Pad the
  // terms to a common width so they land in a column -- the two-column table the
  // notes use for an equation's symbols, rebuilt inside the monospace block.
  // (Authored spacing can't do this: Org collapses runs of whitespace.)
  function formatSteps(lines) {
    var rows = lines.map(undot), widest = 0, i, at;
    for (i = 0; i < rows.length; i++) {
      at = rows[i].indexOf(' :: ');
      if (at > widest) widest = at;
    }
    if (widest <= 0) return rows.join('\n');
    for (i = 0; i < rows.length; i++) {
      at = rows[i].indexOf(' :: ');
      if (at < 0) continue;
      rows[i] = rows[i].slice(0, at) +
                new Array(widest - at + 1).join(' ') + '   ' +
                rows[i].slice(at + 4);
    }
    return rows.join('\n');
  }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  // Questions may carry LaTeX (\( ... \)) -- wiki-node-text in publish.el keeps
  // latex-fragment values intact on the way into quiz-index.json. But we inject
  // them long after MathJax typeset the page, so re-run it over what we drew.
  // Same shape as the mermaid retypeset in publish.el: wait on MathJax's own
  // startup promise first so this can't race its async bootstrap.
  function typeset(node) {
    var MJ = window.MathJax;
    if (!node || !MJ || !MJ.typesetPromise) return;
    var ready = (MJ.startup && MJ.startup.promise) ? MJ.startup.promise : Promise.resolve();
    ready.then(function () { return MJ.typesetPromise([node]); }).catch(function () {});
  }
  function unitLabel(u) { return UNIT_LABEL[u] || (u ? u.toUpperCase() : ''); }

  // ── question ratings ────────────────────────────────────────────────────────
  // A pass for critiquing the bank itself: mark each question good or bad and
  // attach a note. Saved through the dev server (serve.py) into
  // question-ratings.json at the repo root, so verdicts survive a rebuild and
  // can be read back outside the browser. localStorage is the fallback when the
  // page is served from somewhere without that endpoint.
  var RATINGS = {};
  var RATINGS_LS = 'questionRatings';

  function loadRatings() {
    try {
      var local = JSON.parse(localStorage.getItem(RATINGS_LS) || '{}');
      Object.keys(local).forEach(function (k) { RATINGS[k] = local[k]; });
    } catch (e) {}
    return fetch('/api/ratings').then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (server) {
        Object.keys(server).forEach(function (k) { RATINGS[k] = server[k]; });
      }).catch(function () {});
  }

  function saveRating(item, patch) {
    if (!item.id) return;
    var rec = RATINGS[item.id] || { id: item.id, q: item.q, unit: item.unit };
    if ('rating' in patch) {
      if (patch.rating) rec.rating = patch.rating; else delete rec.rating;
    }
    if ('note' in patch) {
      if (patch.note) rec.note = patch.note; else delete rec.note;
    }
    if (rec.rating || rec.note) RATINGS[item.id] = rec; else delete RATINGS[item.id];
    try { localStorage.setItem(RATINGS_LS, JSON.stringify(RATINGS)); } catch (e) {}
    var body = { id: item.id, q: item.q, unit: item.unit };
    if ('rating' in patch) body.rating = patch.rating || '';
    if ('note' in patch) body.note = patch.note || '';
    return fetch('/api/rating', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(function () {});   // offline: localStorage already holds it
  }

  // The good / bad / note controls for one question.
  function ratingRow(item, cls) {
    var rec = RATINGS[item.id] || {};
    var wrap = el('div', 'qz-rate-wrap' + (cls ? ' ' + cls : ''));
    var row = el('div', 'qz-rate');

    var good = el('button', 'qz-rate-btn'); good.type = 'button';
    good.textContent = 'Good question';
    var bad = el('button', 'qz-rate-btn'); bad.type = 'button';
    bad.textContent = 'Bad question';
    var noteBtn = el('button', 'qz-rate-btn'); noteBtn.type = 'button';
    var status = el('span', 'qz-rate-status');

    var noteBox = el('div', 'qz-note-box'); noteBox.hidden = true;
    var ta = el('textarea', 'qz-note-text');
    ta.placeholder = 'What is wrong with it, or what would make it better?';
    ta.value = rec.note || '';
    var saveBtn = el('button', 'qz-btn primary'); saveBtn.type = 'button';
    saveBtn.textContent = 'Save note';
    noteBox.appendChild(ta); noteBox.appendChild(saveBtn);

    function paint() {
      var r = RATINGS[item.id] || {};
      good.className    = 'qz-rate-btn qz-rate-good' + (r.rating === 'good' ? ' is-on' : '');
      bad.className     = 'qz-rate-btn qz-rate-bad'  + (r.rating === 'bad'  ? ' is-on' : '');
      noteBtn.className = 'qz-rate-btn qz-rate-note' + (r.note ? ' is-on' : '');
      noteBtn.textContent = r.note ? 'Note \u2713' : 'Note';
    }
    function flash(msg) {
      status.textContent = msg;
      setTimeout(function () { if (status.textContent === msg) status.textContent = ''; }, 1600);
    }
    function setRating(v) {
      var cur = (RATINGS[item.id] || {}).rating;
      var next = cur === v ? '' : v;          // clicking the active one clears it
      saveRating(item, { rating: next });
      paint(); flash(next ? 'saved' : 'cleared');
    }
    good.addEventListener('click', function () { setRating('good'); });
    bad.addEventListener('click', function () { setRating('bad'); });
    noteBtn.addEventListener('click', function () {
      noteBox.hidden = !noteBox.hidden;
      if (!noteBox.hidden) ta.focus();
    });
    saveBtn.addEventListener('click', function () {
      saveRating(item, { note: ta.value });
      paint(); flash(ta.value.trim() ? 'note saved' : 'note cleared');
      noteBox.hidden = true;
    });

    row.appendChild(good); row.appendChild(bad); row.appendChild(noteBtn); row.appendChild(status);
    wrap.appendChild(row); wrap.appendChild(noteBox);
    paint();
    return wrap;
  }

  // Page-replacement simulation, shared by the `replace` generator's screening
  // pass and its step trace. Returns the fault count and the per-reference log.
  function simulate(ref, frames, algo) {
    var mem = [], age = [], faults = 0, trace = [];
    for (var t = 0; t < ref.length; t++) {
      var pg = ref[t], hit = mem.indexOf(pg) >= 0, out = '';
      if (hit) { if (algo === 'LRU') age[mem.indexOf(pg)] = t; }
      else {
        faults++;
        if (mem.length < frames) { mem.push(pg); age.push(t); }
        else {
          var victim = 0;
          if (algo === 'Optimal') {
            // Evict the resident page used furthest in the future (never = infinity).
            var far = -1;
            for (var j = 0; j < mem.length; j++) {
              var nxt = ref.indexOf(mem[j], t + 1); if (nxt < 0) nxt = Infinity;
              if (nxt > far) { far = nxt; victim = j; }
            }
          } else {
            // FIFO ages by load time, LRU by last reference, same scan, different age[].
            for (var k = 1; k < mem.length; k++) if (age[k] < age[victim]) victim = k;
          }
          out = mem[victim]; mem[victim] = pg; age[victim] = t;
        }
      }
      trace.push('  ' + pg + ' -> ' + (hit ? 'hit  ' : 'FAULT') + ' [' + mem.join(',') + ']' + (out !== '' ? ' evict ' + out : ''));
    }
    return { faults: faults, trace: trace, filled: mem.length };
  }

  // ── randomized calculation generators (keyed by :Q_GEN:) ─────────────────────
  var GEN = {
    ptable: function () {
      var addrBits = pick([16, 24, 28, 32, 36]), pageKB = pick([1, 2, 4, 8, 16]), entryB = pick([2, 4, 8]);
      var off = Math.log2(pageKB * 1024), pbits = addrBits - off, pages = Math.pow(2, pbits), tbits = pbits + Math.log2(entryB);
      var unit, val;
      if (tbits >= 20) { unit = 'MB'; val = Math.pow(2, tbits - 20); }
      else if (tbits >= 10) { unit = 'KB'; val = Math.pow(2, tbits - 10); }
      else { unit = 'bytes'; val = Math.pow(2, tbits); }
      return { q: 'Page table: ' + addrBits + '-bit address, byte addressing, ' + pageKB + ' KB pages, ' + entryB + '-byte entries. Size of one process’s page table (in ' + unit + ')?', a: val, unit: unit, tol: 0,
        steps: 'offset bits = log2(' + pageKB + ' KB) = ' + off + '\npage bits = ' + addrBits + ' - ' + off + ' = ' + pbits + '\npages = 2^' + pbits + ' = ' + pages.toLocaleString() + '\ntable = 2^' + pbits + ' x ' + entryB + ' B = 2^' + tbits + ' B = ' + val + ' ' + unit };
    },
    amat: function () {
      var t1 = pick([1, 2, 4, 5, 10]), t2 = pick([50, 60, 80, 100, 120, 150, 200]), H = pick([0.80, 0.85, 0.90, 0.95, 0.99]);
      var val = H * t1 + (1 - H) * (t1 + t2);
      return { q: 'AMAT: cache T1=' + t1 + ' ns, memory T2=' + t2 + ' ns, hit ratio H=' + H + '. Average access time (ns), miss re-pays cache?', a: round(val, 3), unit: 'ns', tol: 0.05,
        steps: 'T = H*T1 + (1-H)*(T1+T2) = ' + H + '*' + t1 + ' + ' + round(1 - H, 2) + '*(' + t1 + '+' + t2 + ') = ' + round(val, 3) + ' ns' };
    },
    tlb: function () {
      var tt = pick([10, 20]), tm = pick([80, 100, 120]), h = pick([0.80, 0.90, 0.95]);
      var val = h * (tt + tm) + (1 - h) * (tt + 2 * tm);
      return { q: 'TLB: TLB=' + tt + ' ns, memory=' + tm + ' ns, single-level page table, TLB hit ratio ' + h + '. Effective access time (ns)?', a: round(val, 3), unit: 'ns', tol: 0.05,
        steps: 'EAT = h*(tt+tm) + (1-h)*(tt+2*tm) = ' + h + '*(' + tt + '+' + tm + ') + ' + round(1 - h, 2) + '*(' + tt + '+2*' + tm + ') = ' + round(val, 3) + ' ns' };
    },
    hit: function () {
      var acc = pick([100, 200, 500, 1000]), miss = randint(1, Math.floor(acc * 0.4)), H = (acc - miss) / acc;
      return { q: 'Hit ratio: ' + acc.toLocaleString() + ' accesses, ' + miss + ' misses. Hit ratio H (decimal)?', a: round(H, 4), unit: '(decimal)', tol: 0.0005,
        steps: 'hits = ' + acc + ' - ' + miss + ' = ' + (acc - miss) + '\nH = ' + (acc - miss) + ' / ' + acc + ' = ' + round(H, 4) };
    },
    replace: function () {
      var algo = pick(['FIFO', 'LRU', 'Optimal']), frames = pick([3, 4]);
      var pages = frames + pick([2, 3]), ref;
      // Regenerate until the string actually exercises replacement: at least
      // three faults once the frames are full, or the drill is trivial.
      for (var attempt = 0; attempt < 50; attempt++) {
        ref = [];
        for (var i = 0; i < 12; i++) ref.push(randint(0, pages - 1));
        if (simulate(ref, frames, algo).faults - frames >= 3) break;
      }
      var sim = simulate(ref, frames, algo), faults = sim.faults;
      return { q: algo + ' replacement: ' + frames + ' frames, all initially empty, reference string ' + ref.join(', ') + '. Total page faults (counting the initial fills)?', a: faults, unit: 'faults', tol: 0,
        steps: algo + ', ' + frames + ' frames (frame contents after each reference):\n' + sim.trace.join('\n') +
          '\ntotal faults = ' + faults + ' (' + (faults - sim.filled) + ' after the frames first fill, the way Figure 8.14 marks them)' };
    },
    translate: function () {
      var pageKB = pick([1, 2, 4, 8]), bytes = pageKB * 1024;
      var page = randint(2, 9), off = randint(100, bytes - 100), frame = randint(3, 15);
      var addr = page * bytes + off, phys = frame * bytes + off;
      return { q: 'Address translation: ' + pageKB + ' KB pages, logical address ' + addr + ', and that page is held in frame ' + frame + '. Physical address?', a: phys, unit: '', tol: 0,
        steps: 'page  = ' + addr + ' div ' + bytes + ' = ' + page +
          '\noffset = ' + addr + ' mod ' + bytes + ' = ' + off +
          '\nphysical = frame x page size + offset = ' + frame + ' x ' + bytes + ' + ' + off + ' = ' + phys };
    },
    placement: function () {
      var algo = pick(['First-fit', 'Best-fit', 'Next-fit']);
      var sizes = shuffle([100, 150, 200, 250, 300, 400, 500, 600, 700]).slice(0, 5);
      var req = pick([120, 180, 220, 280, 330]);
      var fits = sizes.filter(function (h) { return h >= req; });
      if (fits.length < 2) { sizes[0] = req + 50; sizes[1] = req + 250; fits = sizes.filter(function (h) { return h >= req; }); }
      var resume = randint(0, sizes.length - 2), ans, i;
      if (algo === 'First-fit') { for (i = 0; i < sizes.length; i++) if (sizes[i] >= req) { ans = sizes[i]; break; } }
      else if (algo === 'Best-fit') { ans = Math.min.apply(null, fits); }
      else { // Next-fit: scan forward from just after the resume point, wrapping
        for (i = 1; i <= sizes.length; i++) {
          var j = (resume + i) % sizes.length;
          if (sizes[j] >= req) { ans = sizes[j]; break; }
        }
      }
      var tail = algo === 'Next-fit' ? ', scanning resumes just after the ' + sizes[resume] + 'K hole' : '';
      return { q: algo + ': holes in address order ' + sizes.map(function (h) { return h + 'K'; }).join(', ') + '; request ' + req + 'K' + tail + '. Which hole is chosen (in K)?', a: ans, unit: 'K', tol: 0,
        steps: algo + ' with request ' + req + 'K\nholes: ' + sizes.join('K, ') + 'K\nthose that fit: ' + fits.join('K, ') + 'K\n' +
          (algo === 'First-fit' ? 'first one from the start that fits' :
           algo === 'Best-fit' ? 'smallest one that fits' :
           'first one that fits scanning on from the ' + sizes[resume] + 'K hole, wrapping at the end') +
          ' = ' + ans + 'K' };
    },
    intfrag: function () {
      var pageKB = pick([1, 2, 4]), pages = randint(3, 9);
      var procKB = (pages - 1) * pageKB + randint(1, pageKB * 1024 - 1) / 1024;
      procKB = Math.round(procKB * 1024) / 1024;
      var usedLast = procKB - (pages - 1) * pageKB, waste = Math.round((pageKB - usedLast) * 1024);
      return { q: 'Internal fragmentation: a ' + Math.round(procKB * 1024) + ' B process with ' + pageKB + ' KB pages. Bytes wasted in the last page?', a: waste, unit: 'bytes', tol: 0,
        steps: 'pages needed = ceil(' + Math.round(procKB * 1024) + ' / ' + (pageKB * 1024) + ') = ' + pages +
          '\nlast page holds ' + Math.round(usedLast * 1024) + ' B of ' + (pageKB * 1024) + ' B' +
          '\nwasted = ' + (pageKB * 1024) + ' - ' + Math.round(usedLast * 1024) + ' = ' + waste + ' B' };
    },
    cpu: function () {
      var r = pick([10, 12, 15, 20]), e = pick([1, 2, 3, 5]), w = pick([10, 12, 15, 20]), tot = r + e + w, val = e / tot * 100;
      return { q: 'CPU utilization: read ' + r + ' us, execute ' + e + ' us, write ' + w + ' us. Utilization (%)?', a: round(val, 2), unit: '%', tol: 0.1,
        steps: 'total = ' + r + '+' + e + '+' + w + ' = ' + tot + ' us\nutil = ' + e + '/' + tot + ' = ' + round(val, 2) + '%' };
    },

    // ── Machine Learning ─────────────────────────────────────────────────────
    // Entropy of a class distribution -- the quantity ID3 maximizes the drop in.
    entropy: function () {
      var p = randint(2, 18), n = randint(2, 18), h = hpn(p, n), t = p + n;
      return { q: 'Entropy: a node holds ' + p + ' positive and ' + n + ' negative examples. H(p,n) in bits?',
        a: round(h, 4), unit: 'bits', tol: 0.005, steps:
          'H(p,n) = -(p/(p+n)) lg(p/(p+n)) - (n/(p+n)) lg(n/(p+n))\n' +
          '       = -(' + p + '/' + t + ') lg(' + p + '/' + t + ') - (' + n + '/' + t + ') lg(' + n + '/' + t + ')\n' +
          '       = -(' + round(p / t, 4) + ')(' + round(lg(p / t), 4) + ') - (' + round(n / t, 4) + ')(' + round(lg(n / t), 4) + ')\n' +
          '       = ' + round(h, 4) + ' bits' };
    },
    // Information gain over a 2-way split: gain = H(parent) - E(feature).
    infogain: function () {
      var p1 = randint(1, 9), n1 = randint(0, 8), p2 = randint(0, 8), n2 = randint(1, 9);
      var p = p1 + p2, n = n1 + n2, t = p + n, t1 = p1 + n1, t2 = p2 + n2;
      var h = hpn(p, n), h1 = hpn(p1, n1), h2 = hpn(p2, n2);
      var e = (t1 / t) * h1 + (t2 / t) * h2, gain = h - e;
      return { q: 'Information gain: a node of ' + p + ' positive / ' + n + ' negative splits on a binary feature into ' +
          '(' + p1 + 'P, ' + n1 + 'N) and (' + p2 + 'P, ' + n2 + 'N). gain(f) in bits?',
        a: round(gain, 4), unit: 'bits', tol: 0.005, steps:
          'H(' + p + ',' + n + ') = ' + round(h, 4) + '\n' +
          'H(' + p1 + ',' + n1 + ') = ' + round(h1, 4) + '   H(' + p2 + ',' + n2 + ') = ' + round(h2, 4) + '\n' +
          'E(f) = sum_j ((p_j+n_j)/(p+n)) H(p_j,n_j)\n' +
          '     = (' + t1 + '/' + t + ')(' + round(h1, 4) + ') + (' + t2 + '/' + t + ')(' + round(h2, 4) + ') = ' + round(e, 4) + '\n' +
          'gain = H - E(f) = ' + round(h, 4) + ' - ' + round(e, 4) + ' = ' + round(gain, 4) + ' bits' };
    },
    // Gain ratio over a 3-way split -- the criterion Project 2 requires. The
    // intrinsic value depends only on the partition sizes, not the classes.
    gainratio: function () {
      var b = [[randint(1, 7), randint(0, 6)], [randint(0, 6), randint(1, 7)], [randint(1, 6), randint(1, 6)]];
      var p = 0, n = 0, i;
      for (i = 0; i < 3; i++) { p += b[i][0]; n += b[i][1]; }
      var t = p + n, h = hpn(p, n), e = 0, iv = 0, eTerms = [], ivTerms = [];
      for (i = 0; i < 3; i++) {
        var tj = b[i][0] + b[i][1], w = tj / t, hj = hpn(b[i][0], b[i][1]);
        e += w * hj; iv += w ? -w * lg(w) : 0;
        eTerms.push('(' + tj + '/' + t + ')(' + round(hj, 4) + ')');
        ivTerms.push('(' + tj + '/' + t + ') lg(' + tj + '/' + t + ')');
      }
      var gain = h - e, gr = iv ? gain / iv : 0;
      return { q: 'Gain ratio: a node of ' + p + ' positive / ' + n + ' negative splits on a 3-valued feature into ' +
          '(' + b[0][0] + 'P,' + b[0][1] + 'N), (' + b[1][0] + 'P,' + b[1][1] + 'N), (' + b[2][0] + 'P,' + b[2][1] + 'N). gainRatio(f)?',
        a: round(gr, 4), unit: '', tol: 0.005, steps:
          'H(' + p + ',' + n + ') = ' + round(h, 4) + '\n' +
          'E(f) = ' + eTerms.join(' + ') + ' = ' + round(e, 4) + '\n' +
          'gain = ' + round(h, 4) + ' - ' + round(e, 4) + ' = ' + round(gain, 4) + '\n' +
          'IV(f) = -[' + ivTerms.join(' + ') + '] = ' + round(iv, 4) + '   (partition sizes only)\n' +
          'gainRatio = gain / IV = ' + round(gain, 4) + ' / ' + round(iv, 4) + ' = ' + round(gr, 4) };
    },
    // Precision / recall / F-beta off a 2x2 confusion matrix.
    prf: function () {
      var tp = randint(8, 40), fp = randint(2, 20), fn = randint(2, 20), tn = randint(8, 40);
      var pr = tp / (tp + fp), rc = tp / (tp + fn);
      var beta = pick([0.5, 1, 1, 2]), b2 = beta * beta;
      var f = (1 + b2) * pr * rc / (b2 * pr + rc);
      return { q: 'Confusion matrix: TP=' + tp + ', FP=' + fp + ', FN=' + fn + ', TN=' + tn + '. F' + beta + ' score?',
        a: round(f, 4), unit: '', tol: 0.005, steps:
          'P = TP/(TP+FP) = ' + tp + '/' + (tp + fp) + ' = ' + round(pr, 4) + '\n' +
          'R = TP/(TP+FN) = ' + tp + '/' + (tp + fn) + ' = ' + round(rc, 4) + '\n' +
          'F_beta = (1+beta^2) PR / (beta^2 P + R), beta = ' + beta + '\n' +
          '       = ' + round(1 + b2, 2) + '(' + round(pr, 4) + ')(' + round(rc, 4) + ') / (' + round(b2, 2) + '(' + round(pr, 4) + ') + ' + round(rc, 4) + ')\n' +
          '       = ' + round(f, 4) + '\n' +
          'accuracy = ' + (tp + tn) + '/' + (tp + fp + fn + tn) + ' = ' + round((tp + tn) / (tp + fp + fn + tn), 4) + ' (for contrast)' };
    },
    // Micro- vs macro-averaged precision over 3 classes -- they disagree
    // whenever the classes are unbalanced, which is the whole point.
    micromacro: function () {
      var c = [[randint(5, 40), randint(1, 15)], [randint(5, 40), randint(1, 15)], [randint(5, 40), randint(1, 15)]];
      var which = pick(['macro', 'micro']), sTP = 0, sFP = 0, macro = 0, terms = [], i;
      for (i = 0; i < 3; i++) {
        sTP += c[i][0]; sFP += c[i][1];
        macro += (c[i][0] / (c[i][0] + c[i][1])) / 3;
        terms.push(c[i][0] + '/' + (c[i][0] + c[i][1]) + ' = ' + round(c[i][0] / (c[i][0] + c[i][1]), 4));
      }
      var micro = sTP / (sTP + sFP);
      return { q: 'Per-class counts are TP/FP = ' + c[0][0] + '/' + c[0][1] + ', ' + c[1][0] + '/' + c[1][1] + ', ' + c[2][0] + '/' + c[2][1] +
          '. The ' + which + '-averaged precision?',
        a: round(which === 'macro' ? macro : micro, 4), unit: '', tol: 0.005, steps:
          'per-class precision: ' + terms.join(',  ') + '\n' +
          'macro = (1/L) sum_i P_i = (1/3)(sum above) = ' + round(macro, 4) + '   (per-class, then average)\n' +
          'micro = sum TP / sum(TP+FP) = ' + sTP + '/' + (sTP + sFP) + ' = ' + round(micro, 4) + '   (pool counts, then divide)\n' +
          'asked for ' + which + ' = ' + round(which === 'macro' ? macro : micro, 4) };
    },
    // Haussler's bound: how many examples epsilon-exhaust a version space.
    haussler: function () {
      var H = pick([64, 128, 256, 729, 1024, 4096]), eps = pick([0.05, 0.1, 0.15, 0.2]), delta = pick([0.01, 0.05, 0.1]);
      var m = (1 / eps) * (Math.log(H) + Math.log(1 / delta));
      return { q: 'Sample complexity: |H| = ' + H + ', consistent learner, epsilon = ' + eps + ', delta = ' + delta +
          '. Minimum examples m (round up)?',
        a: Math.ceil(m), unit: 'examples', tol: 0, steps:
          'm >= (1/eps)(ln|H| + ln(1/delta))\n' +
          '  = (1/' + eps + ')(ln ' + H + ' + ln ' + round(1 / delta, 2) + ')\n' +
          '  = ' + round(1 / eps, 3) + '(' + round(Math.log(H), 4) + ' + ' + round(Math.log(1 / delta), 4) + ')\n' +
          '  = ' + round(m, 3) + '  ->  ' + Math.ceil(m) + ' examples' };
    },
    // Same bound for conjunctions of n Boolean literals, where |H| = 3^n
    // (each literal true / false / don't care) -- the EnjoySport setup.
    pacconj: function () {
      var nAttr = pick([4, 5, 6, 8, 10]), eps = pick([0.05, 0.1, 0.2]), delta = pick([0.01, 0.05, 0.1]);
      var m = (1 / eps) * (nAttr * Math.log(3) + Math.log(1 / delta));
      return { q: 'PAC: conjunctions of ' + nAttr + ' Boolean literals, epsilon = ' + eps + ', 1-delta = ' + round(1 - delta, 2) +
          ' confidence. Minimum examples m (round up)?',
        a: Math.ceil(m), unit: 'examples', tol: 0, steps:
          '|H| = 3^n = 3^' + nAttr + ' = ' + Math.pow(3, nAttr) + '   (true / false / dont-care per literal)\n' +
          'm >= (1/eps)(n ln3 + ln(1/delta))\n' +
          '  = (1/' + eps + ')(' + nAttr + '(' + round(Math.log(3), 4) + ') + ' + round(Math.log(1 / delta), 4) + ')\n' +
          '  = ' + round(m, 3) + '  ->  ' + Math.ceil(m) + ' examples' };
    },
    // Blumer et al.'s VC-based sufficient bound, for an infinite H.
    vcbound: function () {
      var vc = pick([2, 3, 4, 5, 11]), eps = pick([0.1, 0.15, 0.2]), delta = pick([0.05, 0.1, 0.2]);
      var m = (1 / eps) * (4 * lg(2 / delta) + 8 * vc * lg(13 / eps));
      return { q: 'VC sample complexity: VC(H) = ' + vc + ', epsilon = ' + eps + ', delta = ' + delta + '. Sufficient m (round up)?',
        a: Math.ceil(m), unit: 'examples', tol: 0, steps:
          'm >= (1/eps)(4 lg(2/delta) + 8 VC(H) lg(13/eps))\n' +
          '  = (1/' + eps + ')(4 lg(' + round(2 / delta, 2) + ') + 8(' + vc + ') lg(' + round(13 / eps, 2) + '))\n' +
          '  = ' + round(1 / eps, 3) + '(4(' + round(lg(2 / delta), 4) + ') + ' + (8 * vc) + '(' + round(lg(13 / eps), 4) + '))\n' +
          '  = ' + round(m, 2) + '  ->  ' + Math.ceil(m) + ' examples' };
    },
    // Silhouette coefficient for one instance. Sign alone tells you whether the
    // point sits in the right cluster.
    silhouette: function () {
      var a = round(pick([0.4, 0.8, 1.2, 1.6, 2.0, 2.5]), 2), b = round(pick([0.5, 1.0, 1.5, 2.2, 3.0, 4.0]), 2);
      var sVal = (b - a) / Math.max(a, b);
      return { q: 'Silhouette: instance x has mean intra-cluster distance a = ' + a +
          ' and mean distance to the nearest other cluster b = ' + b + '. s(x)?',
        a: round(sVal, 4), unit: '', tol: 0.005, steps:
          's = (b - a) / max(a, b) = (' + b + ' - ' + a + ') / ' + Math.max(a, b) + ' = ' + round(sVal, 4) + '\n' +
          'range is [-1, +1]; want s -> +1, i.e. a << b' + (sVal < 0 ? '\nnegative: x is closer to another cluster than to its own' : '') };
    },
    // Pseudo-F / Calinski-Harabasz, the ANOVA-style way to choose k.
    pseudof: function () {
      var k = randint(3, 6), N = randint(60, 300), ssb = randint(200, 900), sse = randint(100, 700);
      var f = (ssb / (k - 1)) / (sse / (N - k));
      return { q: 'Pseudo-F: k = ' + k + ' clusters over N = ' + N + ' instances, SSB = ' + ssb + ', SSE = ' + sse + '. F(k)?',
        a: round(f, 3), unit: '', tol: 0.05, steps:
          'F(k) = [SSB/(k-1)] / [SSE/(N-k)]\n' +
          '     = [' + ssb + '/' + (k - 1) + '] / [' + sse + '/' + (N - k) + ']\n' +
          '     = ' + round(ssb / (k - 1), 4) + ' / ' + round(sse / (N - k), 4) + ' = ' + round(f, 3) + '\n' +
          'higher is better: pick the k that maximizes F' };
    },
    // Local Outlier Factor: a point's k-distance against its neighbours'.
    lof: function () {
      var dx = round(pick([0.5, 1.0, 1.5, 2.0, 3.0, 4.5]), 2), ds = [], i;
      for (i = 0; i < 3; i++) ds.push(round(pick([0.4, 0.6, 0.8, 1.0, 1.2, 1.5]), 2));
      var mean = (ds[0] + ds[1] + ds[2]) / 3, val = dx / mean;
      return { q: 'LOF: x has k-distance ' + dx + '; its 3 neighbours have k-distances ' + vec(ds) + '. LOF(x)?',
        a: round(val, 4), unit: '', tol: 0.005, steps:
          'LOF(x) = d_k(x) / [ (1/|N(x)|) sum_{s in N(x)} d_k(s) ]\n' +
          'mean neighbour k-distance = (' + ds.join(' + ') + ')/3 = ' + round(mean, 4) + '\n' +
          'LOF = ' + dx + ' / ' + round(mean, 4) + ' = ' + round(val, 4) + '\n' +
          (val > 1.5 ? 'LOF >> 1: x is sparser than its neighbours -- an outlier' : 'LOF near 1: x is as dense as its neighbours -- not an outlier') };
    },
    // Minkowski L^p distance -- p=1 Manhattan, p=2 Euclidean, p=inf max-coordinate.
    minkowski: function () {
      var d = 4, x = [], y = [], i;
      for (i = 0; i < d; i++) { x.push(randint(0, 12)); y.push(randint(0, 12)); }
      var pv = pick([1, 2, 'inf']), diffs = [], sum = 0, mx = 0;
      for (i = 0; i < d; i++) {
        var del = Math.abs(x[i] - y[i]); diffs.push(del);
        if (del > mx) mx = del;
        sum += (pv === 1) ? del : (pv === 2 ? del * del : 0);
      }
      var val = (pv === 'inf') ? mx : (pv === 1 ? sum : Math.sqrt(sum));
      return { q: 'Minkowski distance with p = ' + pv + ' between x = ' + vec(x) + ' and y = ' + vec(y) + '?',
        a: round(val, 4), unit: '', tol: 0.005, steps:
          'D_p(x,y) = (sum_i |x_i - y_i|^p)^(1/p)\n' +
          '|x_i - y_i| = ' + vec(diffs) + '\n' +
          (pv === 'inf' ? 'p = inf -> the largest coordinate difference = ' + mx
            : pv === 1 ? 'p = 1 (Manhattan) -> ' + diffs.join(' + ') + ' = ' + sum
              : 'p = 2 (Euclidean) -> sqrt(' + diffs.map(function (v) { return v + '^2'; }).join(' + ') + ') = sqrt(' + sum + ') = ' + round(val, 4)) };
    },
    // Value Difference Metric between two values of one categorical feature.
    vdm: function () {
      var ni = randint(20, 60), nj = randint(20, 60), qp = pick([1, 2]);
      var fi = [], fj = [], i, rawI = [], rawJ = [], remI = ni, remJ = nj;
      for (i = 0; i < 2; i++) {
        var a = randint(1, remI - 1), b = randint(1, remJ - 1);
        rawI.push(a); rawJ.push(b); remI -= a; remJ -= b;
      }
      rawI.push(remI); rawJ.push(remJ);
      var sum = 0, terms = [];
      for (i = 0; i < 3; i++) {
        fi.push(rawI[i] / ni); fj.push(rawJ[i] / nj);
        var del = Math.abs(fi[i] - fj[i]);
        sum += Math.pow(del, qp);
        terms.push('|' + rawI[i] + '/' + ni + ' - ' + rawJ[i] + '/' + nj + '|' + (qp === 2 ? '^2' : '') + ' = ' + round(Math.pow(del, qp), 5));
      }
      return { q: 'VDM with q = ' + qp + ': value v_i has class counts ' + vec(rawI) + ' (N_i = ' + ni + '), value v_j has ' +
          vec(rawJ) + ' (N_j = ' + nj + ') over 3 classes. delta(v_i, v_j)?',
        a: round(sum, 5), unit: '', tol: 0.0005, steps:
          'delta(v_i,v_j) = sum_c |N_{i,c}/N_i - N_{j,c}/N_j|^q\n' +
          terms.join('\n') + '\n' +
          'delta = ' + round(sum, 5) + '   (class-conditional, so classification only)' };
    },
    // One Winnow-2 update, then the score it would now produce.
    winnow: function () {
      var alpha = pick([2, 2, 3]), theta = pick([0.5, 1, 2]), d = 4, w = [], x = [], i;
      for (i = 0; i < d; i++) { w.push(pick([0.5, 1, 1, 2])); x.push(pick([0, 1])); }
      if (x.indexOf(1) < 0) x[randint(0, d - 1)] = 1;
      var f = 0;
      for (i = 0; i < d; i++) f += w[i] * x[i];
      var pred = f > theta ? 1 : 0, actual = pick([0, 1]), w2 = w.slice(), act;
      if (pred === actual) { act = 'prediction was correct -- weights unchanged (Winnow-2 only updates on a mistake)'; }
      else if (actual === 1) {
        for (i = 0; i < d; i++) if (x[i] === 1) w2[i] = w[i] * alpha;
        act = 'predicted 0, actual 1 -> PROMOTION: w_i <- alpha*w_i wherever x_i = 1';
      } else {
        for (i = 0; i < d; i++) if (x[i] === 1) w2[i] = w[i] / alpha;
        act = 'predicted 1, actual 0 -> DEMOTION: w_i <- w_i/alpha wherever x_i = 1';
      }
      var f2 = 0;
      for (i = 0; i < d; i++) f2 += w2[i] * x[i];
      return { q: 'Winnow-2 with alpha = ' + alpha + ', theta = ' + theta + ': weights w = ' + vec(w) + ', example x = ' + vec(x) +
          ', true label = ' + actual + '. After the update, what is f(x) = sum_i w_i x_i?',
        a: round(f2, 4), unit: '', tol: 0.005, steps:
          'f(x) = sum_i w_i x_i = ' + round(f, 4) + (pred ? ' > ' : ' <= ') + theta + ' -> predict ' + pred + '\n' +
          act + '\n' +
          'w becomes ' + vec(w2.map(function (v) { return round(v, 4); })) + '   (x_i = 0 weights never move)\n' +
          'f(x) = ' + round(f2, 4) };
    },
    // 1-D Gaussian kernel density estimate at a query point.
    kde: function () {
      var h = pick([0.5, 1, 2]), xs = [], i;
      for (i = 0; i < 4; i++) xs.push(randint(0, 10));
      var xq = randint(0, 10), N = xs.length, sum = 0, terms = [];
      for (i = 0; i < N; i++) {
        var u = (xq - xs[i]) / h, kv = gauss(u);
        sum += kv;
        terms.push('K((' + xq + '-' + xs[i] + ')/' + h + ') = K(' + round(u, 3) + ') = ' + round(kv, 5));
      }
      var val = sum / (N * h);
      return { q: 'Gaussian KDE: sample ' + vec(xs) + ', bandwidth h = ' + h + '. Estimate p(x) at x = ' + xq + '?',
        a: round(val, 5), unit: '', tol: 0.0005, steps:
          'p(x) = (1/(N h)) sum_t K((x - x^t)/h),  K(u) = (1/sqrt(2 pi)) exp(-u^2/2)\n' +
          terms.join('\n') + '\n' +
          'sum of kernels = ' + round(sum, 5) + '\n' +
          'p(' + xq + ') = ' + round(sum, 5) + ' / (' + N + ' x ' + h + ') = ' + round(val, 5) };
    },
    // k-NN estimator: the posterior is just the neighbour vote share, and the
    // density falls out of the volume the k-th neighbour defines.
    knnpost: function () {
      var counts = [randint(1, 6), randint(0, 5), randint(0, 4)], k = counts[0] + counts[1] + counts[2];
      if (k < 3) { counts[0] += 3; k += 3; }
      var N = randint(100, 500), dk = round(pick([0.4, 0.75, 1.2, 2.0, 3.5]), 2);
      var ask = pick(['post', 'dens']);
      var post = counts[0] / k, dens = k / (2 * N * dk);
      return { q: 'k-NN estimator: among the k = ' + k + ' nearest neighbours of x_q the class counts are ' + vec(counts) +
          ', N = ' + N + ' total instances, and the k-th neighbour sits at distance ' + dk + '. ' +
          (ask === 'post' ? 'Estimate P(c_1 | x_q)?' : 'Estimate p(x_q)? (1-D)'),
        a: round(ask === 'post' ? post : dens, 5), unit: '', tol: 0.0005, steps:
          'P(c_i | x) = k_i / k = ' + counts[0] + '/' + k + ' = ' + round(post, 5) + '\n' +
          'p(x) = k / (2 N d(x, x_(k))) = ' + k + ' / (2 x ' + N + ' x ' + dk + ') = ' + round(dens, 5) + '\n' +
          'note the volume cancels in the posterior -- which is why k-NN classifies by vote share\n' +
          'asked for the ' + (ask === 'post' ? 'posterior = ' + round(post, 5) : 'density = ' + round(dens, 5)) };
    },
    // Bootstrap: the share of a dataset left out of one resample.
    bootstrap: function () {
      var N = pick([10, 25, 50, 100, 500, 1000]), ask = pick(['out', 'in']);
      var out = Math.pow(1 - 1 / N, N) * 100, inn = 100 - out;
      return { q: 'Bootstrap: draw ' + N + ' instances with replacement from a set of N = ' + N + '. Percent of the original set ' +
          (ask === 'out' ? 'left OUT of the resample' : 'appearing IN the resample') + '?',
        a: round(ask === 'out' ? out : inn, 3), unit: '%', tol: 0.05, steps:
          'P(a given instance is missed once) = 1 - 1/N = ' + round(1 - 1 / N, 6) + '\n' +
          'P(missed all N draws) = (1 - 1/N)^N = ' + round(1 - 1 / N, 6) + '^' + N + ' = ' + round(out / 100, 6) + '\n' +
          'left out = ' + round(out, 3) + '%,  included = ' + round(inn, 3) + '%\n' +
          'as N -> inf this tends to 1/e = 36.8% out, 63.2% in' };
    },
    // A regression tree's leaf predicts the mean; this is the MSE it pays.
    regleaf: function () {
      var m = randint(4, 6), ys = [], i;
      for (i = 0; i < m; i++) ys.push(randint(1, 30));
      var sum = 0;
      for (i = 0; i < m; i++) sum += ys[i];
      var mean = sum / m, se = 0, terms = [];
      for (i = 0; i < m; i++) { se += (ys[i] - mean) * (ys[i] - mean); terms.push('(' + ys[i] + ' - ' + round(mean, 4) + ')^2'); }
      var mse = se / m;
      return { q: 'Regression tree leaf holding responses ' + vec(ys) + '. It predicts the mean -- what MSE does it pay?',
        a: round(mse, 4), unit: '', tol: 0.005, steps:
          'g_m = mean = (' + ys.join(' + ') + ')/' + m + ' = ' + round(mean, 4) + '\n' +
          'SE = ' + terms.join(' + ') + ' = ' + round(se, 4) + '\n' +
          'MSE = SE / N_m = ' + round(se, 4) + '/' + m + ' = ' + round(mse, 4) + '\n' +
          'a split is worth taking only if the weighted child MSE beats ' + round(mse, 4) };
    }
  };

  // ── one test instance mounted into `host`, drawing from `pool` records ───────
  function mountQuiz(host, pool) {
    var concept = pool.filter(function (r) { return r.type !== 'calc'; });
    var calc = pool.filter(function (r) { return r.type === 'calc' && GEN[r.gen]; });
    var units = [];
    concept.forEach(function (r) { if (r.unit && units.indexOf(r.unit) < 0) units.push(r.unit); });

    // Build the widget shell.
    host.classList.add('quiz-widget');
    var unitSel = '<option value="all">All units</option>' +
      units.map(function (u) { return '<option value="' + esc(u) + '">' + esc(unitLabel(u)) + '</option>'; }).join('');
    // Small dedicated quizzes default to showing every question; large banks
    // sample a subset so repeated study stays varied.
    var smallPool = concept.length <= 30;
    var countSel = '<select class="qz-count">' +
      '<option value="10">10</option>' +
      '<option value="20"' + (smallPool ? '' : ' selected') + '>20</option>' +
      '<option value="9999"' + (smallPool ? ' selected' : '') + '>All</option>' +
      '</select>';
    host.innerHTML =
      '<div class="qz-setup">' +
        '<label>Mode: <select class="qz-mode">' +
          '<option value="test">Test</option>' +
          '<option value="cards">Flashcards</option>' +
        '</select></label>' +
        (units.length > 1 ? '<label>Unit: <select class="qz-unit">' + unitSel + '</select></label>' : '') +
        (concept.length ? '<label class="qz-only-test">Questions: ' + countSel + '</label>' : '') +
        (calc.length ? '<label><input type="checkbox" class="qz-calc" checked> +calculations</label>' : '') +
        '<button type="button" class="qz-btn primary qz-new">New test</button>' +
        '<button type="button" class="qz-btn qz-timer qz-only-test">Start timer</button>' +
        '<span class="qz-sw qz-only-test">00:00</span>' +
      '</div>' +
      '<div class="qz-questions"></div>' +
      '<div class="qz-cards" hidden>' +
        '<div class="qz-card">' +
          '<div class="qz-card-tag"></div>' +
          '<div class="qz-card-face"></div>' +
          '<div class="qz-card-hint"></div>' +
        '</div>' +
        '<div class="qz-card-nav">' +
          '<button type="button" class="qz-btn qz-prev">\u2190 Prev</button>' +
          '<span class="qz-card-count"></span>' +
          '<button type="button" class="qz-btn qz-next">Next \u2192</button>' +
          '<button type="button" class="qz-btn qz-flip primary">Flip</button>' +
        '</div>' +
      '</div>' +
      '<div class="qz-actions">' +
        '<button type="button" class="qz-btn primary qz-reveal">Show all answers</button>' +
      '</div>' +
      '<div class="qz-score"></div>';

    var q = function (sel) { return host.querySelector(sel); };
    var qroot = q('.qz-questions');
    var items = [], nodes = {};

    function toConceptItem(r) {
      return { id: r.id, type: r.type, q: r.q, options: r.options || [], a: r.answer, accept: r.accept || [], e: r.explain, unit: r.unit,
               steps: (r.steps && r.steps.length) ? formatSteps(r.steps) : '' };
    }
    function toCalcItem(r) {
      var g = GEN[r.gen]();
      return { id: r.id, type: 'calc', q: g.q, a: g.a, unit: r.unit, dispUnit: g.unit, tol: g.tol, steps: g.steps, e: '' };
    }

    function buildTest() {
      var unitVal = q('.qz-unit') ? q('.qz-unit').value : 'all';
      var count = q('.qz-count') ? parseInt(q('.qz-count').value, 10) : 0;
      var withCalc = q('.qz-calc') ? q('.qz-calc').checked : false;
      var cpool = concept.filter(function (r) { return unitVal === 'all' || r.unit === unitVal; });
      if (mode() === 'cards') count = cpool.length;   // a deck is the whole pool
      var chosen = shuffle(cpool).slice(0, Math.min(count, cpool.length)).map(toConceptItem);
      var calcItems = [];
      if (withCalc) {
        calc.filter(function (r) { return unitVal === 'all' || r.unit === unitVal || !r.unit; })
            .forEach(function (r) { calcItems.push(toCalcItem(r)); });
      }
      items = shuffle(chosen.concat(calcItems));
      render();
      var box = q('.qz-score'); box.className = 'qz-score'; box.innerHTML = '';
      swReset();
      applyMode();
      host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function render() {
      qroot.innerHTML = ''; nodes = {};
      items.forEach(function (item, idx) {
        var card = el('div', 'qz-q');
        var prompt = el('div', 'qz-prompt');
        prompt.innerHTML = '<span class="qz-num">' + (idx + 1) + '.</span>';
        prompt.appendChild(document.createTextNode(item.q));
        var tagTxt = (item.type === 'calc' ? 'calc' : '') +
          (item.unit ? (item.type === 'calc' ? ' · ' : '') + unitLabel(item.unit) : '');
        if (tagTxt) { var tag = el('span', 'qz-tag'); tag.textContent = tagTxt; prompt.appendChild(tag); }
        card.appendChild(prompt);

        var get;
        if (item.type === 'mc' || item.type === 'tf') {
          var opts = item.type === 'tf' ? ['True', 'False'] : item.options;
          var ul = el('ul', 'qz-opts');
          opts.forEach(function (opt) {
            var li = el('li'), lab = el('label'), r = el('input');
            r.type = 'radio'; r.name = host.id ? host.id + 'q' + idx : 'qzq' + idx; r.value = opt;
            lab.appendChild(r); lab.appendChild(document.createTextNode(' ' + opt)); li.appendChild(lab); ul.appendChild(li);
          });
          card.appendChild(ul);
          get = function () { var s = card.querySelector('input[type=radio]:checked'); return s ? s.value : null; };
        } else if (item.type === 'short') {
          var ta = el('textarea'); ta.placeholder = 'Recall your answer, then Reveal to check it against the model answer.';
          card.appendChild(ta); get = function () { return ta.value; };
        } else {
          var inp = el('input'); inp.type = 'text'; inp.autocomplete = 'off'; inp.spellcheck = false;
          inp.placeholder = item.type === 'calc' ? ('Answer' + (item.dispUnit ? ' (' + item.dispUnit + ')' : '')) : 'Type your answer';
          card.appendChild(inp); get = function () { return inp.value; };
        }
        var one = el('button', 'qz-btn qz-reveal-one'); one.type = 'button';
        one.textContent = 'Reveal answer';
        one.addEventListener('click', function () { showCard(idx); });
        card.appendChild(one);
        var fb = el('div', 'qz-feedback'); card.appendChild(fb);
        qroot.appendChild(card);
        card.appendChild(ratingRow(item));
        nodes[idx] = { el: card, feedback: fb, get: get, item: item };
      });
      typeset(qroot);
    }

    // Reveal one question's answer. Everything is self-assessed: the engine
    // shows the answer (and the worked steps for a calc) and you mark your own.
    function showCard(idx) {
      var node = nodes[idx], item = node.item, fb = node.feedback;
      fb.className = 'qz-feedback show info';
      // A `short' question's steps hold the pseudocode or derivation it asked
      // for; a calc's hold its worked arithmetic. Same monospace block either way.
      var steps = item.steps ? '<div class="qz-steps">' + esc(item.steps) + '</div>' : '';
      if (item.type === 'short') {
        fb.innerHTML = '<strong>Model answer:</strong> ' + esc(item.a) + steps;
        typeset(fb);
        return;
      }
      var ans = esc(String(item.a)) + (item.dispUnit ? ' ' + esc(item.dispUnit) : '');
      fb.innerHTML = '<strong>Answer:</strong> <span class="qz-c-ok">' + ans + '</span>' +
        (item.e ? ': ' + esc(item.e) : '') + steps;
      typeset(fb);
    }

    function revealAll() {
      items.forEach(function (item, idx) { showCard(idx); });
      var box = q('.qz-score'); box.className = 'qz-score show';
      box.innerHTML = 'All ' + items.length + ' answers revealed. Mark your own.';
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }


    // ── flashcards ─────────────────────────────────────────────────────────────
    // The same items the test draws, shown one at a time as a flip card: the
    // prompt on the front, the answer (plus any worked steps) on the back.
    var cardIdx = 0, cardFlipped = false;
    // Phones have no Space bar and no hover; word the prompts for the device.
    // The media query is the first guess, but a real touch is the proof, so the
    // wording upgrades itself the first time the card is touched.
    var touch = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
    var HINT_FRONT, HINT_BACK;
    function setHints() {
      HINT_FRONT = touch ? 'Tap the card to flip' : 'Click the card (or press Space) to flip';
      HINT_BACK = touch ? 'Answer. Tap for the next card, or swipe' : 'Answer. Click or press Space for the next card';
    }
    setHints();

    function cardBack(item) {
      var parts = [String(item.a) + (item.dispUnit ? ' ' + item.dispUnit : '')];
      if (item.e) parts.push(item.e);
      if (item.steps) parts.push(item.steps);
      return parts.join('\n\n');
    }

    function drawCard() {
      if (!items.length) return;
      if (cardIdx >= items.length) cardIdx = 0;
      if (cardIdx < 0) cardIdx = items.length - 1;
      var item = items[cardIdx];
      var face = q('.qz-card-face');
      face.textContent = cardFlipped ? cardBack(item) : item.q;
      face.className = 'qz-card-face' + (cardFlipped ? ' is-back' : '');
      var tagTxt = (item.type === 'calc' ? 'calc' : item.type) +
        (item.unit ? ' \u00b7 ' + unitLabel(item.unit) : '');
      q('.qz-card-tag').textContent = tagTxt;
      q('.qz-card-count').textContent = (cardIdx + 1) + ' / ' + items.length;
      q('.qz-card-hint').textContent = cardFlipped ? HINT_BACK : HINT_FRONT;
      var stale = host.querySelector('.qz-rate-card');
      if (stale) stale.parentNode.removeChild(stale);
      q('.qz-card').appendChild(ratingRow(item, 'qz-rate-card'));
      typeset(face);
    }
    function flipCard() { cardFlipped = !cardFlipped; drawCard(); }
    function stepCard(n) { cardIdx += n; cardFlipped = false; drawCard(); }

    // Space flips, then advances; arrows move without flipping.
    host.addEventListener('keydown', function (e) {
      if (mode() !== 'cards') return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); cardFlipped ? stepCard(1) : flipCard(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepCard(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepCard(-1); }
    });
    var swipeX = 0, swipeY = 0, swiped = false;
    var cardEl = q('.qz-card');
    cardEl.addEventListener('touchstart', function (e) {
      if (inRating(e)) return;
      var t = e.changedTouches[0]; swipeX = t.clientX; swipeY = t.clientY; swiped = false;
      if (!touch) { touch = true; setHints(); drawCard(); }
    }, { passive: true });
    cardEl.addEventListener('touchend', function (e) {
      if (inRating(e)) return;
      var t = e.changedTouches[0], dx = t.clientX - swipeX, dy = t.clientY - swipeY;
      // Horizontal, far enough, and not really a scroll.
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        swiped = true; stepCard(dx < 0 ? 1 : -1);
      }
    }, { passive: true });
    function inRating(e) {
      var n = e.target;
      while (n && n !== cardEl) {
        if (n.classList && n.classList.contains('qz-rate-wrap')) return true;
        n = n.parentNode;
      }
      return false;
    }
    cardEl.addEventListener('click', function (e) {
      if (inRating(e)) return;        // rating the card is not flipping it
      if (swiped) { swiped = false; return; }
      cardFlipped ? stepCard(1) : flipCard();
    });
    q('.qz-flip').addEventListener('click', flipCard);
    q('.qz-next').addEventListener('click', function () { stepCard(1); });
    q('.qz-prev').addEventListener('click', function () { stepCard(-1); });

    function mode() { return q('.qz-mode') ? q('.qz-mode').value : 'test'; }

    function applyMode() {
      var cards = mode() === 'cards';
      q('.qz-questions').hidden = cards;
      q('.qz-cards').hidden = !cards;
      q('.qz-actions').hidden = cards;
      host.classList.toggle('is-cards', cards);
      q('.qz-new').textContent = cards ? 'Shuffle deck' : 'New test';
      if (cards) { swPause(); cardIdx = 0; cardFlipped = false; drawCard(); }
      var box = q('.qz-score'); box.className = 'qz-score'; box.innerHTML = '';
      host.setAttribute('tabindex', '-1');
    }

    // ── stopwatch ──────────────────────────────────────────────────────────────
    var swEl = q('.qz-sw'), swBtn = q('.qz-timer');
    var swRun = false, swStart = 0, swAcc = 0, swInt = null;
    function fmt(ms) { var t = Math.floor(ms / 1000), m = Math.floor(t / 60), s = t % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
    function swTick() { swEl.textContent = fmt(swAcc + (swRun ? Date.now() - swStart : 0)); }
    function swStartFn() { if (swRun) return; swRun = true; swStart = Date.now(); swEl.classList.add('running'); swBtn.textContent = 'Pause'; swInt = setInterval(swTick, 250); swTick(); }
    function swPause() { if (!swRun) return; swAcc += Date.now() - swStart; swRun = false; clearInterval(swInt); swEl.classList.remove('running'); swBtn.textContent = 'Resume'; swTick(); }
    function swReset() { swRun = false; clearInterval(swInt); swAcc = 0; swEl.classList.remove('running'); swBtn.textContent = 'Start timer'; swEl.textContent = '00:00'; }

    q('.qz-new').addEventListener('click', buildTest);
    q('.qz-mode').addEventListener('change', buildTest);
    q('.qz-reveal').addEventListener('click', revealAll);
    swBtn.addEventListener('click', function () { swRun ? swPause() : swStartFn(); });

    buildTest();
  }

  // ── filter tokens for a mount's data-quiz-test value ─────────────────────────
  // Tokens (comma-separated, OR'd): `all`; `self` (questions authored on THIS
  // page); `type:<t>` (mc/tf/fill/short/calc); anything else = a :Q_UNIT: tag.
  // Within one token, `+` ANDs the parts: `mem+type:calc` is the memory unit's
  // calculations only. Needed once two subjects both author calc questions --
  // a bare `type:calc` would pull in every subject's.
  function currentHref() {
    var p = location.pathname;
    if (p.charAt(p.length - 1) === '/') p += 'index.html';
    return p;
  }
  function matchesPart(r, tk, curHref) {
    if (tk === 'all') return true;
    if (tk === 'self') return r.pageHref === curHref;
    if (tk.indexOf('type:') === 0) return (r.type || '') === tk.slice(5);
    return (r.unit || '').toLowerCase() === tk;
  }
  function recordMatches(r, tokens, curHref) {
    for (var i = 0; i < tokens.length; i++) {
      var parts = tokens[i].split('+'), ok = true;
      for (var j = 0; j < parts.length; j++) {
        var part = parts[j].trim();
        if (part && !matchesPart(r, part, curHref)) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  }

  // ── boot: find mounts, fetch the bank, filter per mount, render ──────────────
  function boot() {
    var mounts = Array.prototype.slice.call(document.querySelectorAll('[data-quiz-test]'));
    if (!mounts.length) return;
    var cur = currentHref();
    Promise.resolve(loadRatings())
      .then(function () { return fetch('/quiz-index.json'); })
      .then(function (r) { return r.json(); })
      .then(function (bank) {
        if (!Array.isArray(bank)) bank = [];
        mounts.forEach(function (host, i) {
          if (!host.id) host.id = 'quiz' + i;
          var tokens = (host.getAttribute('data-quiz-test') || 'all').trim().toLowerCase()
            .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          if (!tokens.length) tokens = ['all'];
          var pool = bank.filter(function (r) { return recordMatches(r, tokens, cur); });
          if (!pool.length) { host.innerHTML = '<p><em>No quiz questions match this page yet.</em></p>'; return; }
          mountQuiz(host, pool);
        });
      })
      .catch(function () {
        mounts.forEach(function (host) { host.innerHTML = '<p><em>Could not load the quiz bank.</em></p>'; });
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
