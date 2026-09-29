// The /tags/ browse page. Three views behind one hash route:
//   • no hash  — every tag in the wiki with its page count
//   • #graph   — the subject graph: pages as vertices, shared tags as edges
//   • #<tag>   — every page carrying that tag
// The manifest (/tag-index.json) is generated at publish time by
// wiki-build-tag-index in publish.el:
//   pages:    [{ page: "5 Tree Learning", href: "/ai/…/index.html",
//                tags: ["entropy", …] }]
//   sections: { "ai/machine-learning": "Machine Learning", … }  (nav labels,
//             used to title the graph's grouped vertices)
// The tag -> pages inverse and the graph's edges are both derived here rather
// than stored, so the tag vocabulary lives in exactly one place and cannot
// disagree with itself.
//
// Unlike search.js / learn.js / quiz.js this is NOT loaded site-wide: the tag
// chips under a page title are plain <a> links needing no JS, so this script is
// pulled in by content/tags/index.org itself.
(function () {
  'use strict';

  var app = document.getElementById('tags-app');
  if (!app) return;

  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function text(tag, cls, s) { var e = el(tag, cls); e.textContent = s; return e; }
  function note(s) { return text('p', 'tag-note', s); }

  // "/ai/machine-learning/lecture-notes/5-tree-learning/index.html"
  //   -> "ai / machine-learning / lecture-notes"
  // Deliberately the raw slugs: title-casing them would render "ai" as "Ai",
  // and the page's real title is already the prominent line.
  function crumb(href) {
    var parts = href.replace(/^\//, '').split('/');
    parts.pop();                                     // index.html / fibonacci.html
    // A page dir holds its own index.html, so drop that too; a standalone
    // snippet page (fibonacci.html) already sits in its parent's dir.
    if (parts.length && /\/index\.html$/.test(href)) parts.pop();
    return parts.join(' / ');
  }

  // The route: '' (all tags), 'graph', or a tag name. decodeURIComponent is
  // belt-and-braces — wiki-normalize-tag only ever emits [a-z0-9-].
  function route() {
    var h = (window.location.hash || '').replace(/^#/, '');
    try { return decodeURIComponent(h); } catch (e) { return h; }
  }

  // Anything the current view left running (the graph's animation frame and
  // window listeners). Torn down before each re-render so switching views does
  // not leak a simulation into the background.
  var teardown = null;

  function render(pages, sections) {
    var byTag = {};
    pages.forEach(function (p) {
      (p.tags || []).forEach(function (t) { (byTag[t] = byTag[t] || []).push(p); });
    });

    if (teardown) { teardown(); teardown = null; }
    var r = route();
    app.innerHTML = '';
    app.appendChild(viewSwitcher(r));
    if (r === 'graph') app.appendChild(graphView(pages, byTag, sections));
    else if (r) app.appendChild(tagView(r, byTag));
    else app.appendChild(indexView(byTag, pages.length));
  }

  function viewSwitcher(r) {
    var bar = el('div', 'tag-views');
    [['', 'All tags'], ['graph', 'Graph']].forEach(function (v) {
      var a = el('a', 'tag-view-link');
      a.href = '#' + v[0];
      a.textContent = v[1];
      // A single tag's page list is a drill-down from the list, so it keeps
      // "All tags" marked as the active view rather than neither.
      if ((r === 'graph') === (v[0] === 'graph')) a.className += ' is-active';
      bar.appendChild(a);
    });
    return bar;
  }

  // ── All tags ───────────────────────────────────────────────────────────
  function indexView(byTag, pageCount) {
    var wrap = el('div', 'tag-index');
    var names = Object.keys(byTag);

    if (!names.length) {
      wrap.appendChild(note('No pages are tagged yet. Add some with ' +
                            '`just tag-page <path> <tag>…`.'));
      return wrap;
    }

    // Most-used first, then alphabetical — the counts are what show the wiki's
    // shape, and ties still land somewhere predictable.
    names.sort(function (a, b) {
      return byTag[b].length - byTag[a].length || (a < b ? -1 : a > b ? 1 : 0);
    });

    wrap.appendChild(note(names.length + (names.length === 1 ? ' tag' : ' tags') +
                          ' across ' + pageCount +
                          (pageCount === 1 ? ' tagged page' : ' tagged pages')));

    var list = el('div', 'tag-cloud');
    names.forEach(function (t) {
      var a = el('a', 'tag-cloud-item');
      a.href = '#' + encodeURIComponent(t);
      a.appendChild(text('span', 'tag-cloud-name', t));
      a.appendChild(text('span', 'tag-cloud-count', String(byTag[t].length)));
      list.appendChild(a);
    });
    wrap.appendChild(list);
    return wrap;
  }

  // ── One tag's pages ────────────────────────────────────────────────────
  function tagView(tag, byTag) {
    var wrap = el('div', 'tag-view');

    var pages = byTag[tag];
    if (!pages) {
      wrap.appendChild(text('h2', 'tag-view-title', tag));
      wrap.appendChild(note('No pages carry this tag.'));
      return wrap;
    }

    var h = el('h2', 'tag-view-title');
    h.appendChild(text('span', null, tag));
    h.appendChild(text('span', 'tag-view-count',
                       pages.length + (pages.length === 1 ? ' page' : ' pages')));
    wrap.appendChild(h);

    pages = pages.slice().sort(function (a, b) {
      return a.page < b.page ? -1 : a.page > b.page ? 1 : 0;
    });

    var list = el('div', 'tag-pages');
    pages.forEach(function (p) {
      var row = el('a', 'tag-page');
      row.href = p.href;
      var c = crumb(p.href);
      if (c) row.appendChild(text('div', 'tag-page-crumb', c));
      row.appendChild(text('div', 'tag-page-title', p.page));

      // The page's other tags, so you can keep walking the graph sideways.
      var others = (p.tags || []).filter(function (t) { return t !== tag; });
      if (others.length) {
        var chips = el('div', 'tag-page-tags');
        others.forEach(function (t) { chips.appendChild(text('span', 'page-tag', t)); });
        row.appendChild(chips);
      }
      list.appendChild(row);
    });
    wrap.appendChild(list);
    return wrap;
  }

  // ── Graph view ─────────────────────────────────────────────────────────
  // Vertices are pages; an edge joins two pages that share at least one tag,
  // weighted by how many they share. This is the point of tags made visible:
  // nav.json puts each page in exactly one place, and this shows what it sits
  // beside in subject space instead.
  //
  // The layout is a small Fruchterman-Reingold simulation drawn to a canvas.
  // Rolling it by hand instead of pulling in d3-force or cytoscape keeps this
  // file dependency-free like the rest of static/ (mermaid is the one CDN
  // exception, and it is lazy-loaded only on pages that use it), keeps the
  // palette on the site's CSS variables so light and dark both just work, and
  // costs nothing at this size — the wiki tops out near 100 pages, where the
  // naive O(n²) repulsion is a few thousand operations per frame.

  // ── Hierarchy ──
  // Pages already sit in a tree — content/ai/machine-learning/lecture-notes/… —
  // so the graph reuses it as levels of detail rather than inventing clusters of
  // its own. Zoomed out, every page under a section collapses to a single vertex
  // and their edges merge into one thick one; zooming in splits each group into
  // its subsections, and finally into the pages themselves. The same picture
  // then works at 37 pages and at 300.

  // "/ai/machine-learning/lecture-notes/5-tree-learning/index.html"
  //   -> "ai/machine-learning/lecture-notes/5-tree-learning"
  // "/algorithms/fibonacci.html" -> "algorithms/fibonacci"
  function pathKey(href) {
    return (href || '').replace(/^\//, '')
                       .replace(/\/index\.html$/, '')
                       .replace(/\.html$/, '');
  }

  // Deterministic pseudo-random in [-1,1] from a key (FNV-1a), so an expanding
  // group always unfolds the same way instead of reshuffling on every visit.
  function jitter(key, salt) {
    var s = key + '#' + salt, h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return (h % 2000) / 1000 - 1;
  }

  function prettify(slug) {
    return slug.replace(/-/g, ' ').replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  }

  // The parts that never change with the zoom level: one leaf per page, and the
  // page-to-page edges those levels aggregate.
  function hierarchy(pages, byTag, sections) {
    var leaves = pages.map(function (p, i) {
      var key = pathKey(p.href);
      return { i: i, key: key, seg: key ? key.split('/') : [],
               page: p.page, href: p.href, tags: p.tags || [] };
    });
    var maxDepth = leaves.reduce(function (m, l) { return Math.max(m, l.seg.length); }, 1);

    var index = {};
    pages.forEach(function (p, i) { index[p.href] = i; });

    var seen = {}, base = [];
    Object.keys(byTag).forEach(function (t) {
      var ps = byTag[t];
      for (var a = 0; a < ps.length; a++) {
        for (var b = a + 1; b < ps.length; b++) {
          var i = index[ps[a].href], j = index[ps[b].href];
          if (i === undefined || j === undefined || i === j) continue;
          var k = Math.min(i, j) + '|' + Math.max(i, j);
          if (seen[k] !== undefined) { base[seen[k]].w++; continue; }
          seen[k] = base.length;
          base.push({ a: Math.min(i, j), b: Math.max(i, j), w: 1 });
        }
      }
    });
    return { leaves: leaves, base: base, maxDepth: maxDepth, sections: sections || {} };
  }

  // Collapse H to LEVEL: every page is represented by its ancestor that many
  // path segments deep (or by itself, if it is shallower than that).
  function levelView(h, level) {
    var groups = {}, nodes = [], of = [];

    h.leaves.forEach(function (l) {
      var key = l.seg.slice(0, level).join('/') || l.key;
      var g = groups[key];
      if (!g) {
        g = groups[key] = { key: key, members: [], tags: [], deg: 0,
                            x: 0, y: 0, dx: 0, dy: 0, pinned: false };
        g.i = nodes.length;
        nodes.push(g);
      }
      of[l.i] = g.i;
      g.members.push(l);
      l.tags.forEach(function (t) { if (g.tags.indexOf(t) === -1) g.tags.push(t); });
    });

    nodes.forEach(function (g) {
      // A group standing for exactly one page, at that page's own depth, *is*
      // that page — it gets the page's title and opens on click.
      g.leaf = g.members.length === 1 && g.members[0].key === g.key;
      g.page = g.leaf ? g.members[0].page
                      : (h.sections[g.key] || prettify(g.key.split('/').pop() || g.key));
      g.href = g.leaf ? g.members[0].href : null;
      g.tags.sort();
    });

    // Aggregate: one edge per pair of groups, carrying the total weight of the
    // page-to-page edges between them. Edges inside a group disappear — they are
    // what the group is now standing for.
    var seen = {}, edges = [];
    h.base.forEach(function (e) {
      var a = of[e.a], b = of[e.b];
      if (a === b) return;
      var i = Math.min(a, b), j = Math.max(a, b), k = i + '|' + j;
      if (seen[k] !== undefined) { edges[seen[k]].w += e.w; return; }
      seen[k] = edges.length;
      edges.push({ a: i, b: j, w: e.w });
    });
    edges.forEach(function (e) { nodes[e.a].deg++; nodes[e.b].deg++; });
    return { nodes: nodes, edges: edges };
  }

  // Deterministic seeding (a golden-angle spiral, no randomness) so the layout
  // settles the same way on every visit and the map stays memorable.
  function seed(nodes, W, H) {
    var R = Math.min(W, H) * 0.34, GA = Math.PI * (3 - Math.sqrt(5));
    nodes.forEach(function (n, i) {
      var r = R * Math.sqrt((i + 0.5) / Math.max(nodes.length, 1));
      n.x = W / 2 + r * Math.cos(i * GA);
      n.y = H / 2 + r * Math.sin(i * GA);
    });
  }

  function step(nodes, edges, W, H, temp) {
    var n = nodes.length;
    // k is Fruchterman-Reingold's ideal edge length; deriving it from the area
    // per node is what lets the same constants look right at 8 nodes and 100.
    var k = Math.sqrt((W * H) / Math.max(n, 1)) * 0.4, i, j;
    // Beyond this radius the centring force ramps up steeply — see below.
    var rMax = Math.min(W, H) * 0.44;

    for (i = 0; i < n; i++) { nodes[i].dx = 0; nodes[i].dy = 0; }

    // Repulsion between every pair, magnitude k²/d.
    for (i = 0; i < n; i++) {
      for (j = i + 1; j < n; j++) {
        var a = nodes[i], b = nodes[j];
        var dx = a.x - b.x, dy = a.y - b.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var f = (k * k) / d / d;          // k²/d, already divided by d for the unit vector
        a.dx += dx * f; a.dy += dy * f;
        b.dx -= dx * f; b.dy -= dy * f;
      }
    }

    // Attraction along edges, magnitude d²/k. These two magnitudes are what
    // make the pair balance at d = k (k²/d = d²/k ⇒ d³ = k³); anything weaker
    // and the whole graph inflates until it is pressed against the boundary.
    edges.forEach(function (e) {
      var a = nodes[e.a], b = nodes[e.b];
      var dx = a.x - b.x, dy = a.y - b.y;
      var d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      // More shared tags pulls harder, so strongly related pages sit closer.
      var f = (d * d) / k * (1 + 0.4 * (e.w - 1)) / d;
      a.dx -= dx * f; a.dy -= dy * f;
      b.dx += dx * f; b.dy += dy * f;
    });

    for (i = 0; i < n; i++) {
      var p = nodes[i];
      if (p.pinned) continue;
      // Centring, as a soft bowl rather than a constant pull. Plain
      // Fruchterman-Reingold is designed to *fill* its frame, which parks a
      // third of the graph flat against the edges where the clamp below pins it
      // for good. A weak pull everywhere plus a steeply rising one past rMax
      // keeps the graph a readable blob in the middle: measured over this
      // wiki's own tag data it cuts nodes stuck on the boundary from 21/37 to
      // 1/37 while *increasing* the median gap between neighbours.
      var ox = p.x - W / 2, oy = p.y - H / 2;
      var rad = Math.sqrt(ox * ox + oy * oy) || 0.01;
      var g = 0.03 + (rad > rMax ? 2 * (rad - rMax) / rMax : 0);
      p.dx -= ox * g;
      p.dy -= oy * g;
      var m = Math.sqrt(p.dx * p.dx + p.dy * p.dy) || 0.01;
      var lim = Math.min(m, temp);
      p.x += p.dx / m * lim;
      p.y += p.dy / m * lim;
      p.x = Math.max(24, Math.min(W - 24, p.x));
      p.y = Math.max(24, Math.min(H - 24, p.y));
    }
  }

  function palette() {
    var cs = getComputedStyle(document.documentElement);
    var get = function (v, d) { return (cs.getPropertyValue(v) || d).trim() || d; };
    return {
      text: get('--text', '#1a1a1a'),
      heading: get('--heading', '#000'),
      muted: get('--muted', '#555'),
      accent: get('--accent', '#0645ad'),
      border: get('--border-strong', '#ccc'),
      panel: get('--panel-bg', '#fff'),
      bg: get('--bg', '#fafafa'),
      stage: get('--toc-bg', '#f8f8f8')   // must match .graph-stage's background
    };
  }

  function graphView(pages, byTag, sections) {
    var wrap = el('div', 'tag-graph');

    if (pages.length < 2) {
      wrap.appendChild(note('Tag at least two pages to see the graph.'));
      return wrap;
    }

    var h = hierarchy(pages, byTag, sections);
    if (!h.base.length) {
      wrap.appendChild(note('No two pages share a tag yet, so there are no ' +
                            'connections to draw. Reuse a tag across pages to link them.'));
      return wrap;
    }

    // Zoom picks the level of detail. The thresholds are spaced so each step
    // needs a deliberate scroll rather than flickering between levels.
    var THRESH = [0, 0.85, 1.3, 1.95, 2.7, 3.4];
    function levelFor(s) {
      var L = 1;
      while (L < h.maxDepth && s >= (THRESH[L] || Infinity)) L++;
      return L;
    }
    // The `detail` value that sits in the middle of a level's threshold band.
    // The +/− buttons jump straight to a level, and parking detail mid-band
    // means the next wheel notch has to travel half a band before the level
    // flips again — so a click then a scroll don't double-step.
    function detailForLevel(L) {
      var lo = THRESH[L - 1] || 0;
      var hi = (L < h.maxDepth && THRESH[L]) ? THRESH[L] : lo + 0.6;
      return (lo + hi) / 2;
    }

    var level = levelFor(1);
    var g = levelView(h, level);

    var meta = note('');
    wrap.appendChild(meta);
    function updateMeta() {
      var pageCount = g.nodes.reduce(function (n, x) { return n + x.members.length; }, 0);
      var groups = g.nodes.filter(function (n) { return !n.leaf; }).length;
      meta.textContent =
        g.nodes.length + (g.nodes.length === 1 ? ' vertex' : ' vertices') +
        ' · ' + g.edges.length + ' connections' +
        (groups ? ' · ' + groups + ' grouped, holding ' + pageCount + ' pages'
                : ' · every page shown') +
        (h.maxDepth > 1 ? '  —  depth ' + level + ' of ' + h.maxDepth : '');
    }

    // Tag filter: highlights the pages carrying one tag without hiding the rest,
    // so you keep the whole map for context while picking out one subject.
    var highlight = null;
    var bar = el('div', 'graph-tags');
    Object.keys(byTag).sort(function (a, b) {
      return byTag[b].length - byTag[a].length || (a < b ? -1 : a > b ? 1 : 0);
    }).forEach(function (t) {
      var b = el('button', 'graph-tag');
      b.type = 'button';
      b.textContent = t;
      b.addEventListener('click', function () {
        highlight = (highlight === t) ? null : t;
        Array.prototype.forEach.call(bar.children, function (c) {
          c.classList.toggle('is-on', c.textContent === highlight);
        });
        draw();
      });
      bar.appendChild(b);
    });
    wrap.appendChild(bar);

    var stage = el('div', 'graph-stage');
    var canvas = el('canvas', 'graph-canvas');
    var tip = el('div', 'graph-tip');
    tip.hidden = true;
    stage.appendChild(canvas);
    stage.appendChild(tip);

    // Explicit +/− controls, one whole level per press. Scrolling already does
    // this, but the gesture is easy to miss on a touchpad and gives no hint that
    // the levels even exist; the buttons make the hierarchy discoverable and its
    // ends (all-grouped / all-pages) obvious by greying out. Only meaningful
    // when there is more than one level to move between.
    var zoomWrap = null, zoomIn = null, zoomOut = null, zoomReadout = null;
    if (h.maxDepth > 1) {
      zoomWrap = el('div', 'graph-zoom');
      zoomWrap.setAttribute('role', 'group');
      zoomWrap.setAttribute('aria-label', 'Zoom the graph');

      zoomIn = el('button', 'graph-zoom-btn');
      zoomIn.type = 'button';
      zoomIn.textContent = '+';
      zoomIn.title = 'Zoom in — split sections into their pages';
      zoomIn.setAttribute('aria-label', 'Zoom in to reveal more pages');
      zoomIn.addEventListener('click', function () { stepLevel(1); });

      zoomReadout = el('span', 'graph-zoom-level');
      zoomReadout.setAttribute('aria-hidden', 'true');

      zoomOut = el('button', 'graph-zoom-btn');
      zoomOut.type = 'button';
      zoomOut.textContent = '−';   // a real minus sign, not a hyphen
      zoomOut.title = 'Zoom out — fold pages back into their sections';
      zoomOut.setAttribute('aria-label', 'Zoom out to group pages by section');
      zoomOut.addEventListener('click', function () { stepLevel(-1); });

      zoomWrap.appendChild(zoomIn);
      zoomWrap.appendChild(zoomReadout);
      zoomWrap.appendChild(zoomOut);
      stage.appendChild(zoomWrap);
    }
    // Kept in step with `level` by every path that changes it (setLevel).
    function updateZoom() {
      if (!zoomWrap) return;
      zoomReadout.textContent = level + '/' + h.maxDepth;
      zoomIn.disabled = level >= h.maxDepth;
      zoomOut.disabled = level <= 1;
    }

    wrap.appendChild(stage);
    wrap.appendChild(text('p', 'graph-hint', h.maxDepth > 1
      ? 'Scroll or use the +/− buttons to zoom — in splits each section into its ' +
        'pages, out folds them back · click a section to open it up, a page to go ' +
        'to it · drag to move things or pan'
      : 'Drag a page to move it · drag the background to pan · scroll to zoom · click to open'));

    var ctx = canvas.getContext('2d');
    // `detail` is the reader's accumulated zoom intent, and all it does is pick
    // the level (see zoomBy). There is no camera zoom — each level lays itself
    // out to fill the frame — only a pan offset, for nodes dragged out of view.
    var detail = 1;
    var W = 0, H = 0, tx = 0, ty = 0;
    var hover = null, drag = null, panning = null, moved = false;
    var temp, frame = null, colors = palette();

    // Every position ever settled on, by group key, kept across level changes.
    // This is what makes zooming read as the graph unfolding rather than
    // redrawing: a group that splits hands its position to its children, and
    // children that merge hand their centre back to the group.
    var POS = {};

    function remember() {
      g.nodes.forEach(function (n) { POS[n.key] = { x: n.x, y: n.y }; });
    }

    function place(nodes) {
      var keys = Object.keys(POS), fresh = [];
      nodes.forEach(function (n) {
        if (POS[n.key]) { n.x = POS[n.key].x; n.y = POS[n.key].y; return; }

        // Zooming in: start inside the ancestor that just split open, nudged
        // apart deterministically so the group visibly unfolds.
        var anc = '';
        keys.forEach(function (k) {
          if (n.key.indexOf(k + '/') === 0 && k.length > anc.length) anc = k;
        });
        if (anc) {
          n.x = POS[anc].x + jitter(n.key, 'x') * 26;
          n.y = POS[anc].y + jitter(n.key, 'y') * 26;
          return;
        }

        // Zooming out: land on the centre of the pages being folded in.
        var cx = 0, cy = 0, c = 0;
        keys.forEach(function (k) {
          if (k.indexOf(n.key + '/') === 0) { cx += POS[k].x; cy += POS[k].y; c++; }
        });
        if (c) { n.x = cx / c; n.y = cy / c; return; }

        fresh.push(n);
      });
      if (fresh.length) seed(fresh, W || 600, H || 500);
      remember();
    }

    function setLevel(L) {
      if (L === level || L < 1 || L > h.maxDepth) return;
      level = L;
      g = levelView(h, level);
      place(g.nodes);
      hover = null; drag = null;
      // Reframe. The force layout fills the whole W×H frame whatever the node
      // count, so an unpanned view always shows everything.
      tx = 0; ty = 0;
      updateMeta();
      updateZoom();
      // Just enough heat to let the new arrangement settle, not so much that it
      // throws away the layout the reader was already looking at.
      temp = Math.max(temp || 0, W / 30);
      if (!frame) frame = window.requestAnimationFrame(tick);
      draw();
    }

    function resize() {
      var rect = stage.getBoundingClientRect();
      var cw = Math.max(320, Math.round(rect.width));
      var ch = Math.max(320, Math.round(rect.height));
      if (cw === W && ch === H) return;
      var dpr = window.devicePixelRatio || 1;
      // Assigning width/height clears the canvas and resets the context, so the
      // transform has to be reapplied after.
      canvas.width = cw * dpr; canvas.height = ch * dpr;
      canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (!W) {
        W = cw; H = ch;
        seed(g.nodes, W, H);
        remember();
        temp = W / 20;
      } else {
        // A later resize — the window, an orientation change, the sidebar
        // collapsing. Stretch the layout already on screen into the new frame
        // and let it relax, rather than re-seeding: re-seeding would throw away
        // a settled graph (and any nodes the reader had dragged into place) and
        // drop a raw spiral in its place.
        var fx = cw / W, fy = ch / H;
        g.nodes.forEach(function (n) { n.x *= fx; n.y *= fy; });
        Object.keys(POS).forEach(function (k) { POS[k].x *= fx; POS[k].y *= fy; });
        W = cw; H = ch;
        temp = Math.max(temp, W / 40);
      }
      if (!frame) frame = window.requestAnimationFrame(tick);
      draw();
    }

    function sx(x) { return x + tx; }
    function sy(y) { return y + ty; }
    // A page is sized by how connected it is; a group by how much it is holding,
    // so a collapsed section reads as visibly heavier than a single page.
    function radius(n) {
      return n.leaf ? 4.5 + 2.4 * Math.sqrt(n.deg)
                    : 6 + 3.2 * Math.sqrt(n.members.length);
    }

    function nodeAt(mx, my) {
      var wx = mx - tx, wy = my - ty;
      for (var i = g.nodes.length - 1; i >= 0; i--) {
        var n = g.nodes[i], r = (radius(n) + 5);
        if ((n.x - wx) * (n.x - wx) + (n.y - wy) * (n.y - wy) <= r * r) return n;
      }
      return null;
    }

    function lit(n) { return !highlight || n.tags.indexOf(highlight) !== -1; }

    // Once the sections have been split open, their names are gone from the
    // picture and a cluster is just a knot of page titles. These put the parent
    // back as a watermark over each group of its descendants, so you can still
    // tell at a glance which blob is Algorithms and which is Machine Learning.
    // Drawn first, behind everything, and dimmed — orientation, not content.
    // Returns the boxes it drew, so the node labels can avoid them: the
    // watermarks are the orientation layer and being drawn first would
    // otherwise just mean being drawn over.
    function drawSectionLabels() {
      if (level <= 1) return [];       // at depth 1 the vertices *are* the sections
      // Always the top-level section, not the immediate parent. One level
      // coarser sounds more informative and is unreadable in practice: at full
      // depth it produced eleven watermarks over interleaved clusters, and
      // "Dynamic Programming", "Approximation Algorithms" and "Spanning Trees"
      // simply printed on top of each other. Six stable names orient you; the
      // finer structure is what the vertices themselves already show.
      var groups = {};
      g.nodes.forEach(function (n) {
        var seg = n.key.split('/');
        if (seg.length < 2) return;           // a top-level page has no parent
        var gr = groups[seg[0]] ||
                 (groups[seg[0]] = { n: 0, x: 0, y: 0, top: Infinity });
        gr.n++; gr.x += n.x; gr.y += n.y;
        gr.top = Math.min(gr.top, n.y);
      });

      ctx.font = '600 14px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var placed = [];
      Object.keys(groups)
        // Biggest cluster first, so when two labels do compete the one standing
        // for more of the picture is the one that survives.
        .sort(function (a, b) { return groups[b].n - groups[a].n; })
        .forEach(function (key) {
          var gr = groups[key];
          if (gr.n < 2) return;               // a lone page carries its own title
          var label = (h.sections[key] || prettify(key)).toUpperCase();
          var w = ctx.measureText(label).width;
          var x = sx(gr.x / gr.n);
          // Above the cluster rather than through it, so the watermark never
          // has node circles punched out of it.
          var y = sy(gr.top) - 17;
          x = Math.max(w / 2 + 6, Math.min(W - w / 2 - 6, x));
          y = Math.max(12, Math.min(H - 8, y));
          var box = [x - w / 2 - 6, y - 9, x + w / 2 + 6, y + 9];
          for (var i = 0; i < placed.length; i++) {
            var q = placed[i];
            if (box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1]) return;
          }
          placed.push(box);
          ctx.globalAlpha = 0.45;
          ctx.fillStyle = colors.muted;
          ctx.fillText(label, x, y);
        });
      ctx.globalAlpha = 1;
      return placed;
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);

      var near = {};
      if (hover) {
        near[hover.i] = true;
        g.edges.forEach(function (e) {
          if (e.a === hover.i) near[e.b] = true;
          if (e.b === hover.i) near[e.a] = true;
        });
      }

      var sectionBoxes = drawSectionLabels();

      g.edges.forEach(function (e) {
        var a = g.nodes[e.a], b = g.nodes[e.b];
        var on = hover ? (e.a === hover.i || e.b === hover.i)
                       : (lit(a) && lit(b));
        ctx.globalAlpha = on ? 0.8 : (hover || highlight ? 0.06 : 0.32);
        // --muted rather than --border-strong: at a third opacity the border
        // colour all but vanishes against the stage in light mode, and the
        // edges are the whole point of the picture.
        ctx.strokeStyle = on && (hover || highlight) ? colors.accent : colors.muted;
        ctx.lineWidth = Math.min(4, 0.8 + (e.w - 1) * 0.9);
        ctx.beginPath();
        ctx.moveTo(sx(a.x), sy(a.y));
        ctx.lineTo(sx(b.x), sy(b.y));
        ctx.stroke();
      });

      g.nodes.forEach(function (n) {
        var on = hover ? near[n.i] : lit(n);
        var r = radius(n);
        ctx.globalAlpha = on ? 1 : 0.18;
        ctx.beginPath();
        ctx.arc(sx(n.x), sy(n.y), r, 0, Math.PI * 2);
        ctx.fillStyle = (hover === n || (highlight && lit(n))) ? colors.accent : colors.panel;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = (hover === n || (highlight && lit(n))) ? colors.accent : colors.muted;
        ctx.stroke();
      });

      // Labels last, so a later circle never lands on top of one, and with
      // collision avoidance: a graph this dense has neighbours ~30px apart and
      // labels several times that wide, so drawing them all unconditionally
      // just stacks titles on top of each other. Best-connected pages are
      // placed first and win the space; whatever no longer fits is dropped and
      // is still one hover away in the tooltip.
      ctx.font = '11px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      // Seeded with the section watermarks, so a page title never prints over
      // one: the watermark is the only thing telling you which cluster you are
      // looking at, and it is drawn first, which without this just means it is
      // drawn under.
      var placed = sectionBoxes.slice();
      // A group outranks a lone page for the scarce label space: it is standing
      // in for several, so its name carries more of the picture.
      var rank = function (n) { return n.deg + (n.leaf ? 0 : n.members.length * 2); };
      var order = g.nodes.slice().sort(function (a, b) {
        // The hovered node and its neighbours always get named.
        var pa = (hover && near[a.i]) ? 1e6 : 0, pb = (hover && near[b.i]) ? 1e6 : 0;
        return (pb + rank(b)) - (pa + rank(a));
      });
      order.forEach(function (n) {
        var on = hover ? near[n.i] : lit(n);
        if (!on) return;
        // Only the hovered node skips the overlap test. Letting all of its
        // neighbours skip it too just moves the pile-up: a hub with ten
        // neighbours would stack ten titles on the same few pixels.
        var forced = hover === n;
        var r = radius(n);
        var label = n.page.length > 26 ? n.page.slice(0, 25) + '…' : n.page;
        if (!n.leaf) label += ' (' + n.members.length + ')';
        var w = ctx.measureText(label).width;
        var cx = sx(n.x), top = sy(n.y) + r + 4;
        var box = [cx - w / 2 - 2, top - 1, cx + w / 2 + 2, top + 13];
        // Must fit the canvas whole. Clipping reads as a typo ("…mputer System
        // Overview") and nudging it back inside would park the title under a
        // different node; a name that will not fit is simply left to the
        // tooltip. This applies to the hovered node too, which has the tooltip
        // open anyway.
        if (box[0] < 0 || box[2] > W || box[1] < 0 || box[3] > H) return;
        if (!forced) {
          for (var i = 0; i < placed.length; i++) {
            var q = placed[i];
            if (box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1]) return;
          }
        }
        placed.push(box);
        ctx.globalAlpha = 1;
        // A halo in the stage colour keeps the text legible where it crosses an
        // edge, without having to reserve empty space around every node.
        ctx.lineWidth = 3;
        ctx.strokeStyle = colors.stage;
        ctx.strokeText(label, cx, top);
        ctx.fillStyle = hover === n ? colors.accent : colors.text;
        ctx.fillText(label, cx, top);
      });
      ctx.globalAlpha = 1;
    }

    function tick() {
      frame = null;
      if (temp > 0.6) {
        step(g.nodes, g.edges, W, H, temp);
        temp *= 0.975;                      // cooling: the layout settles, then stops
        remember();
        draw();
        frame = window.requestAnimationFrame(tick);
      } else {
        remember();
        draw();
      }
    }
    function reheat(t) {
      temp = Math.max(temp, t);
      if (!frame) frame = window.requestAnimationFrame(tick);
    }

    function pos(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    canvas.addEventListener('mousemove', function (e) {
      var p = pos(e);
      if (drag) {
        moved = true;
        drag.x = p.x - tx; drag.y = p.y - ty;
        drag.pinned = true;
        POS[drag.key] = { x: drag.x, y: drag.y };   // survive the next level change
        reheat(6);
        return;
      }
      if (panning) {
        moved = true;
        tx = p.x - panning.x; ty = p.y - panning.y;
        draw();
        return;
      }
      var n = nodeAt(p.x, p.y);
      canvas.style.cursor = n ? 'pointer' : 'grab';
      if (n !== hover) { hover = n; draw(); }
      if (n) {
        tip.hidden = false;
        tip.innerHTML = '';
        tip.appendChild(text('div', 'graph-tip-title', n.page));
        if (n.leaf) {
          var c = crumb(n.href);
          if (c) tip.appendChild(text('div', 'graph-tip-crumb', c));
        } else {
          tip.appendChild(text('div', 'graph-tip-crumb',
            n.members.length + ' pages · click to open up'));
        }
        var chips = el('div', 'graph-tip-tags');
        // A whole section can carry a lot of tags; show the first few and count
        // the rest rather than letting the tooltip grow taller than the stage.
        n.tags.slice(0, 10).forEach(function (t) {
          chips.appendChild(text('span', 'page-tag', t));
        });
        if (n.tags.length > 10) {
          chips.appendChild(text('span', 'graph-tip-more', '+' + (n.tags.length - 10)));
        }
        tip.appendChild(chips);
        // Flip the tooltip back inside the stage when the node is near an edge.
        var tw = tip.offsetWidth || 200, th = tip.offsetHeight || 60;
        tip.style.left = Math.max(4, Math.min(W - tw - 4, p.x + 14)) + 'px';
        tip.style.top = Math.max(4, Math.min(H - th - 4, p.y + 14)) + 'px';
      } else {
        tip.hidden = true;
      }
    });

    canvas.addEventListener('mouseleave', function () {
      hover = null; drag = null; panning = null; tip.hidden = true; draw();
    });

    canvas.addEventListener('mousedown', function (e) {
      var p = pos(e);
      moved = false;
      var n = nodeAt(p.x, p.y);
      if (n) { drag = n; } else { panning = { x: p.x - tx, y: p.y - ty }; }
      canvas.style.cursor = 'grabbing';
    });

    window.addEventListener('mouseup', function () {
      drag = null; panning = null;
      canvas.style.cursor = 'grab';
    });

    // Zooming is purely semantic: the wheel moves `detail`, and crossing a
    // threshold swaps in a coarser or finer graph. It deliberately does *not*
    // also magnify. Letting it do both fights itself — scrolling all the way in
    // would leave the camera at 3.5x with two vertices on screen, and all the
    // way out would shrink six section vertices to a speck — and it is
    // redundant besides, since each level is laid out to fill the frame on its
    // own. That is the point of levels of detail: to see more, reveal more.
    function zoomBy(f) {
      var next = Math.max(0.35, Math.min(3.5, detail * f));
      if (next === detail) return;
      detail = next;
      var L = levelFor(detail);
      if (L !== level) setLevel(L);
    }

    // One whole level per press, for the +/− buttons. Parks `detail` mid-band so
    // the wheel stays in sync, then reuses the same setLevel path the wheel and
    // clicks do.
    function stepLevel(dir) {
      var target = Math.max(1, Math.min(h.maxDepth, level + dir));
      if (target === level) return;
      detail = detailForLevel(target);
      setLevel(target);
    }

    // A click is only a navigation if the pointer did not travel — otherwise
    // every drag would open the page you were only trying to move.
    canvas.addEventListener('click', function (e) {
      if (moved) return;
      var p = pos(e), n = nodeAt(p.x, p.y);
      if (!n) return;
      // A page goes to the page. A group opens up in place, zooming just past
      // the next threshold and keeping itself under the cursor, so its children
      // appear where it was rather than somewhere else on the canvas.
      if (n.leaf) { window.location.href = n.href; return; }
      // Open a group: step detail just past the next threshold. Its children are
      // seeded where it stood, so they unfold from the spot you clicked.
      detail = Math.min(3.5, (THRESH[level] || detail) + 0.06);
      setLevel(levelFor(detail));
    });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY * 0.0014));
    }, { passive: false });

    var onResize = resize;   // resize() now adapts in place; see above
    var themeWatch = new MutationObserver(function () { colors = palette(); draw(); });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('resize', onResize);

    teardown = function () {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      themeWatch.disconnect();
    };

    updateMeta();
    updateZoom();
    // The canvas has no size until it is in the document; resize() does the
    // initial seed and starts the simulation itself.
    window.requestAnimationFrame(resize);
    return wrap;
  }

  // ── Boot ───────────────────────────────────────────────────────────────
  fetch('/tag-index.json')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var pages = (data && Array.isArray(data.pages)) ? data.pages : [];
      // sections maps a content path to its nav label, for the graph's
      // hierarchy; absent on an older build, in which case group vertices fall
      // back to a de-slugified path segment.
      var sections = (data && data.sections) || {};
      render(pages, sections);
      window.addEventListener('hashchange', function () { render(pages, sections); });
    })
    .catch(function () {
      app.innerHTML = '';
      app.appendChild(note('Could not load the tag index.'));
    });
}());
