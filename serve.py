"""Local dev server for the wiki, plus the new-page/delete-page/move-page CLI
(see the `just` recipes). Creating a page scaffolds a generic index.org,
appends the entry to nav.json, and rebuilds the site so the new page appears
everywhere.
"""

import datetime
import http.server
import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, 'public')
NAV = os.path.join(ROOT, 'nav.json')
# Question ratings collected from the quiz UI. Lives at the repo root, not under
# public/, so a rebuild never wipes it. Keyed by the stable question id that
# wiki-build-quiz-index writes into quiz-index.json.
RATINGS = os.path.join(ROOT, 'question-ratings.json')
_ratings_lock = threading.Lock()


def read_ratings():
    try:
        with open(RATINGS) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def write_rating(entry):
    """Merge one rating/note into the store, keyed by question id.

    Rating and note are independent: sending only a note leaves an existing
    verdict alone, and vice versa, so the two controls never clobber each other.
    """
    qid = (entry.get('id') or '').strip()
    if not qid:
        raise ValueError('missing question id')
    with _ratings_lock:
        store = read_ratings()
        rec = store.get(qid, {})
        rec['id'] = qid
        for k in ('q', 'unit', 'page'):
            if entry.get(k):
                rec[k] = entry[k]
        if 'rating' in entry:
            if entry['rating'] in ('good', 'bad'):
                rec['rating'] = entry['rating']
            else:
                rec.pop('rating', None)          # cleared
        if 'note' in entry:
            note = (entry.get('note') or '').strip()
            if note:
                rec['note'] = note
            else:
                rec.pop('note', None)
        rec['updated'] = datetime.datetime.now().isoformat(timespec='seconds')
        if rec.get('rating') or rec.get('note'):
            store[qid] = rec
        else:
            store.pop(qid, None)                 # both cleared: drop the row
        tmp = RATINGS + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(store, f, indent=2, sort_keys=True)
        os.replace(tmp, RATINGS)
        return store.get(qid, {})

def merge_ratings(path):
    """Merge a browser export into question-ratings.json, newest record wins.

    The deployed GitHub Pages site has no /api/rating endpoint, so a verdict
    made there lives only in that browser's localStorage. "Export ratings" in
    the quiz toolbar downloads it in this file's own shape; this merges it back
    in. Records are keyed by question id and compared on 'updated', so running
    it twice is a no-op and an older export cannot overwrite a newer verdict.
    """
    with open(path) as f:
        incoming = json.load(f)
    if not isinstance(incoming, dict):
        raise ValueError('expected a JSON object keyed by question id')
    with _ratings_lock:
        store = read_ratings()
        added = updated = skipped = 0
        for qid, rec in incoming.items():
            if not isinstance(rec, dict):
                continue
            old = store.get(qid)
            if old is None:
                store[qid] = rec
                added += 1
            elif (rec.get('updated') or '') > (old.get('updated') or ''):
                store[qid] = rec
                updated += 1
            else:
                skipped += 1
        tmp = RATINGS + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(store, f, indent=2, sort_keys=True)
        os.replace(tmp, RATINGS)
    print('%s: %d added, %d updated, %d already current (%d total)'
          % (os.path.basename(RATINGS), added, updated, skipped, len(store)))


# serve.py is local-only tooling: every rebuild it runs (the dev server and the
# page-management commands) must include pages marked "private" in nav.json, so
# they stay visible while working locally. publish.el gates on this env var and
# excludes private pages by default; only the live GitHub Pages build (which
# does not set it) drops them. See page_visibility_tab / the justfile.
os.environ.setdefault('WIKI_INCLUDE_LOCAL', '1')

# ── Live reload ─────────────────────────────────────────────────────────
# The dev server watches content/ + static/ + nav.json and rebuilds on save,
# then pushes a reload event over SSE to every open page. The client script is
# injected into HTML at serve time (not baked into public/) so the built output
# stays clean and deployable elsewhere without a dev-only <script> leaking in.
RELOAD_SCRIPT = b"""<script>
(function () {
  var es = new EventSource('/__reload');
  es.onmessage = function () { location.reload(); };
})();
</script>
"""

# One Queue per connected SSE client; notify_reload() pushes to all of them.
_reload_clients = set()
_reload_lock = threading.Lock()

# content/*.org and assets rebuild incrementally (org-publish's own timestamp
# cache skips unchanged files); a nav.json change forces a full rebuild because
# the sidebar + homepage TOC are baked into every page.
WATCH_DIRS = [os.path.join(ROOT, 'content'), os.path.join(ROOT, 'static')]
WATCH_FILES = [NAV]


def build(force=False, quiet=False):
    """Publish the site. force=True rebuilds every page (needed when nav.json
    changed); otherwise org-publish only re-exports files whose content changed.

    quiet=True swallows Emacs' per-file chatter (~130 lines) and replays it only
    if the build fails, for commands whose own output is the point.
    """
    proc = subprocess.run(
        ['emacs', '--batch', '-l', 'publish.el', '--eval',
         '(org-publish-all %s)' % ('t' if force else 'nil')],
        cwd=ROOT, check=not quiet,
        stderr=subprocess.STDOUT,
        stdout=subprocess.PIPE if quiet else None,
    )
    if quiet and proc.returncode != 0:
        print((proc.stdout or b'').decode('utf-8', 'replace'))
        raise subprocess.CalledProcessError(proc.returncode, proc.args)
    # Mirror the `just run` recipe: keep the served stylesheet in lockstep.
    style_src = os.path.join(ROOT, 'static', 'style.css')
    if os.path.isfile(style_src):
        shutil.copy(style_src, os.path.join(PUBLIC, 'style.css'))


def notify_reload():
    """Wake every connected SSE client so its page reloads."""
    with _reload_lock:
        clients = list(_reload_clients)
    for q in clients:
        q.put('reload')


def _snapshot():
    """Map every watched path to its mtime, for change detection."""
    state = {}
    for d in WATCH_DIRS:
        for root, _dirs, files in os.walk(d):
            for fn in files:
                p = os.path.join(root, fn)
                try:
                    state[p] = os.stat(p).st_mtime_ns
                except OSError:
                    pass
    for p in WATCH_FILES:
        try:
            state[p] = os.stat(p).st_mtime_ns
        except OSError:
            pass
    return state


def watch_loop():
    """Poll the watched trees; on change, settle briefly (so half-written saves
    don't trigger a build mid-write), rebuild, and signal a reload."""
    prev = _snapshot()
    while True:
        time.sleep(0.3)
        cur = _snapshot()
        if cur == prev:
            continue
        # Let a burst of writes settle before building.
        while True:
            time.sleep(0.3)
            newer = _snapshot()
            if newer == cur:
                break
            cur = newer
        changed = {p for p in set(cur) | set(prev)
                   if cur.get(p) != prev.get(p)}
        prev = cur
        force = NAV in changed
        try:
            build(force=force)
        except subprocess.CalledProcessError as e:
            print('build failed: ' + str(e))
            continue
        notify_reload()

# Scaffold text for a brand-new page. {{TITLE}}, {{DATE}} and {{TAGS}} are
# substituted via str.replace (not .format) so the literal LaTeX braces below
# pass through untouched. {{TAGS}} expands to a whole "#+TAGS: …\n" line, or to
# nothing when the page is created untagged — so untagged pages keep a clean
# header and `just tag-page` inserts the line later if it's ever needed.
GENERIC_ORG = r"""#+TITLE: {{TITLE}}
#+AUTHOR: Ben Heinze
#+DATE: {{DATE}}
{{TAGS}}#+STARTUP: noindent

#+MACRO: hl @@html:<span class="hl-$1">$2</span>@@@@latex:\hl{$1}{$2}@@

# This is used to shrink the pdf page margins
#+LATEX_HEADER: \usepackage[left=0.75in,right=0.75in,top=1in,bottom=1in]{geometry}

# This is used to shrink the spacing between bullet points
#+LATEX_HEADER: \usepackage{enumitem}
#+LATEX_HEADER: \setlist[itemize]{itemsep=2pt, topsep=4pt}
"""


def slugify(label):
    slug = re.sub(r'[^a-z0-9]+', '-', label.strip().lower()).strip('-')
    return slug


# ── Page tags ───────────────────────────────────────────────────────────
# A page declares the subjects it touches with a page-level Org keyword:
#
#     #+TAGS: machine-learning, week-5, entropy
#
# nav.json is a strict tree, so two pages on the same subject in different
# sections have nothing linking them; tags are the cross-cutting second axis.
# publish.el reads the same keyword to render the chips under each page title,
# to write public/tag-index.json for the /tags/ browse page, and to power the
# `tag:` filter in site search.
#
# Everything here is plain Python over content/ — no Emacs — so `just list-tags`
# is instant and works on a cold checkout with nothing built yet.

TAGS_RE = re.compile(r'(?im)^#\+TAGS:.*$')

# A new #+TAGS: line is inserted after whichever of these the page already has,
# so it lands with the rest of the frontmatter. Tried in this order — #+DATE: is
# normally the last header line, and #+TITLE: is the fallback and by far the
# common case: plenty of pages (content/algorithms/fibonacci.org,
# content/search/index.org) carry no #+DATE: or #+AUTHOR: at all.
TAG_ANCHORS = ('DATE', 'AUTHOR', 'TITLE')


def normalize_tag(tag):
    """Canonical slug for a tag.

    Deliberately `slugify`, the same normalizer page titles use, and mirrored
    character-for-character by `wiki-normalize-tag' in publish.el. If those two
    ever drift, a chip's #<tag> fragment stops matching the key static/tags.js
    builds from tag-index.json, and the two sides disagree about what counts as
    the same tag.
    """
    return slugify(tag)


def split_tags(text):
    """Parse a '#+TAGS:' value into normalized tags. Deduped, sorted, empties
    dropped.

    Commas are the only separator: a tag may contain spaces, which `slugify`
    turns into hyphens, so "Machine Learning" is one tag and not two. Callers
    with tags already split into a list (the CLI, where argv did the splitting)
    join them with commas rather than spaces for the same reason.
    """
    out = []
    for raw in (text or '').split(','):
        tag = normalize_tag(raw)
        if tag and tag not in out:
            out.append(tag)
    return sorted(out)


def resolve_org(path):
    """Map a content/ path to its .org source file.

    Pages come in two shapes: a directory holding an index.org (the 63 pages in
    nav.json), and a standalone .org beside its parent's index.org that is
    #+INCLUDEd but also publishes as its own page (fibonacci.org and ~40
    others). Both are taggable, so both resolve here. Accepts a path with or
    without a trailing '.org'.
    """
    rel = (path or '').strip('/')
    if not rel:
        raise ValueError('a page path is required')
    if rel.endswith('.org'):
        candidates = [rel]
    else:
        candidates = [os.path.join(rel, 'index.org'), rel + '.org']
    for cand in candidates:
        full = os.path.join(ROOT, 'content', cand)
        if os.path.isfile(full):
            return full
    raise ValueError('no page at content/' + candidates[0] +
                     (' (or content/' + candidates[-1] + ')'
                      if len(candidates) > 1 else ''))


def _frontmatter_end(body):
    """Index of the end of BODY's leading keyword block (its first heading, or
    the end of the file). Tags are only ever read from or written into this
    region, so a '#+TAGS:' shown as an example further down a page — as
    content/org-cheatsheet/index.org might — is never mistaken for a
    declaration. Mirrors the same guard in `wiki-page-frontmatter'."""
    m = re.search(r'(?m)^\*+[ \t]', body)
    return m.start() if m else len(body)


def read_tags(org_path):
    """The normalized tags declared by the .org file at ORG_PATH."""
    with open(org_path) as f:
        body = f.read()
    head = body[:_frontmatter_end(body)]
    m = TAGS_RE.search(head)
    if not m:
        return []
    return split_tags(m.group(0).split(':', 1)[1])


def write_tags(org_path, tags):
    """Set the .org file at ORG_PATH to declare exactly TAGS.

    Rewrites an existing '#+TAGS:' line in place; inserts one after the last
    TAG_ANCHORS keyword when there is none; removes the line entirely when TAGS
    is empty, so an untagged page is byte-identical to one that never had tags.

    Sorts here rather than trusting callers, so the line on disk is always in one
    canonical order and re-tagging a page never produces a spurious diff.
    """
    tags = sorted(set(tags))
    with open(org_path) as f:
        body = f.read()
    end = _frontmatter_end(body)
    head, rest = body[:end], body[end:]

    line = '#+TAGS: ' + ', '.join(tags)
    # A lambda, not a replacement string, in every sub() below: tag text
    # containing \1 or \g would otherwise be read as a backreference. Same
    # reason rename_tab uses one for #+TITLE:.
    if TAGS_RE.search(head):
        if tags:
            head = TAGS_RE.sub(lambda m: line, head, count=1)
        else:
            # Drop the line and its newline, so removing the last tag leaves the
            # file exactly as it was before any tag was added.
            head = re.sub(r'(?im)^#\+TAGS:.*$\n?', lambda m: '', head, count=1)
    elif tags:
        at = None
        for key in TAG_ANCHORS:
            m = re.search(r'(?im)^#\+' + key + r':.*$', head)
            if m:
                at = m.end()
                break
        if at is None:
            head = line + '\n' + head   # no frontmatter at all: go to the top
        else:
            head = head[:at] + '\n' + line + head[at:]

    with open(org_path, 'w') as f:
        f.write(head + rest)


def content_pages():
    """Every taggable .org file under content/, as (rel_path, abs_path) pairs.

    Dotfiles are skipped: an org buffer open in Emacs leaves a dangling
    .#name.org lock symlink beside it.
    """
    base = os.path.join(ROOT, 'content')
    out = []
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.'))
        for fn in sorted(files):
            if fn.endswith('.org') and not fn.startswith('.'):
                full = os.path.join(root, fn)
                out.append((os.path.relpath(full, base), full))
    return out


def collect_tags():
    """Map every tag in the wiki to the rel paths of the pages carrying it."""
    index = {}
    for rel, full in content_pages():
        for tag in read_tags(full):
            index.setdefault(tag, []).append(rel)
    return index


def page_label(rel):
    """A page's content/ path as the CLI addresses it: 'ai/index.org' -> 'ai',
    'algorithms/fibonacci.org' -> 'algorithms/fibonacci'. The inverse of
    resolve_org, for printing."""
    if rel.endswith('/index.org'):
        return rel[:-len('/index.org')]
    if rel == 'index.org':
        return ''
    return rel[:-len('.org')]


def series_siblings(a, b):
    """True when two tags read as members of a numbered series rather than a typo
    of one another.

    Numbered tags are the one place where two nearly identical names are both
    correct and deliberate — a wiki full of "5 Tree Learning" and "8 Virtual
    Memory" will grow week-4 alongside week-5, and stopping to confirm every one
    of those would be pure friction. The distinction is which part differs:

        week-4  vs week-5   same letters, different number -> a series
        week5   vs week-5   same letters, same number      -> a typo
    """
    letters = lambda s: re.sub(r'[^a-z]', '', s)
    digits = lambda s: re.sub(r'[^0-9]', '', s)
    return (letters(a) == letters(b)
            and bool(digits(a)) and bool(digits(b))
            and digits(a) != digits(b))


def check_new_tags(tags, known, allow_new):
    """Vet tags that no page carries yet. Returns True when it is safe to apply.

    Typos are what quietly degrade a tag graph: "week5" and "week-5" become two
    unrelated subjects, and the pages you meant to link stay unlinked. But most
    new tags are not typos — they are new subjects — and a wiki has to be able to
    grow its vocabulary without ceremony.

    So the two cases are treated differently. A new tag that closely resembles an
    existing one is the typo case: it stops and asks, since the near miss is
    almost certainly what you meant. A new tag that resembles nothing is just a
    new subject: it is noted and applied. --new forces the first case through.
    """
    import difflib

    fresh = [t for t in tags if t not in known]
    if not fresh:
        return True

    blocked = []
    for tag in fresh:
        near = difflib.get_close_matches(tag, sorted(known), n=1, cutoff=0.75)
        if near and series_siblings(tag, near[0]):
            near = []          # a numbered sibling, not a typo — see above
        if near and not allow_new:
            blocked.append((tag, near[0]))
        else:
            print('  note: "%s" is new to the wiki' % tag)

    for tag, near in blocked:
        print('  "%s" looks like "%s" (%d page%s) — nothing changed.'
              % (tag, near, len(known[near]), '' if len(known[near]) == 1 else 's'))
    if blocked:
        print('  Use the existing tag, or re-run with --new to keep %s separate.'
              % ('them' if len(blocked) > 1 else 'it'))
        return False
    return True


def rebuild_for_tags():
    """Rebuild after a tag edit, unless the dev server is already going to.

    A tag edit touches a file under content/, which serve.py's own watcher is
    polling — so under `just run` it rebuilds within about a second. Building
    here too would put two Emacs processes through the read-modify-write passes
    (wiki-inject-toc, wiki-inject-quiz-test, wiki-inject-tags) over the same
    public/**.html at once, and one would clobber the other's injection. It
    self-heals on the next build, but it is visible.

    Incremental, not forced: only the edited page's HTML changes, and the
    :completion-function passes that regenerate tag-index.json and
    search-index.json run on every publish regardless of how many files were
    re-exported.
    """
    pid_file = os.path.join(ROOT, '.server.pid')
    try:
        with open(pid_file) as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
    except (OSError, ValueError):
        pass
    else:
        return 'dev server is running — it will rebuild'
    build(force=False, quiet=True)
    return 'rebuilt'


def tag_page(path, args):
    """Add tags to a page. Pass --new to accept a tag no other page uses yet."""
    allow_new = '--new' in args
    tags = split_tags(','.join(a for a in args if not a.startswith('--')))
    if not tags:
        raise ValueError('at least one tag is required')

    org = resolve_org(path)
    known = collect_tags()
    rel = os.path.relpath(org, os.path.join(ROOT, 'content'))
    print('content/' + rel)
    if not check_new_tags(tags, known, allow_new):
        return {'ok': False, 'reason': 'unvetted new tags'}

    before = read_tags(org)
    after = sorted(set(before) | set(tags))
    added = [t for t in after if t not in before]
    write_tags(org, after)

    print('  ' + ('+ ' + '  + '.join(added) if added else '(no change)'))
    print('  now: ' + (', '.join(after) or '(none)'))
    if added:
        print('  ' + rebuild_for_tags())
    return {'ok': True, 'path': rel, 'tags': after}


def untag_page(path, args):
    """Remove tags from a page."""
    tags = split_tags(','.join(a for a in args if not a.startswith('--')))
    if not tags:
        raise ValueError('at least one tag is required')

    org = resolve_org(path)
    before = read_tags(org)
    after = [t for t in before if t not in tags]
    removed = [t for t in before if t in tags]
    missing = [t for t in tags if t not in before]
    write_tags(org, after)

    rel = os.path.relpath(org, os.path.join(ROOT, 'content'))
    print('content/' + rel)
    if removed:
        print('  - ' + '  - '.join(removed))
    for tag in missing:
        print('  note: "%s" was not on this page' % tag)
    print('  now: ' + (', '.join(after) or '(none)'))
    if removed:
        print('  ' + rebuild_for_tags())
    return {'ok': True, 'path': rel, 'tags': after}


def list_tags(args):
    """Print the wiki's tag vocabulary, one page's tags, or what is untagged."""
    if '--untagged' in args:
        untagged = [page_label(rel) for rel, full in content_pages()
                    if not read_tags(full)]
        for label in untagged:
            print(label or '(home)')
        print('\n%d untagged page%s' % (len(untagged), '' if len(untagged) == 1 else 's'))
        return {'ok': True, 'untagged': untagged}

    path = next((a for a in args if not a.startswith('--')), None)
    if path:
        org = resolve_org(path)
        tags = read_tags(org)
        print(', '.join(tags) if tags else '(no tags)')
        return {'ok': True, 'tags': tags}

    index = collect_tags()
    if not index:
        print('No pages are tagged yet.')
        print('Add some with: just tag-page <path> <tag>...')
        return {'ok': True, 'tags': {}}
    # Most-used first, then alphabetical — same order the /tags/ page uses.
    width = max(len(t) for t in index)
    for tag in sorted(index, key=lambda t: (-len(index[t]), t)):
        print('%-*s  %d' % (width, tag, len(index[tag])))
    print('\n%d tags across %d pages'
          % (len(index), len({p for ps in index.values() for p in ps})))
    return {'ok': True, 'tags': {t: len(p) for t, p in index.items()}}


def path_to_href(path):
    """Turn a content/ path like 'ai/machine-learning' into a nav href.

    Empty means top level. Mirrors how nav hrefs are stored (see nav.json).
    """
    path = (path or '').strip('/')
    return '/' + path + '/index.html' if path else ''


def find_entry(nav, href):
    for entry in nav:
        if entry.get('href') == href:
            return entry
        found = find_entry(entry.get('children', []), href)
        if found:
            return found
    return None


def remove_entry(nav, href):
    """Remove the entry with this href from nav (searching nested children).

    Returns the removed entry (with its own children subtree intact), or None
    if no entry matched.
    """
    for i, entry in enumerate(nav):
        if entry.get('href') == href:
            return nav.pop(i)
        children = entry.get('children', [])
        removed = remove_entry(children, href)
        if removed is not None:
            if not children:  # don't leave an empty "children": [] behind
                entry.pop('children', None)
            return removed
    return None


def page_visibility_tab(href, visibility):
    """Set whether the page at HREF is published to the live website.

    visibility is 'private' (kept out of the deployed site, still shown under
    `just run`) or 'public' (published). Flips the "private" flag on the nav
    entry and rebuilds, since the nav is baked into every page.
    """
    if visibility not in ('public', 'private'):
        raise ValueError("visibility must be 'public' or 'private'")

    with open(NAV) as f:
        nav = json.load(f)

    entry = find_entry(nav, href)
    if entry is None:
        raise ValueError('page not found: ' + href)

    if visibility == 'private':
        entry['private'] = True
    else:
        entry.pop('private', None)

    with open(NAV, 'w') as f:
        json.dump(nav, f, indent=2)
        f.write('\n')

    # Full rebuild: private-ness affects both HTML emission and the nav/TOC
    # baked into every page, so all pages must be regenerated.
    subprocess.run(
        ['emacs', '--batch', '-l', 'publish.el', '--eval', '(org-publish-all t)'],
        cwd=ROOT, check=True,
    )
    return {'ok': True, 'href': href, 'visibility': visibility}


def create_tab(label, parent_href, tags=''):
    label = (label or '').strip()
    if not label:
        raise ValueError('a name is required')
    slug = slugify(label)
    if not slug:
        raise ValueError('name has no usable characters')

    with open(NAV) as f:
        nav = json.load(f)

    if parent_href:
        parent = find_entry(nav, parent_href)
        if parent is None:
            raise ValueError('parent tab not found: ' + parent_href)
        parent_dir = parent_href.strip('/').rsplit('/', 1)[0]  # ".../index.html" -> dir
        rel_dir = os.path.join(parent_dir, slug)
    else:
        parent = None
        rel_dir = slug

    href = '/' + rel_dir + '/index.html'
    abs_dir = os.path.join(ROOT, 'content', rel_dir)
    if os.path.exists(abs_dir):
        raise ValueError('already exists: content/' + rel_dir)

    os.makedirs(abs_dir)
    with open(os.path.join(abs_dir, 'index.org'), 'w') as f:
        today = datetime.date.today().isoformat()
        page_tags = split_tags(tags)
        tags_line = '#+TAGS: ' + ', '.join(page_tags) + '\n' if page_tags else ''
        f.write(GENERIC_ORG
                .replace('{{TITLE}}', label)
                .replace('{{DATE}}', today)
                .replace('{{TAGS}}', tags_line))

    entry = {'label': label, 'href': href}
    if parent is not None:
        parent.setdefault('children', []).append(entry)
    else:
        nav.append(entry)
    with open(NAV, 'w') as f:
        json.dump(nav, f, indent=2)
        f.write('\n')

    # Full rebuild: the nav is baked into every page, so all pages must be
    # regenerated for the new tab to show up site-wide.
    subprocess.run(
        ['emacs', '--batch', '-l', 'publish.el', '--eval', '(org-publish-all t)'],
        cwd=ROOT, check=True,
    )
    return {'ok': True, 'href': href}


def delete_tab(href):
    """Inverse of create_tab: drop the nav entry and remove its content.

    Removing a page also removes any pages nested under it, since their content
    lives inside its directory and their nav entries hang off its subtree.
    """
    href = (href or '').strip()
    if not href:
        raise ValueError('a page path is required')

    rel_dir = href.strip('/').rsplit('/', 1)[0]  # ".../index.html" -> dir
    if not rel_dir:
        raise ValueError('refusing to delete the site root')

    with open(NAV) as f:
        nav = json.load(f)

    removed = remove_entry(nav, href)
    if removed is None:
        raise ValueError('page not found in nav: ' + href)

    with open(NAV, 'w') as f:
        json.dump(nav, f, indent=2)
        f.write('\n')

    # Delete the source and the already-published output. org-publish-all does
    # not prune stale files, so the built copy under public/ must go explicitly
    # or the deleted page would linger on the served site.
    for base in (os.path.join(ROOT, 'content', rel_dir), os.path.join(PUBLIC, rel_dir)):
        if os.path.isdir(base):
            shutil.rmtree(base)

    # Full rebuild so the removed tab disappears from the nav baked into every
    # remaining page.
    subprocess.run(
        ['emacs', '--batch', '-l', 'publish.el', '--eval', '(org-publish-all t)'],
        cwd=ROOT, check=True,
    )
    return {'ok': True, 'href': href, 'removed': removed.get('label')}


def move_tab(from_href, to_parent_href):
    """Relocate a nav entry (and its content dir + subtree) under a new parent.

    Inverse-compatible with create_tab/delete_tab: same nav.json + content/ +
    public/ manipulation, then a full rebuild. from_href is the page being
    moved; to_parent_href is its new parent (empty string for top level).
    """
    from_href = (from_href or '').strip()
    if not from_href:
        raise ValueError('a page path is required')

    old_dir = from_href.strip('/').rsplit('/', 1)[0]  # ".../index.html" -> dir
    if not old_dir:
        raise ValueError('refusing to move the site root')

    to_parent_href = (to_parent_href or '').strip()
    if to_parent_href == from_href:
        raise ValueError('cannot move a page into itself')
    if to_parent_href:
        parent_dir_check = to_parent_href.strip('/').rsplit('/', 1)[0]
        if parent_dir_check == old_dir or parent_dir_check.startswith(old_dir + '/'):
            raise ValueError('cannot move a page into its own subtree')

    with open(NAV) as f:
        nav = json.load(f)

    # Pull the entry (with its children subtree intact) out of its old spot
    # first. If to_parent_href names a descendant of the moved entry, it will
    # no longer be findable below, which naturally rejects that cycle too.
    entry = remove_entry(nav, from_href)
    if entry is None:
        raise ValueError('page not found in nav: ' + from_href)

    if to_parent_href:
        parent = find_entry(nav, to_parent_href)
        if parent is None:
            raise ValueError('parent tab not found: ' + to_parent_href)
        new_parent_dir = to_parent_href.strip('/').rsplit('/', 1)[0]
    else:
        parent = None
        new_parent_dir = ''

    slug = old_dir.rsplit('/', 1)[-1]
    new_dir = os.path.join(new_parent_dir, slug)
    if new_dir == old_dir:
        raise ValueError('page is already there')

    abs_old = os.path.join(ROOT, 'content', old_dir)
    abs_new = os.path.join(ROOT, 'content', new_dir)
    if not os.path.isdir(abs_old):
        raise ValueError('content not found: content/' + old_dir)
    if os.path.exists(abs_new):
        raise ValueError('already exists: content/' + new_dir)

    shutil.move(abs_old, abs_new)

    # org-publish-all does not prune stale files, so the old built output must
    # go explicitly or the page would linger at its old URL too.
    stale_public = os.path.join(PUBLIC, old_dir)
    if os.path.isdir(stale_public):
        shutil.rmtree(stale_public)

    def rewrite_hrefs(node):
        old_prefix, new_prefix = '/' + old_dir + '/', '/' + new_dir + '/'
        node['href'] = new_prefix + node['href'][len(old_prefix):]
        for child in node.get('children', []):
            rewrite_hrefs(child)

    rewrite_hrefs(entry)

    if parent is not None:
        parent.setdefault('children', []).append(entry)
    else:
        nav.append(entry)
    with open(NAV, 'w') as f:
        json.dump(nav, f, indent=2)
        f.write('\n')

    # Full rebuild: descendant pages' internal nav links and the site-wide
    # preamble all need to reflect the new location.
    subprocess.run(
        ['emacs', '--batch', '-l', 'publish.el', '--eval', '(org-publish-all t)'],
        cwd=ROOT, check=True,
    )
    return {'ok': True, 'from': from_href, 'to': entry['href']}


def rename_tab(from_href, new_label):
    """Rename a page: change its title, nav label, URL slug, and content dir.

    Keeps the page under the same parent (use move_tab to change parent). The
    slug/dir is re-derived from new_label, so the page's URL changes and any
    pages nested under it move with it. Mirrors move_tab's nav.json + content/
    + public/ manipulation, plus rewriting the #+TITLE: in the index.org and a
    full rebuild.
    """
    from_href = (from_href or '').strip()
    if not from_href:
        raise ValueError('a page path is required')

    new_label = (new_label or '').strip()
    if not new_label:
        raise ValueError('a new name is required')
    new_slug = slugify(new_label)
    if not new_slug:
        raise ValueError('name has no usable characters')

    old_dir = from_href.strip('/').rsplit('/', 1)[0]  # ".../index.html" -> dir
    if not old_dir:
        raise ValueError('refusing to rename the site root')

    parent_dir = old_dir.rsplit('/', 1)[0] if '/' in old_dir else ''
    new_dir = os.path.join(parent_dir, new_slug)

    with open(NAV) as f:
        nav = json.load(f)

    entry = find_entry(nav, from_href)
    if entry is None:
        raise ValueError('page not found in nav: ' + from_href)

    abs_old = os.path.join(ROOT, 'content', old_dir)
    if not os.path.isdir(abs_old):
        raise ValueError('content not found: content/' + old_dir)

    # The slug may be unchanged (e.g. renaming "Likelihood" to "Likelihood!"),
    # in which case only the label + title change and no dir move happens.
    if new_dir != old_dir:
        abs_new = os.path.join(ROOT, 'content', new_dir)
        if os.path.exists(abs_new):
            raise ValueError('already exists: content/' + new_dir)
        shutil.move(abs_old, abs_new)

        # org-publish-all does not prune stale files, so the old built output
        # must go explicitly or the page would linger at its old URL too.
        stale_public = os.path.join(PUBLIC, old_dir)
        if os.path.isdir(stale_public):
            shutil.rmtree(stale_public)

        def rewrite_hrefs(node):
            old_prefix, new_prefix = '/' + old_dir + '/', '/' + new_dir + '/'
            node['href'] = new_prefix + node['href'][len(old_prefix):]
            for child in node.get('children', []):
                rewrite_hrefs(child)

        rewrite_hrefs(entry)

    entry['label'] = new_label

    with open(NAV, 'w') as f:
        json.dump(nav, f, indent=2)
        f.write('\n')

    # Update the page's own title so it matches the nav label. The #+TITLE:
    # keyword drives the rendered heading and the <title> element.
    index_org = os.path.join(ROOT, 'content', new_dir, 'index.org')
    if os.path.isfile(index_org):
        with open(index_org) as f:
            body = f.read()
        body, n = re.subn(
            r'(?im)^#\+TITLE:.*$', lambda m: '#+TITLE: ' + new_label,
            body, count=1,
        )
        if n:
            with open(index_org, 'w') as f:
                f.write(body)

    # Full rebuild: the changed slug/label ripples into the nav baked into
    # every page and into descendant pages' internal links.
    subprocess.run(
        ['emacs', '--batch', '-l', 'publish.el', '--eval', '(org-publish-all t)'],
        cwd=ROOT, check=True,
    )
    return {'ok': True, 'from': from_href, 'to': entry['href'], 'label': new_label}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        if self.path == '/__reload':
            return self._serve_reload_stream()
        if self.path.split('?')[0] == '/api/ratings':
            return self._send_json(200, read_ratings())
        fs_path = self.translate_path(self.path)
        if os.path.isdir(fs_path):
            if not self.path.rstrip('?').endswith('/'):
                self.send_response(301)
                self.send_header('Location', self.path + '/')
                self.end_headers()
                return
            fs_path = os.path.join(fs_path, 'index.html')
        if fs_path.endswith('.html') and os.path.isfile(fs_path):
            return self._serve_html(fs_path)
        return super().do_GET()

    def do_POST(self):
        if self.path.split('?')[0] != '/api/rating':
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
            entry = json.loads(self.rfile.read(length) or b'{}')
            saved = write_rating(entry)
        except Exception as e:
            return self._send_json(400, {'ok': False, 'error': str(e)})
        return self._send_json(200, {'ok': True, 'record': saved})

    def _send_json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_html(self, fs_path):
        """Serve an HTML file with the live-reload client injected before </body>."""
        with open(fs_path, 'rb') as f:
            body = f.read()
        if b'</body>' in body:
            body = body.replace(b'</body>', RELOAD_SCRIPT + b'</body>', 1)
        else:
            body += RELOAD_SCRIPT
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_reload_stream(self):
        """Hold an SSE connection open, emitting a reload event on each build."""
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        q = queue.Queue()
        with _reload_lock:
            _reload_clients.add(q)
        try:
            self.wfile.write(b': connected\n\n')
            self.wfile.flush()
            while True:
                try:
                    q.get(timeout=15)
                    self.wfile.write(b'data: reload\n\n')
                except queue.Empty:
                    self.wfile.write(b': ping\n\n')  # keepalive + detect disconnect
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with _reload_lock:
                _reload_clients.discard(q)

    def log_message(self, *a):
        pass


def main():
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == 'new-page':
        # Scaffolds the page, updates nav.json, and rebuilds the site. The
        # optional third arg is a comma/space separated tag list.
        label = sys.argv[2] if len(sys.argv) > 2 else ''
        parent = sys.argv[3] if len(sys.argv) > 3 else ''
        tags = sys.argv[4] if len(sys.argv) > 4 else ''
        try:
            result = create_tab(label, path_to_href(parent), tags)
        except Exception as e:
            print('error: ' + str(e), file=sys.stderr)
            sys.exit(1)
        print('created ' + result['href'])
        return

    if len(sys.argv) > 1 and sys.argv[1] in ('tag-page', 'untag-page'):
        # Add or remove a page's #+TAGS:. Takes a content/ path — either a page
        # directory ("ai/machine-learning") or a standalone snippet page
        # ("algorithms/fibonacci") — then one or more tags. tag-page warns about
        # a tag no other page uses yet; --new applies it anyway.
        path = sys.argv[2] if len(sys.argv) > 2 else ''
        rest = sys.argv[3:]
        fn = tag_page if sys.argv[1] == 'tag-page' else untag_page
        try:
            result = fn(path, rest)
        except Exception as e:
            print('error: ' + str(e), file=sys.stderr)
            sys.exit(1)
        if not result.get('ok'):
            sys.exit(1)
        return

    if len(sys.argv) > 1 and sys.argv[1] == 'merge-ratings':
        # Fold a browser "Export ratings" download into question-ratings.json.
        if len(sys.argv) < 3:
            print('error: merge-ratings needs a path to the exported JSON', file=sys.stderr)
            sys.exit(1)
        try:
            merge_ratings(sys.argv[2])
        except Exception as e:
            print('error: ' + str(e), file=sys.stderr)
            sys.exit(1)
        return

    if len(sys.argv) > 1 and sys.argv[1] == 'list-tags':
        # No args: the whole tag vocabulary with page counts. A content/ path:
        # just that page's tags. --untagged: every page with no tags yet.
        try:
            list_tags(sys.argv[2:])
        except Exception as e:
            print('error: ' + str(e), file=sys.stderr)
            sys.exit(1)
        return

    if len(sys.argv) > 1 and sys.argv[1] == 'delete-page':
        # Inverse of new-page: takes the same content/ path (e.g.
        # "ai/machine-learning") and removes the tab, its content, and its
        # built output, then rebuilds.
        path = sys.argv[2] if len(sys.argv) > 2 else ''
        try:
            result = delete_tab(path_to_href(path))
        except Exception as e:
            print('error: ' + str(e), file=sys.stderr)
            sys.exit(1)
        print('deleted ' + result['href'])
        return

    if len(sys.argv) > 1 and sys.argv[1] == 'move-page':
        # Relocate a page (and any pages nested under it) to a new parent.
        # Both args are content/ paths; omit the parent to move to top level.
        path = sys.argv[2] if len(sys.argv) > 2 else ''
        parent = sys.argv[3] if len(sys.argv) > 3 else ''
        try:
            result = move_tab(path_to_href(path), path_to_href(parent))
        except Exception as e:
            print('error: ' + str(e), file=sys.stderr)
            sys.exit(1)
        print('moved ' + result['from'] + ' -> ' + result['to'])
        return

    if len(sys.argv) > 1 and sys.argv[1] == 'rename-page':
        # Rename a page: takes its content/ path (e.g. "statistics/likelihood")
        # and a new title. Re-derives the slug/dir + href from the title and
        # updates the page's own #+TITLE:, keeping it under the same parent.
        path = sys.argv[2] if len(sys.argv) > 2 else ''
        new_label = sys.argv[3] if len(sys.argv) > 3 else ''
        try:
            result = rename_tab(path_to_href(path), new_label)
        except Exception as e:
            print('error: ' + str(e), file=sys.stderr)
            sys.exit(1)
        print('renamed ' + result['from'] + ' -> ' + result['to'])
        return

    if len(sys.argv) > 1 and sys.argv[1] == 'page-visibility':
        # Set whether a page is published to the live website. Takes its
        # content/ path (e.g. "job") and either "private" (kept local-only) or
        # "public", flips the flag on the nav entry, and rebuilds.
        path = sys.argv[2] if len(sys.argv) > 2 else ''
        visibility = sys.argv[3] if len(sys.argv) > 3 else ''
        try:
            result = page_visibility_tab(path_to_href(path), visibility)
        except Exception as e:
            print('error: ' + str(e), file=sys.stderr)
            sys.exit(1)
        print(result['href'] + ' is now ' + result['visibility'])
        return

    os.chdir(ROOT)
    threading.Thread(target=watch_loop, daemon=True).start()
    print('Serving http://localhost:8080  (Ctrl-C to stop)  [watching for changes]')
    # ThreadingHTTPServer so a held-open SSE reload stream doesn't block the
    # server from handling normal page requests.
    http.server.ThreadingHTTPServer(('localhost', 8080), Handler).serve_forever()


if __name__ == '__main__':
    main()
