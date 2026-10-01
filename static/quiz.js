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

  var UNIT_LABEL = { ov: 'Overview', mem: 'Memory', proc: 'Process' };

  // ── tiny helpers ────────────────────────────────────────────────────────────
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function randint(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
  function round(x, d) { var m = Math.pow(10, d); return Math.round(x * m) / m; }
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
  function unitLabel(u) { return UNIT_LABEL[u] || (u ? u.toUpperCase() : ''); }

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
      return { type: r.type, q: r.q, options: r.options || [], a: r.answer, accept: r.accept || [], e: r.explain, unit: r.unit };
    }
    function toCalcItem(r) {
      var g = GEN[r.gen]();
      return { type: 'calc', q: g.q, a: g.a, unit: r.unit, dispUnit: g.unit, tol: g.tol, steps: g.steps, e: '' };
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
        nodes[idx] = { el: card, feedback: fb, get: get, item: item };
      });
    }

    // Reveal one question's answer. Everything is self-assessed: the engine
    // shows the answer (and the worked steps for a calc) and you mark your own.
    function showCard(idx) {
      var node = nodes[idx], item = node.item, fb = node.feedback;
      fb.className = 'qz-feedback show info';
      if (item.type === 'short') {
        fb.innerHTML = '<strong>Model answer:</strong> ' + esc(item.a);
        return;
      }
      var steps = (item.type === 'calc' && item.steps) ? '<div class="qz-steps">' + esc(item.steps) + '</div>' : '';
      var ans = esc(String(item.a)) + (item.dispUnit ? ' ' + esc(item.dispUnit) : '');
      fb.innerHTML = '<strong>Answer:</strong> <span class="qz-c-ok">' + ans + '</span>' +
        (item.e ? ': ' + esc(item.e) : '') + steps;
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
      var t = e.changedTouches[0]; swipeX = t.clientX; swipeY = t.clientY; swiped = false;
      if (!touch) { touch = true; setHints(); drawCard(); }
    }, { passive: true });
    cardEl.addEventListener('touchend', function (e) {
      var t = e.changedTouches[0], dx = t.clientX - swipeX, dy = t.clientY - swipeY;
      // Horizontal, far enough, and not really a scroll.
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        swiped = true; stepCard(dx < 0 ? 1 : -1);
      }
    }, { passive: true });
    cardEl.addEventListener('click', function () {
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
  function currentHref() {
    var p = location.pathname;
    if (p.charAt(p.length - 1) === '/') p += 'index.html';
    return p;
  }
  function recordMatches(r, tokens, curHref) {
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i];
      if (tk === 'all') return true;
      if (tk === 'self') { if (r.pageHref === curHref) return true; continue; }
      if (tk.indexOf('type:') === 0) { if ((r.type || '') === tk.slice(5)) return true; continue; }
      if ((r.unit || '').toLowerCase() === tk) return true;
    }
    return false;
  }

  // ── boot: find mounts, fetch the bank, filter per mount, render ──────────────
  function boot() {
    var mounts = Array.prototype.slice.call(document.querySelectorAll('[data-quiz-test]'));
    if (!mounts.length) return;
    var cur = currentHref();
    fetch('/quiz-index.json')
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
